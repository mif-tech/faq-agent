import { randomUUID } from 'node:crypto';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { disabledFaqInflightPort, type FaqInflightPort } from '../ports/inflight.js';

export function readFaqMaxInflight(environment: NodeJS.ProcessEnv = process.env): number {
  const raw = environment.FAQ_MAX_INFLIGHT;
  if (raw === undefined) return 0;
  if (!/^(?:[0-9]|10)$/.test(raw)) {
    throw new Error('FAQ_MAX_INFLIGHT must be an integer from 0 through 10');
  }
  return Number(raw);
}

function conditionalConflict(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException';
}

/** Settings already uses key/value rows and has no TTL: expiry is compared in the condition. */
export function createDynamoFaqInflightPort(options: {
  client: { send(command: UpdateCommand): Promise<unknown> };
  tableName: string;
  maxInflight?: number;
  now?: () => number;
  ownerToken?: () => string;
}): FaqInflightPort {
  const maxInflight = options.maxInflight ?? readFaqMaxInflight();
  if (!Number.isSafeInteger(maxInflight) || maxInflight < 0 || maxInflight > 10) {
    throw new Error('FAQ_MAX_INFLIGHT must be an integer from 0 through 10');
  }
  if (maxInflight === 0) return disabledFaqInflightPort;
  const now = options.now ?? Date.now;
  const ownerToken = options.ownerToken ?? randomUUID;
  return {
    async acquire(remainingMs) {
      if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
        throw new Error('FAQ inflight lease requires the Lambda remaining lifetime');
      }
      const startedAt = now();
      const token = ownerToken();
      const leaseUntil = startedAt + Math.ceil(remainingMs);
      // Spread first attempts across slots while keeping each owner's scan deterministic.
      const offset = [...token].reduce((value, character) => (value * 31 + character.charCodeAt(0)) % maxInflight, 0);
      for (let attempt = 0; attempt < maxInflight; attempt += 1) {
        const slot = (offset + attempt) % maxInflight;
        const key = { key: `faq_inflight_slot#${slot}` };
        try {
          await options.client.send(new UpdateCommand({
            TableName: options.tableName,
            Key: key,
            UpdateExpression: 'SET #value = :lease',
            ConditionExpression: 'attribute_not_exists(#value.#leaseUntil) OR #value.#leaseUntil < :now',
            ExpressionAttributeNames: { '#value': 'value', '#leaseUntil': 'leaseUntil' },
            ExpressionAttributeValues: { ':lease': { ownerToken: token, leaseUntil }, ':now': startedAt },
          }));
        } catch (error) {
          if (conditionalConflict(error)) continue;
          throw error;
        }
        let released = false;
        return {
          kind: 'acquired',
          slot,
          async release() {
            if (released) return;
            released = true;
            try {
              await options.client.send(new UpdateCommand({
                TableName: options.tableName,
                Key: key,
                UpdateExpression: 'REMOVE #value.#leaseUntil',
                ConditionExpression: '#value.#ownerToken = :ownerToken',
                ExpressionAttributeNames: {
                  '#value': 'value', '#ownerToken': 'ownerToken', '#leaseUntil': 'leaseUntil',
                },
                ExpressionAttributeValues: { ':ownerToken': token },
              }));
            } catch (error) {
              // An expired lease may already belong to a newer invocation.
              if (!conditionalConflict(error)) throw error;
            }
          },
        };
      }
      return { kind: 'busy' };
    },
  };
}
