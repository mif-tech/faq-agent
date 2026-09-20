import type { FaqRetrievalHints } from './retrieval.js';

/** Versioned, JSON-only contract used by the higher-level managed RAG seam. */
export const FAQ_RAG_CONTRACT_VERSION = 'remote-v1' as const;

export const FAQ_RAG_ERROR_CODES = [
  'no_match',
  'expired_token',
  'quota_exceeded',
  'kill_switch',
  'invalid_contract',
  'deadline_exceeded',
  'retrieval_failed',
  'generation_failed',
  'busy',
] as const;

export type FaqRagErrorCode = (typeof FAQ_RAG_ERROR_CODES)[number];

export type FaqRagError =
  | { code: 'no_match'; retryable: false }
  | { code: 'expired_token'; retryable: true }
  | { code: 'quota_exceeded'; retryable: true; retryAfterMs: number }
  | { code: 'busy'; retryable: true; retryAfterMs: number }
  | { code: 'kill_switch'; retryable: true }
  | { code: 'invalid_contract'; retryable: false }
  | { code: 'deadline_exceeded'; retryable: true }
  | { code: 'retrieval_failed'; retryable: true }
  | { code: 'generation_failed'; retryable: true };

export interface FaqRagErrorResponse {
  contractVersion: typeof FAQ_RAG_CONTRACT_VERSION;
  ok: false;
  error: FaqRagError;
}

export interface FaqRagRetrieveRequest {
  contractVersion: typeof FAQ_RAG_CONTRACT_VERSION;
  question: string;
  hints?: FaqRetrievalHints;
  /** End-to-end budget remaining when this operation is dispatched. */
  remainingMs: number;
}

export interface FaqRagRetrieveSuccess {
  contractVersion: typeof FAQ_RAG_CONTRACT_VERSION;
  ok: true;
  /** Random, short-lived, non-semantic value. Clients must treat it as opaque. */
  sessionToken: string;
  expiresAtEpochMs: number;
}

export type FaqRagRetrieveResponse = FaqRagRetrieveSuccess | FaqRagErrorResponse;

export interface FaqRagGenerateMessage {
  role: 'user';
  content: string;
}

export interface FaqRagGenerateRequest {
  contractVersion: typeof FAQ_RAG_CONTRACT_VERSION;
  sessionToken: string;
  idempotencyKey: string;
  /** Bare, sanitized question used to bind this request to the retrieval session. */
  currentQuestion: string;
  /** One post-sanitization user message; it may include serialized prior user turns. */
  messages: [FaqRagGenerateMessage];
  /** End-to-end budget remaining when this operation is dispatched. */
  remainingMs: number;
}

export interface FaqRagSource {
  entryId: string;
  topic: string;
  url?: string;
}

/** Final public FAQ response. Raw model output and retrieval details never cross this seam. */
export interface FaqRagPublicResponse {
  answer: string;
  answerable: boolean;
  sources: FaqRagSource[];
  responseType: 'kb_answer' | 'refuse';
  scopeFallback?: true;
  failureKind?: 'envelope_invalid';
  retryable?: true;
}

export interface FaqRagGenerateSuccess {
  contractVersion: typeof FAQ_RAG_CONTRACT_VERSION;
  ok: true;
  response: FaqRagPublicResponse;
}

export type FaqRagGenerateResponse = FaqRagGenerateSuccess | FaqRagErrorResponse;

/** Invocation-local transport observation; never serialized into the wire DTO. */
export interface FaqRagHttpObservation {
  operation: 'retrieve' | 'generate' | 'answer';
  status: number;
  /** API Gateway request ID only; no payload, session or idempotency data. */
  requestId?: string;
}

/** Invocation-local transport observation; never serialized into the wire DTO. */
export interface FaqRagCallContext {
  onHttpRequest?: () => void;
  onHttpResponse?: (observation: FaqRagHttpObservation) => void;
}

/**
 * Higher-level boundary for a managed retrieval + answer operation.
 *
 * This is deliberately separate from FaqPorts. The low-level ports contain KB blocks,
 * prompt policy and callbacks that are safe only inside the server process.
 */
export interface FaqRagPort {
  retrieve(request: FaqRagRetrieveRequest, context?: FaqRagCallContext): Promise<FaqRagRetrieveResponse>;
  generate(request: FaqRagGenerateRequest, context?: FaqRagCallContext): Promise<FaqRagGenerateResponse>;
}
