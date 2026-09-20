/** Invocation-scoped processing capacity. No persistence details cross this port. */
export type FaqInflightLease =
  | { kind: 'acquired'; slot: number; release(): Promise<void> }
  | { kind: 'busy' }
  | { kind: 'disabled' };

export interface FaqInflightPort {
  /** The Lambda's actual remaining lifetime, without the response budget reserve. */
  acquire(remainingMs: number): Promise<FaqInflightLease>;
}

/** Local/free compositions without a state store never consume capacity. */
export const disabledFaqInflightPort: FaqInflightPort = {
  async acquire() { return { kind: 'disabled' }; },
};
