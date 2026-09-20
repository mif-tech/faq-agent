import type {
  FaqRagError,
  FaqRagGenerateRequest,
  FaqRagPublicResponse,
} from '../../ports/rag.js';
import type { FaqRetrievalHints } from '../../ports/retrieval.js';
import {
  FAQ_RAG_CONTRACT_VERSION,
  RemoteContractValidationError,
  parseRemoteV1GenerateRequest,
  parseRemoteV1GenerateResponse,
  parseRemoteV1RetrieveRequest,
  parseRemoteV1RetrieveResponse,
} from './contract.js';

export const FAQ_RAG_ANSWER_CONTRACT_VERSION = 'remote-one-shot-v1' as const;

export const REMOTE_ONE_SHOT_ANSWER_ERROR_CODES = [
  'no_match',
  'invalid_contract',
  'quota_exceeded',
  'kill_switch',
  'deadline_exceeded',
  'retrieval_failed',
  'generation_failed',
  'busy',
] as const;

export type RemoteOneShotAnswerErrorCode = (typeof REMOTE_ONE_SHOT_ANSWER_ERROR_CODES)[number];
export type RemoteOneShotAnswerError = Exclude<FaqRagError, { code: 'expired_token' }>;

export interface RemoteOneShotAnswerRequest
  extends Omit<FaqRagGenerateRequest, 'contractVersion' | 'sessionToken'> {
  contractVersion: typeof FAQ_RAG_ANSWER_CONTRACT_VERSION;
  hints?: FaqRetrievalHints;
}

export type RemoteOneShotAnswerResponse =
  | {
      contractVersion: typeof FAQ_RAG_ANSWER_CONTRACT_VERSION;
      ok: true;
      response: FaqRagPublicResponse;
    }
  | {
      contractVersion: typeof FAQ_RAG_ANSWER_CONTRACT_VERSION;
      ok: false;
      error: RemoteOneShotAnswerError;
    };

/** Values from the request/provider are never included in validation errors. */
export class RemoteOneShotContractValidationError extends Error {
  readonly code = 'invalid_contract' as const;

  constructor(readonly field: string) {
    super(`Invalid ${FAQ_RAG_ANSWER_CONTRACT_VERSION} contract at ${field}`);
    this.name = 'RemoteOneShotContractValidationError';
  }
}

function fail(field: string): never {
  throw new RemoteOneShotContractValidationError(field);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (
    typeof value !== 'object' || value === null || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) fail(field);
  return value as Record<string, unknown>;
}

function exactKeys(
  object: Record<string, unknown>, required: readonly string[], optional: readonly string[], field: string
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(object, key)) ||
    Object.getOwnPropertyNames(object).some((key) => !allowed.has(key))
  ) fail(field);
}

function version(object: Record<string, unknown>): void {
  if (object.contractVersion !== FAQ_RAG_ANSWER_CONTRACT_VERSION) fail('contractVersion');
}

function sharedValidation<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof RemoteContractValidationError) {
      fail(error.field.replace(/^(retrieve|generate)/, 'answer'));
    }
    throw error;
  }
}

/**
 * Reuse the split contract's field bounds and cross-field rules. This constant
 * exists only inside pure validation: no session is created, read or returned.
 */
const VALIDATION_SESSION_TOKEN = '00000000-0000-4000-8000-000000000000';

export function parseRemoteOneShotAnswerRequest(value: unknown): RemoteOneShotAnswerRequest {
  const object = record(value, 'answerRequest');
  exactKeys(object,
    ['contractVersion', 'idempotencyKey', 'currentQuestion', 'messages', 'remainingMs'],
    ['hints'], 'answerRequest');
  version(object);
  return sharedValidation(() => {
    const generate = parseRemoteV1GenerateRequest({
      contractVersion: FAQ_RAG_CONTRACT_VERSION,
      sessionToken: VALIDATION_SESSION_TOKEN,
      idempotencyKey: object.idempotencyKey,
      currentQuestion: object.currentQuestion,
      messages: object.messages,
      remainingMs: object.remainingMs,
    });
    const retrieve = parseRemoteV1RetrieveRequest({
      contractVersion: FAQ_RAG_CONTRACT_VERSION,
      question: object.currentQuestion,
      remainingMs: object.remainingMs,
      ...(Object.hasOwn(object, 'hints') ? { hints: object.hints } : {}),
    });
    return {
      contractVersion: FAQ_RAG_ANSWER_CONTRACT_VERSION,
      idempotencyKey: generate.idempotencyKey,
      currentQuestion: generate.currentQuestion,
      messages: generate.messages,
      remainingMs: generate.remainingMs,
      ...(retrieve.hints === undefined ? {} : { hints: retrieve.hints }),
    };
  });
}

/** Uses the same source URL, envelope, refusal and error guards as split-v1. */
export function parseRemoteOneShotAnswerResponse(value: unknown): RemoteOneShotAnswerResponse {
  const object = record(value, 'answerResponse');
  version(object);
  if (object.ok === false) {
    exactKeys(object, ['contractVersion', 'ok', 'error'], [], 'answerResponse');
    const error = record(object.error, 'answerResponse.error');
    if (!(REMOTE_ONE_SHOT_ANSWER_ERROR_CODES as readonly unknown[]).includes(error.code)) {
      fail('answerResponse.error.code');
    }
    return sharedValidation(() => {
      const split = { contractVersion: FAQ_RAG_CONTRACT_VERSION, ok: false, error };
      const parsed = error.code === 'generation_failed'
        ? parseRemoteV1GenerateResponse(split)
        : parseRemoteV1RetrieveResponse(split);
      if (parsed.ok || parsed.error.code === 'expired_token') return fail('answerResponse.error');
      return { contractVersion: FAQ_RAG_ANSWER_CONTRACT_VERSION, ok: false, error: parsed.error };
    });
  }
  if (object.ok !== true) fail('answerResponse.ok');
  exactKeys(object, ['contractVersion', 'ok', 'response'], [], 'answerResponse');
  return sharedValidation(() => {
    const parsed = parseRemoteV1GenerateResponse({
      contractVersion: FAQ_RAG_CONTRACT_VERSION, ok: true, response: object.response,
    });
    if (!parsed.ok) return fail('answerResponse');
    return { contractVersion: FAQ_RAG_ANSWER_CONTRACT_VERSION, ok: true, response: parsed.response };
  });
}
