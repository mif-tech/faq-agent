/** Canonical Lambda composition root. Keep private adapter wiring out of handler.ts. */
import { createFaqPorts } from './composition.js';
import { createFaqHandler } from './handler.js';

export const handler = createFaqHandler(createFaqPorts());
