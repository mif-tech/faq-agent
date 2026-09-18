/** Invocation-local shell observations. Never accept request text, URLs or errors. */
import { AsyncLocalStorage } from 'node:async_hooks';

export type FaqTimingOutcome = 'success' | 'disabled' | 'skipped' | 'timeout' | 'failure';
export type FaqGenerateEndReason = FaqTimingOutcome | 'no_match' | 'truncated' | 'refused' | 'invalid_response';
export interface FaqCredentialTiming {
  credential_wait_ms: number;
  credential_cache: 'hit' | 'refresh' | 'cold';
  assume_role_ms: number;
  assume_role_attempts: number;
  outcome: FaqTimingOutcome;
}
export interface FaqRemoteAttemptTiming {
  operation: 'retrieve' | 'generate' | 'answer';
  attempt: number;
  signing_ms: number;
  http_headers_ms: number;
  body_parse_ms: number;
  retry_wait_ms: number;
  outcome: FaqTimingOutcome;
}
interface TimingState {
  active: boolean;
  qaNotifyObserved?: boolean;
  qaNotifyFinalized?: boolean;
  fields: Record<string, unknown>;
  credentials: FaqCredentialTiming[];
  attempts: FaqRemoteAttemptTiming[];
}
const invocation = new AsyncLocalStorage<TimingState>();
const outcomes = new Set<string>(['success', 'disabled', 'skipped', 'timeout', 'failure']);
const generateReasons = new Set<string>([...outcomes, 'no_match', 'truncated', 'refused', 'invalid_response']);
const duration = (value: unknown): number => typeof value === 'number' && Number.isFinite(value)
  ? Math.max(0, Math.round(value)) : 0;
const activeState = (): TimingState | undefined => {
  const state = invocation.getStore();
  return state?.active ? state : undefined;
};

export function recordFaqShellDuration(
  field: 'settings_ms' | 'router_ms' | 'smalltalk_settle_ms' | 'response_serialize_ms' | 'qa_write_ms' | 'qa_notify_ms',
  milliseconds: number
): void {
  const state = activeState();
  if (state && ['settings_ms', 'router_ms', 'smalltalk_settle_ms', 'response_serialize_ms', 'qa_write_ms', 'qa_notify_ms'].includes(field)) {
    state.fields[field] = duration(state.fields[field]) + duration(milliseconds);
  }
}

export function recordFaqQaWriteOutcome(outcome: FaqTimingOutcome): void {
  const state = activeState();
  if (state && outcomes.has(outcome)) state.fields.qa_write_outcome = outcome;
}

export function recordFaqQaNotifyOutcome(outcome: FaqTimingOutcome): void {
  const state = activeState();
  if (state && !state.qaNotifyFinalized && outcomes.has(outcome)) {
    state.fields.qa_notify_outcome = outcome;
    state.qaNotifyObserved = true;
  }
}

/** Caller timeout/failure wins; fulfillment defaults to success only without an adapter observation. */
export function finalizeFaqQaNotifyOutcome(outcome: 'success' | 'timeout' | 'failure'): void {
  const state = activeState();
  if (!state || state.qaNotifyFinalized || !['success', 'timeout', 'failure'].includes(outcome)) return;
  if (outcome !== 'success' || !state.qaNotifyObserved) state.fields.qa_notify_outcome = outcome;
  state.qaNotifyFinalized = true;
}

export function recordFaqHandlerOutcome(outcome: FaqTimingOutcome): void {
  const state = activeState();
  if (state && outcomes.has(outcome)) state.fields.handler_outcome = outcome;
}

export function recordFaqGenerateBudget(fields: {
  remaining_at_generate_start_ms?: number | null;
  effective_generate_timeout_ms?: number;
  generate_end_reason?: FaqGenerateEndReason;
}): void {
  const state = activeState();
  if (!state) return;
  if (fields.remaining_at_generate_start_ms !== undefined) {
    state.fields.remaining_at_generate_start_ms = fields.remaining_at_generate_start_ms === null
      ? null : duration(fields.remaining_at_generate_start_ms);
  }
  if (fields.effective_generate_timeout_ms !== undefined) {
    state.fields.effective_generate_timeout_ms = duration(fields.effective_generate_timeout_ms);
  }
  if (fields.generate_end_reason && generateReasons.has(fields.generate_end_reason)) {
    state.fields.generate_end_reason = fields.generate_end_reason;
  }
}

export function recordFaqCredentialTiming(input: FaqCredentialTiming): void {
  const state = activeState();
  if (!state || state.credentials.length >= 8 ||
    !['hit', 'refresh', 'cold'].includes(input.credential_cache) || !outcomes.has(input.outcome)) return;
  const entry: FaqCredentialTiming = {
    credential_wait_ms: duration(input.credential_wait_ms),
    credential_cache: input.credential_cache,
    assume_role_ms: duration(input.assume_role_ms),
    assume_role_attempts: duration(input.assume_role_attempts),
    outcome: input.outcome,
  };
  state.credentials.push(entry);
  for (const key of ['credential_wait_ms', 'assume_role_ms', 'assume_role_attempts'] as const) {
    state.fields[key] = duration(state.fields[key]) + entry[key];
  }
  state.fields.credential_cache = entry.credential_cache;
  state.fields.credential_outcome = entry.outcome;
}

