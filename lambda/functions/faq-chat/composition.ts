import {
  createProductionFaqAdapters,
  createProductionRemoteFaqRagPort,
} from './adapters/production.js';
import { createFreeFaqPorts } from './adapters/free/index.js';
import type { FaqPorts } from './ports/index.js';
import type { FaqRagPort } from './ports/rag.js';

export type { FaqPorts } from './ports/index.js';

export interface FaqComposition {
  ports: FaqPorts;
  remoteRag?: FaqRagPort;
}

export function createProductionFaqPorts(): FaqPorts {
  return createProductionFaqAdapters();
}

export function createFaqComposition(): FaqComposition {
  const profile = process.env.FAQ_PORTS_PROFILE ?? 'production';
  if (profile === 'production') return { ports: createProductionFaqPorts() };
  if (profile === 'free') {
    // The canonical free profile changes retrieval/generation only. Settings and Q&A logs
    // retain the production storage contract. The public overlay supplies its lite storage.
    const { storage } = createProductionFaqPorts();
    return { ports: { ...createFreeFaqPorts(), storage } };
  }
  if (profile === 'remote') {
    if (!process.env.FAQ_REMOTE_RAG_BASE_URL?.trim()) {
      throw new Error('FAQ_REMOTE_RAG_BASE_URL is required for FAQ_PORTS_PROFILE=remote');
    }
    // The shell keeps production storage and smalltalk guards. Only the retrieval -> prompt ->
    // generation -> public-envelope core crosses the higher-level remote RAG boundary.
    return {
      ports: createProductionFaqPorts(),
      remoteRag: createProductionRemoteFaqRagPort(),
    };
  }
  throw new Error(`Unsupported FAQ_PORTS_PROFILE: ${profile}`);
}

/** Backward-compatible low-level port factory used by tests and non-Lambda embeddings. */
export function createFaqPorts(): FaqPorts {
  return createFaqComposition().ports;
}
