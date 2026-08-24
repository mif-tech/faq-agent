/** Canonical Lambda composition root. Keep private adapter wiring out of handler.ts. */
import { createFaqComposition } from './composition.js';
import { createFaqHandler } from './handler.js';

const composition = createFaqComposition();

export const handler = createFaqHandler(composition.ports, composition.remoteRag);