/** One-shot timing covers the full remote answer operation, not its hidden generation stage. */
export function recordFaqAnswerBudget(fields: {
  remaining_at_answer_start_ms?: number;
  effective_answer_timeout_ms?: number;
}): void {
  const state = activeState();
  if (!state) return;
  if (fields.remaining_at_answer_start_ms !== undefined) {
    state.fields.remaining_at_answer_start_ms = duration(fields.remaining_at_answer_start_ms);
  }
  if (fields.effective_answer_timeout_ms !== undefined) {
    state.fields.effective_answer_timeout_ms = duration(fields.effective_answer_timeout_ms);
  }
}

export function recordFaqRemoteAttemptTiming(input: FaqRemoteAttemptTiming): void {
  const state = activeState();
  if (!state || state.attempts.length >= 8 || !['retrieve', 'generate', 'answer'].includes(input.operation) ||
    !Number.isSafeInteger(input.attempt) || input.attempt < 1 || input.attempt > 8 || !outcomes.has(input.outcome)) return;
  state.attempts.push({
    operation: input.operation,
    attempt: input.attempt,
    signing_ms: duration(input.signing_ms),
    http_headers_ms: duration(input.http_headers_ms),
    body_parse_ms: duration(input.body_parse_ms),
    retry_wait_ms: duration(input.retry_wait_ms),
    outcome: input.outcome,
  });
}

/** Emit the existing metric immediately and unchanged, before Q&A side effects. */
export function emitFaqChatMetric(fields: Record<string, unknown>): void {
  // Detached work after finalization must not emit into a later invocation's logs.
  const state = invocation.getStore();
  if (!state || state.active) console.log(JSON.stringify(fields));
}

function remaining(read?: () => number): number | null {
  try {
    const value = read?.();
    return typeof value === 'number' && Number.isFinite(value) ? duration(value) : null;
  } catch {
    return null;
  }
}

export async function runFaqShellTiming<T>(options: {
  requestId: string;
  coldStart: boolean;
  transport?: 'split-v1' | 'one-shot-v1';
  remainingTime?: () => number;
  startedAt?: number;
}, callback: () => Promise<T>): Promise<T> {
  const startedAt = options.startedAt ?? Date.now();
  const state: TimingState = {
    active: true,
    credentials: [],
    attempts: [],
    fields: {
      remaining_start_ms: remaining(options.remainingTime),
      settings_ms: 0, router_ms: 0, smalltalk_settle_ms: 0, response_serialize_ms: 0,
      qa_write_ms: 0, qa_write_outcome: 'skipped', qa_notify_ms: 0, qa_notify_outcome: 'skipped',
      credential_wait_ms: 0, credential_cache: 'skipped', credential_outcome: 'skipped',
      assume_role_ms: 0, assume_role_attempts: 0,
      remaining_at_generate_start_ms: null, effective_generate_timeout_ms: null,
      remaining_at_answer_start_ms: null, effective_answer_timeout_ms: null,
      generate_end_reason: 'skipped',
    },
  };
  return invocation.run(state, async () => {
    let failed = false;
    try {
      const result = await callback();
      if (state.fields.handler_outcome === undefined && typeof result === 'object' && result !== null && 'statusCode' in result) {
        const statusCode = result.statusCode;
        state.fields.handler_outcome = typeof statusCode === 'number' && statusCode >= 500 ? 'failure'
          : statusCode === 204 || (typeof statusCode === 'number' && statusCode >= 400) ? 'skipped' : 'success';
      }
      return result;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      state.active = false;
      // Project allowlisted values into a detached snapshot before logging; detached
      // timed-out work cannot mutate this event or a subsequent invocation's event.
      console.log(JSON.stringify({
        metric: 'faq_shell_timing',
        ...state.fields,
        requestId: /^[A-Za-z0-9_+=./:-]{1,128}$/.test(options.requestId) ? options.requestId : null,
        coldStart: options.coldStart === true,
        remote_transport: options.transport === 'split-v1' || options.transport === 'one-shot-v1'
          ? options.transport : 'local',
        credential_events: state.credentials,
        remote_attempts: state.attempts,
        retrieve_attempts: state.attempts.filter((entry) => entry.operation === 'retrieve').length,
        generate_attempts: state.attempts.filter((entry) => entry.operation === 'generate').length,
        answer_attempts: state.attempts.filter((entry) => entry.operation === 'answer').length,
        handler_total_ms: duration(Date.now() - startedAt),
        remaining_return_ms: remaining(options.remainingTime),
        handler_outcome: failed ? 'failure' : state.fields.handler_outcome ?? 'success',
      }));
    }
  });
}
