import type { FaqAgentProfile } from '../../ports/storage.js';

/** Public route and DynamoDB key contract. Keep this copy independent from lambda/shared. */
export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const FAQ_AGENT_MODEL_ALLOWLIST = Object.freeze([
  'claude-sonnet-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-fable-5',
  'claude-haiku-4-5-20251001',
] as const);

export const FAQ_AGENT_LOG_POLICY_ALLOWLIST = Object.freeze([
  'off',
  'metadata_only',
  'redacted_full',
] as const);

const ALLOWED_MODELS = new Set<string>(FAQ_AGENT_MODEL_ALLOWLIST);
const ALLOWED_LOG_POLICIES = new Set<string>(FAQ_AGENT_LOG_POLICY_ALLOWLIST);
const ALLOWED_FIELDS = new Set<string>([
  'agentId',
  'enabled',
  'systemPrompt',
  'model',
  'maxOutputTokens',
  'fallbackMessage',
  'kbAgentId',
  'logPolicy',
]);

export const FAQ_AGENT_PROFILE_LIMITS = Object.freeze({
  systemPromptChars: 32_000,
  modelChars: 120,
  fallbackMessageChars: 4_000,
  minOutputTokens: 100,
  maxOutputTokens: 1_500,
});

export interface FaqAgentProfileValidationError {
  field: string;
  reason: string;
}

export type FaqAgentProfileValidationResult =
  | { ok: true; value: FaqAgentProfile }
  | { ok: false; errors: FaqAgentProfileValidationError[] };

function hasOwn(candidate: Record<string, unknown>, field: string): boolean {
  return Object.hasOwn(candidate, field);
}

function validateOptionalString(
  candidate: Record<string, unknown>,
  field: 'systemPrompt' | 'model' | 'fallbackMessage',
  maxChars: number,
  normalized: Partial<FaqAgentProfile>,
  errors: FaqAgentProfileValidationError[]
): void {
  if (!hasOwn(candidate, field)) return;
  const value = candidate[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push({ field, reason: 'must be a non-empty string when present' });
    return;
  }
  if (value.length > maxChars) {
    errors.push({ field, reason: `must be at most ${maxChars} chars` });
    return;
  }
  normalized[field] = value.trim();
}

/**
 * Validate and normalize the complete lite AgentConfig row.
 * Unknown fields are rejected so an internal/full AgentConfig cannot silently cross this boundary.
 */
export function validateFaqAgentProfile(
  input: unknown,
  expectedAgentId?: string
): FaqAgentProfileValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      ok: false,
      errors: [{ field: '$', reason: 'profile must be a JSON object' }],
    };
  }

  const candidate = input as Record<string, unknown>;
  const errors: FaqAgentProfileValidationError[] = [];
  const normalized: Partial<FaqAgentProfile> = {};

  for (const field of Object.keys(candidate)) {
    if (!ALLOWED_FIELDS.has(field)) {
      errors.push({ field, reason: 'unknown field' });
    }
  }

  if (!hasOwn(candidate, 'agentId')) {
    errors.push({ field: 'agentId', reason: 'field is required' });
  } else if (
    typeof candidate.agentId !== 'string' ||
    !AGENT_ID_PATTERN.test(candidate.agentId)
  ) {
    errors.push({
      field: 'agentId',
      reason: 'must match ^[a-z0-9][a-z0-9_-]{0,63}$',
    });
  } else {
    normalized.agentId = candidate.agentId;
    if (expectedAgentId !== undefined && candidate.agentId !== expectedAgentId) {
      errors.push({ field: 'agentId', reason: 'does not match the requested agentId' });
    }
  }

  if (!hasOwn(candidate, 'enabled')) {
    errors.push({ field: 'enabled', reason: 'field is required' });
  } else if (typeof candidate.enabled !== 'boolean') {
    errors.push({ field: 'enabled', reason: 'must be a boolean' });
  } else {
    normalized.enabled = candidate.enabled;
  }

  validateOptionalString(
    candidate,
    'systemPrompt',
    FAQ_AGENT_PROFILE_LIMITS.systemPromptChars,
    normalized,
    errors
  );
  validateOptionalString(
    candidate,
    'model',
    FAQ_AGENT_PROFILE_LIMITS.modelChars,
    normalized,
    errors
  );
  validateOptionalString(
    candidate,
    'fallbackMessage',
    FAQ_AGENT_PROFILE_LIMITS.fallbackMessageChars,
    normalized,
    errors
  );

  if (
    typeof normalized.model === 'string' &&
    !ALLOWED_MODELS.has(normalized.model)
  ) {
    errors.push({
      field: 'model',
      reason: `must be one of: ${FAQ_AGENT_MODEL_ALLOWLIST.join(', ')}`,
    });
  }

  if (hasOwn(candidate, 'maxOutputTokens')) {
    const value = candidate.maxOutputTokens;
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < FAQ_AGENT_PROFILE_LIMITS.minOutputTokens ||
      value > FAQ_AGENT_PROFILE_LIMITS.maxOutputTokens
    ) {
      errors.push({
        field: 'maxOutputTokens',
        reason:
          `must be a safe integer from ${FAQ_AGENT_PROFILE_LIMITS.minOutputTokens} ` +
          `through ${FAQ_AGENT_PROFILE_LIMITS.maxOutputTokens}`,
      });
    } else {
      normalized.maxOutputTokens = value;
    }
  }

  if (hasOwn(candidate, 'kbAgentId')) {
    const value = candidate.kbAgentId;
    if (typeof value !== 'string' || !AGENT_ID_PATTERN.test(value)) {
      errors.push({
        field: 'kbAgentId',
        reason: 'must match ^[a-z0-9][a-z0-9_-]{0,63}$ when present',
      });
    } else {
      normalized.kbAgentId = value;
    }
  }

  if (hasOwn(candidate, 'logPolicy')) {
    const value = candidate.logPolicy;
    if (typeof value !== 'string' || !ALLOWED_LOG_POLICIES.has(value)) {
      errors.push({
        field: 'logPolicy',
        reason: `must be one of: ${FAQ_AGENT_LOG_POLICY_ALLOWLIST.join(', ')}`,
      });
    } else {
      normalized.logPolicy = value as FaqAgentProfile['logPolicy'];
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: Object.freeze(normalized as FaqAgentProfile),
  };
}

export function normalizeFaqAgentProfile(
  input: unknown,
  expectedAgentId?: string
): FaqAgentProfile | null {
  const result = validateFaqAgentProfile(input, expectedAgentId);
  return result.ok ? result.value : null;
}
