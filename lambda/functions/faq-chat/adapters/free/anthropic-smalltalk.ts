import Anthropic from '@anthropic-ai/sdk';
import type {
  FaqGenerationRequest,
  FaqSmalltalkGenerationPort,
} from '../../ports/generation.js';
import type { AnthropicGenerationOptions } from './anthropic-generation.js';

export type AnthropicSmalltalkOptions = AnthropicGenerationOptions;

const DEFAULT_TIMEOUT_MS = 20_000;

function buildRequest(
  request: FaqGenerationRequest,
  jsonSchema?: Record<string, unknown>
): Anthropic.MessageCreateParamsNonStreaming {
  const baseRequest: Anthropic.MessageCreateParamsNonStreaming = {
    model: request.model,
    max_tokens: request.maxTokens,
    system: request.system,
    messages: request.messages,
    ...(typeof request.temperature === 'number' ? { temperature: request.temperature } : {}),
  };
  if (jsonSchema === undefined) return baseRequest;

  // SDK 0.104.1 does not expose output_config in its types yet, but the Messages API
  // accepts this shape. Keep it local to the smalltalk port so the answer port can
  // continue to declare supportsStructuredOutput=false accurately.
  return {
    ...baseRequest,
    ...({ output_config: { format: { type: 'json_schema', schema: jsonSchema } } } as unknown as
      Partial<Anthropic.MessageCreateParamsNonStreaming>),
  };
}

function notify(callback: (() => void) | undefined): void;
function notify<T>(callback: ((value: T) => void) | undefined, value: T): void;
function notify<T>(callback: ((value?: T) => void) | undefined, value?: T): void {
  try {
    callback?.(value);
  } catch {
    // Observation callbacks must not turn a provider result into an API failure.
  }
}

/** Anthropic-backed generated-smalltalk port. All provider failures fail closed to null. */
export function createAnthropicSmalltalkPort({
  apiKey,
  client,
}: AnthropicSmalltalkOptions): FaqSmalltalkGenerationPort {
  const anthropic = client ?? new Anthropic({ apiKey });

  return {
    supportsStructuredOutput: true,
    async complete(request) {
      // timeout は attempt 単位。schema 400 の互換再試行時は実時間が合算で最大2倍になり得る
      // （production 側 createClaudeFaqCaller と同挙動。handler 側は Promise.race で締め切る）。
      const requestOptions = {
        timeout: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxRetries: 0,
      } as const;
      const baseRequest = buildRequest(request);

      try {
        let response: Anthropic.Message;
        try {
          response = await anthropic.messages.create(
            request.jsonSchema === undefined
              ? baseRequest
              : buildRequest(request, request.jsonSchema),
            requestOptions
          );
        } catch (error) {
          // Match the production caller: only a schema-related provider 400 gets one
          // compatibility retry without output_config. All other failures return null.
          if (
            request.jsonSchema === undefined ||
            !(error instanceof Anthropic.APIError) ||
            error.status !== 400
          ) {
            throw error;
          }
          console.error(
            `[faq-chat/free] Anthropic smalltalk structured output rejected ` +
              `(model=${request.model}): ${error.message} — retrying once without json schema`
          );
          notify(request.onStructuredOutputFallback);
          response = await anthropic.messages.create(baseRequest, requestOptions);
        }

        notify(request.onStopReason, response.stop_reason);
        if (response.stop_reason !== 'end_turn') return null;

        const text = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('');
        if (!text) return null;

        return {
          text,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          stopReason: response.stop_reason,
        };
      } catch (error) {
        console.error(
          `[faq-chat/free] Anthropic smalltalk failed: ${(error as Error)?.message ?? error}`
        );
        return null;
      }
    },
  };
}
