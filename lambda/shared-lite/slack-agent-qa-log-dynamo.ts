import { PutCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { liteDocumentClient } from '../functions/faq-chat/infra/lite-dynamodb.js';
import type {
  SlackAgentQaLogEntry,
  SlackAgentQaLogRef,
  SlackAgentQaLogSaveResult,
  SlackAgentQaLogWriteOptions,
} from '../shared/public/slack-agent-contract.js';
import type { SlackQaLogPort } from '../shared/public/slack-agent-ports.js';

const QA_LOG_RETENTION_SECONDS = 180 * 24 * 60 * 60;

function isConditionalFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'ConditionalCheckFailedException'
  );
}

/** Lite Slack edition writer. Its table has sourceEventId as the sole primary key. */
export class LiteDynamoSlackAgentQaLogWriter
  implements SlackQaLogPort<'slack'>
{
  constructor(
    private readonly tableName: string,
    private readonly expectedAgentId: string,
    private readonly documentClient: DynamoDBDocumentClient = liteDocumentClient
  ) {
    if (!tableName.trim()) throw new Error('Slack Q&A log table name is required');
    if (!expectedAgentId.trim()) throw new Error('Slack agent ID is required');
  }

  async saveGenerated(
    entry: SlackAgentQaLogEntry<'slack'>,
    options?: SlackAgentQaLogWriteOptions
  ): Promise<SlackAgentQaLogSaveResult<'slack'>> {
    this.assertBoundary(entry);
    const createdAtMs = Date.parse(entry.createdAt);
    if (!Number.isFinite(createdAtMs)) {
      throw new Error('Slack Q&A log createdAt is invalid');
    }

    const ref: SlackAgentQaLogRef<'slack'> = {
      agentId: entry.agentId,
      trustClass: entry.trustClass,
      sourceEventId: entry.sourceEventId,
    };
    try {
      await this.documentClient.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            ...entry,
            ttl: Math.floor(createdAtMs / 1000) + QA_LOG_RETENTION_SECONDS,
          },
          ConditionExpression:
            'attribute_not_exists(#sourceEventId) OR #deliveryStatus = :generated',
          ExpressionAttributeNames: {
            '#sourceEventId': 'sourceEventId',
            '#deliveryStatus': 'deliveryStatus',
          },
          ExpressionAttributeValues: {
            ':generated': 'generated',
          },
        }),
        { abortSignal: options?.abortSignal }
      );
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      return { ref, skipped: true };
    }

    return { ref, skipped: false };
  }

  async markPosted(
    input: {
      ref: SlackAgentQaLogRef<'slack'>;
      slackMessageTs: string;
      postedAt: string;
    },
    options?: SlackAgentQaLogWriteOptions
  ): Promise<void> {
    this.assertBoundary(input.ref);
    await this.documentClient.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { sourceEventId: input.ref.sourceEventId },
        UpdateExpression:
          'SET #deliveryStatus = :posted, slackMessageTs = :slackMessageTs, postedAt = :postedAt',
        ConditionExpression:
          'attribute_exists(#sourceEventId) AND #agentId = :agentId AND ' +
          '#trustClass = :trustClass AND #deliveryStatus = :generated',
        ExpressionAttributeNames: {
          '#sourceEventId': 'sourceEventId',
          '#agentId': 'agentId',
          '#trustClass': 'trustClass',
          '#deliveryStatus': 'deliveryStatus',
        },
        ExpressionAttributeValues: {
          ':agentId': input.ref.agentId,
          ':trustClass': input.ref.trustClass,
          ':generated': 'generated',
          ':posted': 'posted',
          ':slackMessageTs': input.slackMessageTs,
          ':postedAt': input.postedAt,
        },
      }),
      { abortSignal: options?.abortSignal }
    );
  }

  private assertBoundary(input: SlackAgentQaLogRef<'slack'>): void {
    if (input.agentId !== this.expectedAgentId || input.trustClass !== 'slack') {
      throw new Error('Slack Q&A log writer trust boundary mismatch');
    }
  }
}
