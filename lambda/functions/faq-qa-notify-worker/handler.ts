import { randomUUID } from 'node:crypto';
import type { Context, DynamoDBBatchResponse, DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { FaqQaLogRecord } from '../faq-chat/ports/storage.js';
import {
  notifyFaqQaLog, STREAM_NOTIFY_TIMEOUT_MS, type FaqQaNotifyOutcome,
} from '../faq-chat/adapters/faq-qa-slack-notify.js';

// Longer than the entire Lambda timeout (15s), including the bounded Slack send.
// A crashed owner becomes retryable without overlapping a still-running sender.
export const NOTIFY_LEASE_MS = 60_000;
// Keep time for the owner-fenced completion write after the bounded Slack send.
export const COMPLETE_RESERVE_MS = 2_000;
type WorkerContext = Pick<Context, 'getRemainingTimeInMillis'>;
type QaKey = Pick<FaqQaLogRecord, 'dateBucket' | 'ts'>;
type Claim = { state: 'claimed'; record: FaqQaLogRecord } | { state: 'sent' } | { state: 'busy' };

export interface FaqQaNotifyStore {
  claim(key: QaKey, owner: string, nowMs: number, sequence: string): Promise<Claim>;
  complete(key: QaKey, owner: string): Promise<void>;
  release(key: QaKey, owner: string): Promise<void>;
}

function isConditionalFailure(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException';
}

/** Delivery state belongs to the retained QA row; there is no private archive dependency. */
export function createDynamoNotifyStore(
  client: Pick<DynamoDBDocumentClient, 'send'>,
  tableName: string
): FaqQaNotifyStore {
  const names = {
    '#ts': 'ts', '#delivery': 'qaNotifyDelivery', '#status': 'qaNotifyStatus',
    '#owner': 'qaNotifyOwner', '#lease': 'qaNotifyLeaseUntil',
  };
  return {
    async claim(key, owner, nowMs, sequence) {
      try {
        const result = await client.send(new UpdateCommand({
          TableName: tableName,
          Key: key,
          ConditionExpression: 'attribute_exists(#ts) AND #delivery = :async AND ' +
            '(attribute_not_exists(#status) OR (#status = :sending AND #lease <= :now))',
          UpdateExpression: 'SET #status = :sending, #owner = :owner, #lease = :lease, ' +
            'qaNotifySequenceNumber = :sequence',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: {
            ':async': 'async-v1', ':sending': 'sending', ':owner': owner,
            ':now': nowMs, ':lease': nowMs + NOTIFY_LEASE_MS, ':sequence': sequence,
          },
          ReturnValues: 'ALL_NEW',
        }));
        if (!result.Attributes) throw new Error('QA_NOTIFY_MISSING_ROW');
        return { state: 'claimed', record: result.Attributes as FaqQaLogRecord };
      } catch (error) {
        if (!isConditionalFailure(error)) throw error;
        const result = await client.send(new GetCommand({
          TableName: tableName, Key: key, ConsistentRead: true,
        }));
        // A missing/deleted/changed row is a delivery failure, never a successful ACK.
        if (result.Item?.qaNotifyDelivery !== 'async-v1') throw new Error('QA_NOTIFY_MISSING_ROW');
        return { state: result.Item.qaNotifyStatus === 'sent' ? 'sent' : 'busy' };
      }
    },
    async complete(key, owner) {
      await client.send(new UpdateCommand({
        TableName: tableName, Key: key,
        ConditionExpression: '#status = :sending AND #owner = :owner',
        UpdateExpression: 'SET #status = :sent REMOVE #owner, #lease',
        ExpressionAttributeNames: {
          '#status': names['#status'], '#owner': names['#owner'], '#lease': names['#lease'],
        },
        ExpressionAttributeValues: { ':sending': 'sending', ':sent': 'sent', ':owner': owner },
      }));
    },
    async release(key, owner) {
      await client.send(new UpdateCommand({
        TableName: tableName, Key: key,
        ConditionExpression: '#status = :sending AND #owner = :owner',
        UpdateExpression: 'SET #lease = :expired',
        ExpressionAttributeNames: {
          '#status': names['#status'], '#owner': names['#owner'], '#lease': names['#lease'],
        },
        ExpressionAttributeValues: { ':sending': 'sending', ':owner': owner, ':expired': 0 },
      }));
    },
  };
}

function streamKey(record: DynamoDBRecord): QaKey {
  const dateBucket = record.dynamodb?.Keys?.dateBucket?.S;
  const ts = record.dynamodb?.Keys?.ts?.S;
  if (!dateBucket || !ts) throw new Error('QA_NOTIFY_INVALID_KEY');
  return { dateBucket, ts };
}

export function createFaqQaNotifyWorker(dependencies: {
  store: FaqQaNotifyStore;
  send: (record: FaqQaLogRecord, budgetMs: number) => Promise<FaqQaNotifyOutcome>;
  now?: () => number;
  owner?: () => string;
}) {
  const { store, send, now = Date.now, owner = randomUUID } = dependencies;
  return async (event: DynamoDBStreamEvent, context?: WorkerContext): Promise<DynamoDBBatchResponse> => {
    const batchItemFailures: DynamoDBBatchResponse['batchItemFailures'] = [];
    for (const record of event.Records) {
      // Defense in depth for manual invocation and filter changes. Never notify
      // MODIFY/REMOVE, historical rows, or rows owned by the synchronous sender.
      if (record.eventName !== 'INSERT' ||
          record.dynamodb?.NewImage?.qaNotifyDelivery?.S !== 'async-v1') continue;
      const sequence = record.dynamodb?.SequenceNumber;
      try {
        if (!sequence) throw new Error('QA_NOTIFY_MISSING_SEQUENCE');
        const key = streamKey(record);
        const claimOwner = owner();
        const claim = await store.claim(key, claimOwner, now(), sequence);
        if (claim.state === 'sent') {
          console.info('faq_qa_notify_worker outcome=duplicate');
          continue;
        }
        if (claim.state === 'busy') throw new Error('QA_NOTIFY_BUSY');
        let delivered = false;
        try {
          // Claim latency consumes the invocation budget too. Read the remaining
          // time only after claiming so a slow claim cannot steal completion time.
          const budgetMs = context
            ? Math.max(0, Math.min(STREAM_NOTIFY_TIMEOUT_MS,
              context.getRemainingTimeInMillis() - COMPLETE_RESERVE_MS))
            : STREAM_NOTIFY_TIMEOUT_MS;
          if (budgetMs <= 0) throw new Error('QA_NOTIFY_BUDGET_EXHAUSTED');
          const result = await send(claim.record, budgetMs);
          if (result !== 'success') throw new Error('QA_NOTIFY_SEND_FAILED');
          delivered = true;
          // Slack Incoming Webhooks cannot atomically commit this marker. A crash
          // or ambiguous HTTP result around delivery may cause a duplicate retry.
          await store.complete(key, claimOwner);
        } catch (error) {
          // Keep the lease after a successful send if its commit is ambiguous.
          if (!delivered) await store.release(key, claimOwner);
          throw error;
        }
        console.info('faq_qa_notify_worker outcome=success');
      } catch {
        // Fixed fields only: SDK/fetch errors may contain a URL or stored content.
        console.warn('faq_qa_notify_worker outcome=failure');
        // Without a stream sequence there is no valid partial failure identifier.
        // Reject the invocation so the malformed record is never silently ACKed.
        if (!sequence) throw new Error('QA_NOTIFY_MISSING_SEQUENCE');
        batchItemFailures.push({ itemIdentifier: sequence });
      }
    }
    return { batchItemFailures };
  };
}

function workerTableName(): string {
  const prefix = process.env.FAQ_TABLE_NAME_PREFIX;
  const table = process.env.FAQ_QA_LOGS_TABLE_NAME;
  if (!prefix || prefix !== prefix.trim() || !table ||
      !/^[A-Za-z0-9_.-]{3,255}$/u.test(table) || table !== `${prefix}-FaqQaLogs`) {
    throw new Error('QA_NOTIFY_INVALID_TABLE_CONFIGURATION');
  }
  return table;
}

let productionWorker: ReturnType<typeof createFaqQaNotifyWorker> | undefined;
export async function handler(event: DynamoDBStreamEvent, context?: WorkerContext): Promise<DynamoDBBatchResponse> {
  if (!productionWorker) {
    const table = workerTableName();
    const client = DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 2 }));
    productionWorker = createFaqQaNotifyWorker({
      store: createDynamoNotifyStore(client, table),
      send: (record, budgetMs) => notifyFaqQaLog(record, budgetMs, 'stream'),
    });
  }
  return productionWorker(event, context);
}
