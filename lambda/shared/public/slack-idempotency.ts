/**
 * Slack Events API / SQS at-least-once 配信用の冪等性 store。
 *
 * trust class ごとに物理テーブルを分離し、状態を received -> processing -> posted と進める。
 * processing には短い lease を持たせ、worker 失敗後の SQS 再試行が処理を取り戻せるようにする。
 */

import {
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { SlackAgentJob } from './slack-agent-contract.js';

export type SlackIdempotencyClaim = 'claimed' | 'posted' | 'busy';

interface SlackIdempotencyItem<TTrustClass extends string> {
  idempotencyKey: string;
  trustClass: TTrustClass;
  teamId: string;
  eventId: string;
  state: 'received' | 'processing' | 'posted';
  processingOwner?: string;
  leaseExpiresAt?: number;
  slackMessageTs?: string;
  createdAt: string;
  updatedAt: string;
  ttl: number;
}

const RETENTION_SECONDS = 14 * 24 * 60 * 60;
// Lambda timeout (60s) より長くし、同一eventの並行再処理を防ぐ。
const PROCESSING_LEASE_SECONDS = 90;

function isConditionalFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'ConditionalCheckFailedException'
  );
}

export function buildSlackIdempotencyKey<TTrustClass extends string>(input: {
  trustClass: TTrustClass;
  teamId: string;
  eventId: string;
}): string {
  return `${input.trustClass}#${input.teamId}#${input.eventId}`;
}

export class SlackIdempotencyStore<TTrustClass extends string> {
  constructor(
    private readonly documentClient: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly trustClass: TTrustClass,
    private readonly now: () => Date = () => new Date()
  ) {
    if (!tableName.trim()) throw new Error('Slack idempotency table name is required');
  }

  async claim(
    job: SlackAgentJob<TTrustClass>,
    processingOwner: string
  ): Promise<SlackIdempotencyClaim> {
    if (job.trustClass !== this.trustClass) {
      throw new Error('Slack idempotency store trust class mismatch');
    }
    if (!processingOwner.trim()) throw new Error('Slack processing owner is required');

    const key = buildSlackIdempotencyKey(job);
    const now = this.now();
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const nowIso = now.toISOString();
    const initial: SlackIdempotencyItem<TTrustClass> = {
      idempotencyKey: key,
      trustClass: job.trustClass,
      teamId: job.teamId,
      eventId: job.eventId,
      state: 'received',
      createdAt: nowIso,
      updatedAt: nowIso,
      ttl: nowSeconds + RETENTION_SECONDS,
    };

    try {
      await this.documentClient.send(
        new PutCommand({
          TableName: this.tableName,
          Item: initial,
          ConditionExpression: 'attribute_not_exists(#pk)',
          ExpressionAttributeNames: { '#pk': 'idempotencyKey' },
        })
      );
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
    }

    try {
      await this.documentClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { idempotencyKey: key },
          UpdateExpression:
            'SET #state = :processing, processingOwner = :owner, ' +
            'leaseExpiresAt = :lease, updatedAt = :updatedAt',
          ConditionExpression:
            '#trustClass = :trustClass AND #teamId = :teamId AND #eventId = :eventId AND ' +
            '(#state = :received OR (#state = :processing AND leaseExpiresAt < :now))',
          ExpressionAttributeNames: {
            '#state': 'state',
            '#trustClass': 'trustClass',
            '#teamId': 'teamId',
            '#eventId': 'eventId',
          },
          ExpressionAttributeValues: {
            ':processing': 'processing',
            ':received': 'received',
            ':owner': processingOwner,
            ':lease': nowSeconds + PROCESSING_LEASE_SECONDS,
            ':now': nowSeconds,
            ':updatedAt': nowIso,
            ':trustClass': job.trustClass,
            ':teamId': job.teamId,
            ':eventId': job.eventId,
          },
        })
      );
      return 'claimed';
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
    }

    const existing = await this.documentClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { idempotencyKey: key },
        ConsistentRead: true,
      })
    );
    const item = existing.Item as Partial<SlackIdempotencyItem<TTrustClass>> | undefined;
    if (!item) {
      throw new Error('Slack idempotency record disappeared while claiming');
    }
    if (
      item.trustClass !== job.trustClass ||
      item.teamId !== job.teamId ||
      item.eventId !== job.eventId
    ) {
      throw new Error('Slack idempotency record identity mismatch');
    }
    if (item.state === 'posted') return 'posted';
    if (item.state === 'received' || item.state === 'processing') return 'busy';
    throw new Error('Slack idempotency record has an invalid state');
  }

  async markPosted(
    job: SlackAgentJob<TTrustClass>,
    processingOwner: string,
    slackMessageTs: string
  ): Promise<void> {
    const key = buildSlackIdempotencyKey(job);
    const nowIso = this.now().toISOString();
    await this.documentClient.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { idempotencyKey: key },
        UpdateExpression:
          'SET #state = :posted, slackMessageTs = :slackMessageTs, postedAt = :postedAt, ' +
          'updatedAt = :updatedAt REMOVE processingOwner, leaseExpiresAt',
        ConditionExpression:
          '#state = :processing AND processingOwner = :owner AND #trustClass = :trustClass',
        ExpressionAttributeNames: {
          '#state': 'state',
          '#trustClass': 'trustClass',
        },
        ExpressionAttributeValues: {
          ':posted': 'posted',
          ':processing': 'processing',
          ':owner': processingOwner,
          ':trustClass': job.trustClass,
          ':slackMessageTs': slackMessageTs,
          ':postedAt': nowIso,
          ':updatedAt': nowIso,
        },
      })
    );
  }
}
