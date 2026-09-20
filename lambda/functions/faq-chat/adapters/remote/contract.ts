import {
  FAQ_RAG_CONTRACT_VERSION,
  FAQ_RAG_ERROR_CODES,
  type FaqRagError,
  type FaqRagErrorCode,
  type FaqRagGenerateMessage,
  type FaqRagGenerateRequest,
  type FaqRagGenerateResponse,
  type FaqRagPublicResponse,
  type FaqRagRetrieveRequest,
  type FaqRagRetrieveResponse,
  type FaqRagSource,
} from '../../ports/rag.js';
import type { FaqRetrievalHints } from '../../ports/retrieval.js';
import { containsUrl } from '../../envelope.js';
import { isPublishableSourceUrl } from '../../source-url.js';

export { FAQ_RAG_CONTRACT_VERSION, FAQ_RAG_ERROR_CODES };

export type RemoteV1RetrieveRequest = FaqRagRetrieveRequest;
export type RemoteV1RetrieveResponse = FaqRagRetrieveResponse;
export type RemoteV1GenerateRequest = FaqRagGenerateRequest;
export type RemoteV1GenerateResponse = FaqRagGenerateResponse;

export const REMOTE_V1_LIMITS = {
  questionCodePoints: 4_000,
  generationContentCodePoints: 8_000,
  lexicalTermCount: 8,
  lexicalTermCodePoints: 16,
  semanticQueryCount: 2,
  semanticQueryCodePoints: 64,
  sessionTokenCodePoints: 36,
  idempotencyKeyCodePoints: 256,
  remainingMs: 60_000,
  retryAfterMs: 86_400_000,
  answerCodePoints: 16_000,
  sourceCount: 5,
  sourceEntryIdCodePoints: 512,
  sourceTopicCodePoints: 512,
  sourceUrlCodePoints: 2_048,
} as const;

/**
 * Server-side retrieve bound: remote-v1 servers cap retrieve execution at
 * remainingMs minus this floor (non-positive → deadline_exceeded without calling
 * the provider), reserving time for a later generate call. Session deadlines
 * still use the full remainingMs. Single source for the facade default and the
 * shell's entry guard so the two can never drift apart.
 */
export const REMOTE_V1_GENERATE_BUDGET_FLOOR_MS = 5_000;

/** Reserve caller time after generation for finalizing the response. */
export const REMOTE_V1_GENERATION_RESERVE_MS = 250;

export const REMOTE_V1_RETRIEVE_ERROR_CODES = [
  'no_match',
  'quota_exceeded',
  'kill_switch',
  'invalid_contract',
  'deadline_exceeded',
  'retrieval_failed',
  'busy',
] as const satisfies readonly FaqRagErrorCode[];

export const REMOTE_V1_GENERATE_ERROR_CODES = [
  'expired_token',
  'quota_exceeded',
  'kill_switch',
  'invalid_contract',
  'deadline_exceeded',
  'generation_failed',
  'busy',
] as const satisfies readonly FaqRagErrorCode[];

const ERROR_RETRYABILITY = {
  no_match: false,
  expired_token: true,
  quota_exceeded: true,
  kill_switch: true,
  invalid_contract: false,
  deadline_exceeded: true,
  retrieval_failed: true,
  generation_failed: true,
  busy: true,
} as const satisfies Record<FaqRagErrorCode, boolean>;

const SESSION_TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Validation failure at a remote-v1 JSON boundary. Values are never included in the message. */
export class RemoteContractValidationError extends Error {
  readonly code = 'invalid_contract' as const;

  constructor(readonly field: string) {
    super(`Invalid ${FAQ_RAG_CONTRACT_VERSION} contract at ${field}`);
    this.name = 'RemoteContractValidationError';
  }
}

type JsonRecord = Record<string, unknown>;

function fail(field: string): never {
  throw new RemoteContractValidationError(field);
}

function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function record(value: unknown, field: string): JsonRecord {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    return fail(field);
  }
  return value as JsonRecord;
}

function exactKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[],
  field: string
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    fail(field);
  }
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function stringValue(
  value: unknown,
  field: string,
  options: { nonBlank?: boolean; maxCodePoints: number }
): string {
  if (
    typeof value !== 'string' ||
    (options.nonBlank === true && value.trim().length === 0) ||
    codePointLength(value) > options.maxCodePoints
  ) {
    return fail(field);
  }
  return value;
}

