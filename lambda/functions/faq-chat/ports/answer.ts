import type {
  FAQ_RAG_ANSWER_CONTRACT_VERSION,
  RemoteOneShotAnswerRequest,
  RemoteOneShotAnswerResponse,
} from '../adapters/remote/answer-contract.js';
import type { FaqRagCallContext } from './rag.js';

/** Local transport diagnosis. This error is never an accepted server wire DTO. */
export interface FaqRagAnswerTransportUnsupported {
  contractVersion: typeof FAQ_RAG_ANSWER_CONTRACT_VERSION;
  ok: false;
  error: { code: 'remote_transport_unsupported'; retryable: false };
}

export type FaqRagAnswerResult = RemoteOneShotAnswerResponse | FaqRagAnswerTransportUnsupported;

/** A single signed answer operation; no retrieval session or implicit fallback. */
export interface FaqRagAnswerPort {
  answer(request: RemoteOneShotAnswerRequest, context?: FaqRagCallContext): Promise<FaqRagAnswerResult>;
}
