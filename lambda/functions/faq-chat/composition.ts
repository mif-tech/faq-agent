import { createProductionFaqAdapters } from './adapters/production.js';
import { createFreeFaqPorts } from './adapters/free/index.js';
import type { FaqPorts } from './ports/index.js';

export type { FaqPorts } from './ports/index.js';

export function createProductionFaqPorts(): FaqPorts {
  return createProductionFaqAdapters();
}

export function createFaqPorts(): FaqPorts {
  const profile = process.env.FAQ_PORTS_PROFILE ?? 'production';
  if (profile === 'production') return createProductionFaqPorts();
  if (profile === 'free') {
    // The canonical free profile changes retrieval/generation only. Settings and Q&A logs
    // retain the production storage contract. The public overlay supplies its lite storage.
    const { storage } = createProductionFaqPorts();
    return { ...createFreeFaqPorts(), storage };
  }
  throw new Error(`Unsupported FAQ_PORTS_PROFILE: ${profile}`);
}