function safeInteger(
  value: unknown,
  field: string,
  options: { allowZero?: boolean; max?: number } = {}
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    (options.allowZero === true ? value < 0 : value <= 0) ||
    (options.max !== undefined && value > options.max)
  ) {
    return fail(field);
  }
  return value;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') return fail(field);
  return value;
}

function version(value: JsonRecord): void {
  if (value.contractVersion !== FAQ_RAG_CONTRACT_VERSION) fail('contractVersion');
}

function boundedStringArray(
  value: unknown,
  field: string,
  maxItems: number,
  maxCodePoints: number
): string[] {
  if (!Array.isArray(value) || value.length > maxItems) return fail(field);
  return value.map((item, index) =>
    stringValue(item, `${field}[${index}]`, { nonBlank: true, maxCodePoints })
  );
}

function hints(value: unknown, field: string): FaqRetrievalHints {
  const object = record(value, field);
  exactKeys(object, ['lexicalTerms', 'semanticQueries'], [], field);
  return {
    lexicalTerms: boundedStringArray(
      object.lexicalTerms,
      `${field}.lexicalTerms`,
      REMOTE_V1_LIMITS.lexicalTermCount,
      REMOTE_V1_LIMITS.lexicalTermCodePoints
    ),
    semanticQueries: boundedStringArray(
      object.semanticQueries,
      `${field}.semanticQueries`,
      REMOTE_V1_LIMITS.semanticQueryCount,
      REMOTE_V1_LIMITS.semanticQueryCodePoints
    ),
  };
}

function messages(value: unknown, field: string): [FaqRagGenerateMessage] {
  if (!Array.isArray(value) || value.length !== 1) return fail(field);
  const object = record(value[0], `${field}[0]`);
  exactKeys(object, ['role', 'content'], [], `${field}[0]`);
  if (object.role !== 'user') fail(`${field}[0].role`);
  return [
    {
      role: 'user',
      content: stringValue(object.content, `${field}[0].content`, {
        nonBlank: true,
        maxCodePoints: REMOTE_V1_LIMITS.generationContentCodePoints,
      }),
    },
  ];
}

export function parseRemoteV1SessionToken(value: unknown, field = 'sessionToken'): string {
  const token = stringValue(value, field, {
    nonBlank: true,
    maxCodePoints: REMOTE_V1_LIMITS.sessionTokenCodePoints,
  });
  if (codePointLength(token) !== REMOTE_V1_LIMITS.sessionTokenCodePoints) fail(field);
  if (!SESSION_TOKEN_PATTERN.test(token)) fail(field);
  return token;
}

function error(
  value: unknown,
  field: string,
  allowedCodes: readonly FaqRagErrorCode[]
): FaqRagError {
  const object = record(value, field);
  exactKeys(object, ['code', 'retryable'], ['retryAfterMs'], field);
  if (
    typeof object.code !== 'string' ||
    !(FAQ_RAG_ERROR_CODES as readonly string[]).includes(object.code) ||
    !allowedCodes.includes(object.code as FaqRagErrorCode)
  ) {
    fail(`${field}.code`);
  }
  const code = object.code as FaqRagErrorCode;
  const retryable = booleanValue(object.retryable, `${field}.retryable`);
  if (retryable !== ERROR_RETRYABILITY[code]) fail(`${field}.retryable`);

  const hasRetryAfterMs = hasOwn(object, 'retryAfterMs');
  if (code === 'quota_exceeded' || code === 'busy') {
    if (!hasRetryAfterMs) fail(`${field}.retryAfterMs`);
    return {
      code,
      retryable: true,
      retryAfterMs: safeInteger(object.retryAfterMs, `${field}.retryAfterMs`, {
        max: REMOTE_V1_LIMITS.retryAfterMs,
      }),
    };
  }
  if (hasRetryAfterMs) fail(`${field}.retryAfterMs`);
  return { code, retryable } as FaqRagError;
}

