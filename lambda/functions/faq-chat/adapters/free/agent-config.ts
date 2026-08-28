import type {
  FaqAgentConfigPort,
  FaqAgentProfile,
} from '../../ports/storage.js';
import { getItem, LiteTableNames } from '../../infra/lite-dynamodb.js';
import {
  AGENT_ID_PATTERN,
  normalizeFaqAgentProfile,
} from './agent-profile.js';

export {
  AGENT_ID_PATTERN,
  FAQ_AGENT_LOG_POLICY_ALLOWLIST,
  FAQ_AGENT_MODEL_ALLOWLIST,
  FAQ_AGENT_PROFILE_LIMITS,
  normalizeFaqAgentProfile,
  validateFaqAgentProfile,
} from './agent-profile.js';
export type {
  FaqAgentProfileValidationError,
  FaqAgentProfileValidationResult,
} from './agent-profile.js';

export const FAQ_AGENT_PROFILE_CACHE_TTL_MS = 30_000;
const FAQ_AGENT_PROFILE_CACHE_MAX_ENTRIES = 256;

interface CachedProfile {
  expiresAt: number;
  value: FaqAgentProfile | null;
}

const profileCache = new Map<string, CachedProfile>();

function pruneProfileCache(now: number): void {
  for (const [cachedAgentId, cached] of profileCache) {
    if (cached.expiresAt <= now) profileCache.delete(cachedAgentId);
  }
  while (profileCache.size >= FAQ_AGENT_PROFILE_CACHE_MAX_ENTRIES) {
    const oldestAgentId = profileCache.keys().next().value as string | undefined;
    if (oldestAgentId === undefined) return;
    profileCache.delete(oldestAgentId);
  }
}

/** Invalid identifiers and invalid/missing rows all resolve to null (named-route fail closed). */
export async function resolveAgentProfile(
  agentId: string
): Promise<FaqAgentProfile | null> {
  if (!AGENT_ID_PATTERN.test(agentId)) return null;

  const now = Date.now();
  const cached = profileCache.get(agentId);
  if (cached && cached.expiresAt > now) return cached.value;
  if (cached) profileCache.delete(agentId);
  pruneProfileCache(now);

  const row = await getItem<unknown>(LiteTableNames.AgentConfig, { agentId });
  const value = normalizeFaqAgentProfile(row, agentId);
  profileCache.set(agentId, {
    value,
    expiresAt: now + FAQ_AGENT_PROFILE_CACHE_TTL_MS,
  });
  return value;
}

export function clearFaqAgentProfileCache(): void {
  profileCache.clear();
}

export const dynamoDbFaqAgentConfig: FaqAgentConfigPort = {
  resolveAgentProfile,
};
