import type { FaqPorts } from '../../ports/index.js';
import type { AnthropicGenerationOptions } from './anthropic-generation.js';
import { createAnthropicGenerationPort } from './anthropic-generation.js';
import { dynamoDbFaqKbSource } from './dynamodb-entries.js';
import { createGroundedDemoGenerationPort } from './grounded-demo-generation.js';
import { buildSimpleAnswerSystemPrompt } from './simple-answer-prompt.js';
import { createSimpleRetrievalPort } from './simple-retrieval.js';
import type { FaqKbSourcePort } from '../../ports/storage.js';

export interface FreeFaqPortsOptions {
  kbSource?: FaqKbSourcePort;
  topK?: number;
  maxCharsPerEntry?: number;
  cacheTtlMs?: number;
  /** Undefined reads ANTHROPIC_API_KEY; null/empty explicitly selects grounded demo mode. */
  apiKey?: string | null;
  client?: AnthropicGenerationOptions['client'];
}

const DEFAULT_FREE_MODEL = 'claude-haiku-4-5-20251001';

export function createFreeFaqPorts(
  options: FreeFaqPortsOptions = {}
): Omit<FaqPorts, 'storage'> {
  const apiKey =
    options.apiKey === undefined ? process.env.ANTHROPIC_API_KEY : (options.apiKey ?? undefined);

  return {
    retrieval: createSimpleRetrievalPort({
      loadEntries: () => (options.kbSource ?? dynamoDbFaqKbSource).loadPublicEntries(),
      ...(options.topK === undefined ? {} : { topK: options.topK }),
      ...(options.maxCharsPerEntry === undefined
        ? {}
        : { maxCharsPerEntry: options.maxCharsPerEntry }),
      ...(options.cacheTtlMs === undefined ? {} : { cacheTtlMs: options.cacheTtlMs }),
    }),
    answerGeneration: apiKey
      ? createAnthropicGenerationPort({
          apiKey,
          ...(options.client === undefined ? {} : { client: options.client }),
        })
      : createGroundedDemoGenerationPort(),
    // The free profile is template_only by design. If Settings enables generated smalltalk,
    // returning null makes the existing router fail closed into continue_kb.
    smalltalkGeneration: {
      // フリー版は generated smalltalk を提供しない（常に null → KB 経路）。jsonSchema も使わない
      supportsStructuredOutput: false,
      async complete() {
        return null;
      },
    },
    answerPrompt: { buildSystemPrompt: buildSimpleAnswerSystemPrompt },
    defaultModel: process.env.FAQ_FREE_MODEL || DEFAULT_FREE_MODEL,
  };
}