function source(value: unknown, field: string): FaqRagSource {
  const object = record(value, field);
  exactKeys(object, ['entryId', 'topic'], ['url'], field);
  const result: FaqRagSource = {
    entryId: stringValue(object.entryId, `${field}.entryId`, {
      nonBlank: true,
      maxCodePoints: REMOTE_V1_LIMITS.sourceEntryIdCodePoints,
    }),
    topic: stringValue(object.topic, `${field}.topic`, {
      nonBlank: true,
      maxCodePoints: REMOTE_V1_LIMITS.sourceTopicCodePoints,
    }),
  };
  if (hasOwn(object, 'url')) {
    const url = stringValue(object.url, `${field}.url`, {
      nonBlank: true,
      maxCodePoints: REMOTE_V1_LIMITS.sourceUrlCodePoints,
    });
    // 公開してよいURLの判定は handler / server seam と同一の正本を使う（経路ごとの分岐を作らない）
    if (!isPublishableSourceUrl(url)) fail(`${field}.url`);
    result.url = url;
  }
  return result;
}

function publicResponse(value: unknown, field: string): FaqRagPublicResponse {
  const object = record(value, field);
  exactKeys(
    object,
    ['answer', 'answerable', 'sources', 'responseType'],
    ['scopeFallback', 'failureKind', 'retryable'],
    field
  );
  if (object.responseType !== 'kb_answer' && object.responseType !== 'refuse') {
    fail(`${field}.responseType`);
  }
  if (!Array.isArray(object.sources) || object.sources.length > REMOTE_V1_LIMITS.sourceCount) {
    fail(`${field}.sources`);
  }
  const result: FaqRagPublicResponse = {
    answer: stringValue(object.answer, `${field}.answer`, {
      nonBlank: true,
      maxCodePoints: REMOTE_V1_LIMITS.answerCodePoints,
    }),
    answerable: booleanValue(object.answerable, `${field}.answerable`),
    sources: object.sources.map((item, index) => source(item, `${field}.sources[${index}]`)),
    responseType: object.responseType,
  };
  if (new Set(result.sources.map((item) => item.entryId)).size !== result.sources.length) {
    fail(`${field}.sources`);
  }

  const hasScopeFallback = hasOwn(object, 'scopeFallback');
  const hasFailureKind = hasOwn(object, 'failureKind');
  const hasRetryable = hasOwn(object, 'retryable');
  if (hasScopeFallback) {
    if (object.scopeFallback !== true) fail(`${field}.scopeFallback`);
    result.scopeFallback = true;
  }
  if (hasFailureKind) {
    if (object.failureKind !== 'envelope_invalid') fail(`${field}.failureKind`);
    result.failureKind = 'envelope_invalid';
  }
  if (hasRetryable) {
    if (object.retryable !== true) fail(`${field}.retryable`);
    result.retryable = true;
  }

  if (result.responseType === 'kb_answer') {
    if (
      result.answerable !== true ||
      result.sources.length === 0 ||
      // URL 判定は envelope.ts の containsUrl が正本（二重実装のドリフト防止 / レビュー指摘）。
      // この検査は kb_answer のみ: refuse の answer はサーバ所有の固定文面のため検査しない（README 参照）
      containsUrl(result.answer) ||
      hasScopeFallback ||
      hasFailureKind ||
      hasRetryable
    ) {
      fail(field);
    }
    return result;
  }

  const isPlainRefusal = !hasScopeFallback && !hasFailureKind && !hasRetryable;
  const isScopeRefusal = hasScopeFallback && !hasFailureKind && !hasRetryable;
  const isTechnicalRefusal = !hasScopeFallback && hasFailureKind && hasRetryable;
  if (
    result.answerable !== false ||
    result.sources.length !== 0 ||
    (!isPlainRefusal && !isScopeRefusal && !isTechnicalRefusal)
  ) {
    fail(field);
  }
  return result;
}

