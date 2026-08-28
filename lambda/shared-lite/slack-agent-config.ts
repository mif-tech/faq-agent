import type {
  SlackAgentConfigPort,
  SlackAgentResolvedConfig,
  SlackAgentRuntimeBoundary,
} from '../shared/public/slack-agent-ports.js';
import {
  FAQ_AGENT_MODEL_ALLOWLIST,
  normalizeFaqAgentProfile,
  resolveAgentProfile,
} from '../functions/faq-chat/adapters/free/agent-config.js';
import type { LiteSlackAgentTrustClass } from './slack-agent-policy.js';

export const LITE_SLACK_DEFAULT_SYSTEM_PROMPT =
  'あなたは公式サイトのFAQアシスタントです。丁寧な日本語で簡潔に回答してください。';
export const LITE_SLACK_DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
export const LITE_SLACK_DEFAULT_MAX_OUTPUT_TOKENS = 600;

const ALLOWED_MODELS: ReadonlySet<string> = new Set(FAQ_AGENT_MODEL_ALLOWLIST);

export interface LiteSlackAgentResolvedConfig
  extends SlackAgentResolvedConfig<LiteSlackAgentTrustClass> {
  /** Slack KB adapter uses the same optional scope override as the HTTP named route. */
  kbAgentId?: string;
}

export interface LiteSlackAgentConfigPort extends SlackAgentConfigPort {
  resolve(agentId: string): Promise<LiteSlackAgentResolvedConfig | null>;
}

/**
 * Normalize the shared lite AgentConfig row into the complete Slack worker contract.
 * Re-validation here keeps custom/injected resolvers fail closed as well as DynamoDB rows.
 */
export function normalizeLiteSlackAgentConfig(
  input: unknown,
  expectedAgentId: string,
  runtime: SlackAgentRuntimeBoundary<LiteSlackAgentTrustClass>
): LiteSlackAgentResolvedConfig | null {
  if (
    runtime.trustClass !== 'slack' ||
    runtime.agentId !== expectedAgentId
  ) {
    return null;
  }

  const profile = normalizeFaqAgentProfile(input, expectedAgentId);
  if (!profile) return null;

  const model =
    profile.model ?? (process.env.FAQ_FREE_MODEL || LITE_SLACK_DEFAULT_MODEL);
  if (!ALLOWED_MODELS.has(model)) return null;

  return Object.freeze({
    agentId: profile.agentId,
    trustClass: 'slack',
    access: 'internal',
    model,
    maxOutputTokens:
      profile.maxOutputTokens ?? LITE_SLACK_DEFAULT_MAX_OUTPUT_TOKENS,
    systemPrompt: profile.systemPrompt ?? LITE_SLACK_DEFAULT_SYSTEM_PROMPT,
    logPolicy: profile.logPolicy ?? 'metadata_only',
    embeddingPolicy: 'disabled',
    kbTable: runtime.kbTableName,
    qaLogTable: runtime.qaLogTableName,
    enabled: profile.enabled,
    ...(profile.kbAgentId === undefined ? {} : { kbAgentId: profile.kbAgentId }),
  });
}

export function createLiteSlackAgentConfigPort(
  runtime: SlackAgentRuntimeBoundary<LiteSlackAgentTrustClass>
): LiteSlackAgentConfigPort {
  const boundary: SlackAgentRuntimeBoundary<LiteSlackAgentTrustClass> =
    Object.freeze({
      agentId: runtime.agentId,
      trustClass: runtime.trustClass,
      kbTableName: runtime.kbTableName,
      qaLogTableName: runtime.qaLogTableName,
    });

  return Object.freeze({
    async resolve(agentId: string): Promise<LiteSlackAgentResolvedConfig | null> {
      if (agentId !== boundary.agentId) return null;
      const profile = await resolveAgentProfile(agentId);
      return normalizeLiteSlackAgentConfig(profile, agentId, boundary);
    },
  });
}
