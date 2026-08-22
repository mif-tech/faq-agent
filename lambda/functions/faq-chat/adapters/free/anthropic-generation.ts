import Anthropic from '@anthropic-ai/sdk';
import type { FaqAnswerGenerationPort } from '../../ports/generation.js';

export interface AnthropicGenerationOptions {
  apiKey: string;
  client?: Pick<Anthropic, 'messages'>;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export function createAnthropicGenerationPort({
  apiKey,
  client,
}: AnthropicGenerationOptions): FaqAnswerGenerationPort {
  const anthropic = client ?? new Anthropic({ apiKey });

  return {
    // jsonSchema はプロバイダ非依存の最小契約として使わない（JSON はプロンプトで要求）
    supportsStructuredOutput: false,
    async generate(request) {
      try {
        const response = await anthropic.messages.create(
          {
            model: request.model,
            max_tokens: request.maxTokens,
            system: request.system,
            messages: request.messages,
          },
          { timeout: request.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxRetries: 0 }
        );
        try {
          request.onStopReason?.(response.stop_reason);
        } catch {
          // Observation callbacks must not turn a provider result into an API failure.
        }
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
        console.error(`[faq-chat/free] Anthropic generation failed: ${(error as Error)?.message ?? error}`);
        return null;
      }
    },
  };
}
