import Anthropic from '@anthropic-ai/sdk';
import type { FaqPorts } from '../../ports/index.js';
import { disabledFaqInflightPort } from '../../ports/inflight.js';
import type { FaqSmalltalkGenerationPort } from '../../ports/generation.js';
import type { AnthropicGenerationOptions } from './anthropic-generation.js';
import { createAnthropicGenerationPort } from './anthropic-generation.js';
import { createAnthropicSmalltalkPort } from './anthropic-smalltalk.js';
import { dynamoDbFaqKbSource } from './dynamodb-entries.js';
import { createGroundedDemoGenerationPort } from './grounded-demo-generation.js';
import { buildSimpleAnswerSystemPrompt } from './simple-answer-prompt.js';
import { createSimpleRetrievalPort } from './simple-retrieval.js';
import type { FaqAgentConfigPort, FaqKbSourcePort } from '../../ports/storage.js';

export interface FreeFaqPortsOptions {
  kbSource?: FaqKbSourcePort;
  topK?: number;
  maxCharsPerEntry?: number;
  cacheTtlMs?: number;
  /** Undefined reads ANTHROPIC_API_KEY; null/empty disables both Anthropic-backed ports. */
  apiKey?: string | null;
  /** Shared injectable client for the answer and generated-smalltalk Anthropic ports. */
  client?: AnthropicGenerationOptions['client'];
  /**
   * 決定的 smalltalk ガード（handler の has_business_topic）へ注入するテナント業務語彙。
   * undefined は環境変数 FAQ_GUARD_BUSINESS_TERMS（カンマ区切り）を読む。
   * 1語も無ければ guardVocabulary フィールド自体を出さない（従来挙動）。
   */
  guardBusinessTerms?: readonly string[];
}

const DEFAULT_FREE_MODEL = 'claude-haiku-4-5-20251001';
const unavailableAgentConfig: FaqAgentConfigPort = {
  async resolveAgentProfile() {
    return null;
  },
};

function resolveGuardBusinessTerms(option: readonly string[] | undefined): readonly string[] {
  const raw = option ?? (process.env.FAQ_GUARD_BUSINESS_TERMS ?? '').split(',');
  return raw.map((term) => term.trim()).filter((term) => term.length > 0);
}

export function createFreeFaqPorts(
  options: FreeFaqPortsOptions = {}
): Omit<FaqPorts, 'storage'> {
  // Preserve the existing explicit null/empty opt-out while sharing one resolved key
  // between answer generation and generated smalltalk.
  const apiKey =
    options.apiKey === undefined ? process.env.ANTHROPIC_API_KEY : (options.apiKey ?? undefined);
  // JSDoc どおりの「共有 client」を守るため、ここで一度だけ解決して両 port に渡す
  // （未注入時に answer / smalltalk が別々に new Anthropic しない）。
  const client = apiKey ? (options.client ?? new Anthropic({ apiKey })) : undefined;
  const smalltalkGeneration: FaqSmalltalkGenerationPort = apiKey
    ? createAnthropicSmalltalkPort({ apiKey, ...(client ? { client } : {}) })
    : {
        // Without an API key, generated smalltalk fails closed into the existing KB path.
        supportsStructuredOutput: false,
        async complete() {
          return null;
        },
      };
  const guardBusinessTerms = resolveGuardBusinessTerms(options.guardBusinessTerms);

  return {
    inflight: disabledFaqInflightPort,
    retrieval: createSimpleRetrievalPort({
      loadEntries: (kbAgentId) => {
        const kbSource = options.kbSource ?? dynamoDbFaqKbSource;
        return kbAgentId === undefined
          ? kbSource.loadPublicEntries()
          : kbSource.loadPublicEntries(kbAgentId);
      },
      ...(options.topK === undefined ? {} : { topK: options.topK }),
      ...(options.maxCharsPerEntry === undefined
        ? {}
        : { maxCharsPerEntry: options.maxCharsPerEntry }),
      ...(options.cacheTtlMs === undefined ? {} : { cacheTtlMs: options.cacheTtlMs }),
    }),
    answerGeneration: apiKey
      ? createAnthropicGenerationPort({ apiKey, ...(client ? { client } : {}) })
      : createGroundedDemoGenerationPort(),
    smalltalkGeneration,
    ...(guardBusinessTerms.length > 0
      ? { guardVocabulary: { businessTerms: guardBusinessTerms } }
      : {}),
    answerPrompt: { buildSystemPrompt: buildSimpleAnswerSystemPrompt },
    // canonical free profile は named agent を構成しない。overlay composition が明示的に差し替える。
    agentConfig: unavailableAgentConfig,
    defaultModel: process.env.FAQ_FREE_MODEL || DEFAULT_FREE_MODEL,
  };
}
