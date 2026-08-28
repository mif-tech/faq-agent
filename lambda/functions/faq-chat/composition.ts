import {
  createProductionFaqAdapters,
  createProductionRemoteFaqRagPort,
} from './adapters/production.js';
import { createFreeFaqPorts } from './adapters/free/index.js';
import type { FaqPorts } from './ports/index.js';
import type { FaqRagPort } from './ports/rag.js';
import type { FaqAgentConfigPort } from './ports/storage.js';

export type { FaqPorts } from './ports/index.js';

export interface FaqComposition {
  ports: FaqPorts;
  remoteRag?: FaqRagPort;
}

const unavailableAgentConfig: FaqAgentConfigPort = {
  async resolveAgentProfile() {
    return null;
  },
};

export function createProductionFaqPorts(): FaqPorts {
  return createProductionFaqAdapters();
}

export function createFaqComposition(): FaqComposition {
  const profile = process.env.FAQ_PORTS_PROFILE ?? 'production';
  if (profile === 'production') return { ports: createProductionFaqPorts() };
  if (profile === 'free') {
    // The canonical free profile changes retrieval/generation only. Settings and Q&A logs
    // retain the production storage/config contract. The public overlay supplies its lite
    // storage and named-agent resolver; canonical production keeps the resolver fail closed.
    const { storage, agentConfig } = createProductionFaqPorts();
    return { ports: { ...createFreeFaqPorts(), storage, agentConfig } };
  }
  if (profile === 'remote') {
    if (!process.env.FAQ_REMOTE_RAG_BASE_URL?.trim()) {
      throw new Error('FAQ_REMOTE_RAG_BASE_URL is required for FAQ_PORTS_PROFILE=remote');
    }
    // The shell keeps production storage and smalltalk guards. Only the retrieval -> prompt ->
    // generation -> public-envelope core crosses the higher-level remote RAG boundary.
    const ports = createProductionFaqPorts();
    return {
      // remote-v1契約はagentIdを持たないため、named routeを有効にするとKB境界を強制できない。
      // 契約を拡張するまでは構成上404へ閉じ、default remoteだけを従来どおり提供する。
      ports: { ...ports, agentConfig: unavailableAgentConfig },
      remoteRag: createProductionRemoteFaqRagPort(),
    };
  }
  throw new Error(`Unsupported FAQ_PORTS_PROFILE: ${profile}`);
}

/** Backward-compatible low-level port factory used by tests and non-Lambda embeddings. */
export function createFaqPorts(): FaqPorts {
  return createFaqComposition().ports;
}
