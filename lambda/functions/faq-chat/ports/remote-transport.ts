import type { FaqRagAnswerPort } from './answer.js';
import type { FaqRagPort } from './rag.js';

export type RemoteFaqTransport =
  | { kind: 'split-v1'; port: FaqRagPort }
  | { kind: 'one-shot-v1'; port: FaqRagAnswerPort };

/** Deployment configuration, read only when composing FAQ_PORTS_PROFILE=remote. */
export function readRemoteFaqTransport(
  env: Readonly<Record<string, string | undefined>> = process.env
): RemoteFaqTransport['kind'] {
  const transport = env.FAQ_REMOTE_RAG_TRANSPORT;
  if (transport === undefined) return 'split-v1';
  if (transport === 'split-v1' || transport === 'one-shot-v1') return transport;
  throw new Error('Invalid FAQ_REMOTE_RAG_TRANSPORT: expected split-v1 or one-shot-v1');
}