/** Strictly validate an inbound remote-v1 retrieve DTO. Unknown fields fail closed. */
export function parseRemoteV1RetrieveRequest(value: unknown): RemoteV1RetrieveRequest {
  const object = record(value, 'retrieveRequest');
  exactKeys(
    object,
    ['contractVersion', 'question', 'remainingMs'],
    ['hints'],
    'retrieveRequest'
  );
  version(object);
  return {
    contractVersion: FAQ_RAG_CONTRACT_VERSION,
    question: stringValue(object.question, 'retrieveRequest.question', {
      nonBlank: true,
      maxCodePoints: REMOTE_V1_LIMITS.questionCodePoints,
    }),
    ...(hasOwn(object, 'hints')
      ? { hints: hints(object.hints, 'retrieveRequest.hints') }
      : {}),
    remainingMs: safeInteger(object.remainingMs, 'retrieveRequest.remainingMs', {
      max: REMOTE_V1_LIMITS.remainingMs,
    }),
  };
}

/** Strictly validate an outbound remote-v1 retrieve DTO before a client trusts it. */
export function parseRemoteV1RetrieveResponse(value: unknown): RemoteV1RetrieveResponse {
  const object = record(value, 'retrieveResponse');
  version(object);
  if (object.ok === false) {
    exactKeys(object, ['contractVersion', 'ok', 'error'], [], 'retrieveResponse');
    return {
      contractVersion: FAQ_RAG_CONTRACT_VERSION,
      ok: false,
      error: error(object.error, 'retrieveResponse.error', REMOTE_V1_RETRIEVE_ERROR_CODES),
    };
  }
  if (object.ok !== true) fail('retrieveResponse.ok');
  exactKeys(
    object,
    ['contractVersion', 'ok', 'sessionToken', 'expiresAtEpochMs'],
    [],
    'retrieveResponse'
  );
  return {
    contractVersion: FAQ_RAG_CONTRACT_VERSION,
    ok: true,
    sessionToken: parseRemoteV1SessionToken(
      object.sessionToken,
      'retrieveResponse.sessionToken'
    ),
    expiresAtEpochMs: safeInteger(object.expiresAtEpochMs, 'retrieveResponse.expiresAtEpochMs'),
  };
}

/** Strictly validate an inbound remote-v1 generate DTO. */
export function parseRemoteV1GenerateRequest(value: unknown): RemoteV1GenerateRequest {
  const object = record(value, 'generateRequest');
  exactKeys(
    object,
    [
      'contractVersion',
      'sessionToken',
      'idempotencyKey',
      'currentQuestion',
      'messages',
      'remainingMs',
    ],
    [],
    'generateRequest'
  );
  version(object);
  const currentQuestion = stringValue(
    object.currentQuestion,
    'generateRequest.currentQuestion',
    {
      nonBlank: true,
      maxCodePoints: REMOTE_V1_LIMITS.questionCodePoints,
    }
  );
  const parsedMessages = messages(object.messages, 'generateRequest.messages');
  if (!parsedMessages[0].content.endsWith(currentQuestion)) {
    fail('generateRequest.messages[0].content');
  }
  return {
    contractVersion: FAQ_RAG_CONTRACT_VERSION,
    sessionToken: parseRemoteV1SessionToken(
      object.sessionToken,
      'generateRequest.sessionToken'
    ),
    idempotencyKey: stringValue(object.idempotencyKey, 'generateRequest.idempotencyKey', {
      nonBlank: true,
      maxCodePoints: REMOTE_V1_LIMITS.idempotencyKeyCodePoints,
    }),
    currentQuestion,
    messages: parsedMessages,
    remainingMs: safeInteger(object.remainingMs, 'generateRequest.remainingMs', {
      max: REMOTE_V1_LIMITS.remainingMs,
    }),
  };
}

/** Strictly validate an outbound remote-v1 generate DTO before a client trusts it. */
export function parseRemoteV1GenerateResponse(value: unknown): RemoteV1GenerateResponse {
  const object = record(value, 'generateResponse');
  version(object);
  if (object.ok === false) {
    exactKeys(object, ['contractVersion', 'ok', 'error'], [], 'generateResponse');
    return {
      contractVersion: FAQ_RAG_CONTRACT_VERSION,
      ok: false,
      error: error(object.error, 'generateResponse.error', REMOTE_V1_GENERATE_ERROR_CODES),
    };
  }
  if (object.ok !== true) fail('generateResponse.ok');
  exactKeys(object, ['contractVersion', 'ok', 'response'], [], 'generateResponse');
  return {
    contractVersion: FAQ_RAG_CONTRACT_VERSION,
    ok: true,
    response: publicResponse(object.response, 'generateResponse.response'),
  };
}
