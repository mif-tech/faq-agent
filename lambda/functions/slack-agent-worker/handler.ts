import type { Context, SQSEvent } from 'aws-lambda';
import {
  LiteTableNames,
  liteDocumentClient,
} from '../faq-chat/infra/lite-dynamodb.js';
import {
  createLiteSlackAgentComposition,
  type LiteSlackTrustClass,
} from '../../shared-lite/slack-agent-composition.js';
import {
  runSlackAgentWorker,
  type SlackWorkerRuntimeConfig,
} from '../../shared/public/slack-worker-core.js';

interface WorkerEnvironment {
  runtime: SlackWorkerRuntimeConfig<LiteSlackTrustClass>;
  anthropicApiKey: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`[slack-agent-worker] ${name} is required`);
  return value;
}

export function loadWorkerEnvironment(): WorkerEnvironment {
  const trustClass = requiredEnv('TRUST_CLASS');
  if (trustClass !== 'slack') {
    throw new Error('[slack-agent-worker] TRUST_CLASS must be slack');
  }
  const kbTableName = requiredEnv('KB_TABLE_NAME');
  if (kbTableName !== LiteTableNames.KnowledgeEntries) {
    throw new Error(
      '[slack-agent-worker] KB_TABLE_NAME must match FAQ_KNOWLEDGE_ENTRIES_TABLE_NAME'
    );
  }
  // templateのredrive maxReceiveCountと同期する値。liteのtemplateは必ず'5'を渡すため、
  // 欠落・不正値は黙って既定へ補正せずfail closedにする（値がredriveとずれると
  // 最終失敗通知の重複や未通知DLQ行きになるため / 累積レビュー指摘）。
  const maxReceiveCount = Number(requiredEnv('QUEUE_MAX_RECEIVE_COUNT'));
  if (!Number.isInteger(maxReceiveCount) || maxReceiveCount < 1 || maxReceiveCount > 100) {
    throw new Error(
      '[slack-agent-worker] QUEUE_MAX_RECEIVE_COUNT must be an integer between 1 and 100'
    );
  }

  return {
    runtime: {
      agentId: requiredEnv('AGENT_ID'),
      trustClass,
      botToken: requiredEnv('SLACK_BOT_TOKEN'),
      botUserId: requiredEnv('EXPECTED_BOT_USER_ID'),
      idempotencyTableName: requiredEnv('IDEMPOTENCY_TABLE_NAME'),
      kbTableName,
      qaLogTableName: requiredEnv('SLACK_QA_LOG_TABLE_NAME'),
      maxReceiveCount,
    },
    anthropicApiKey: requiredEnv('ANTHROPIC_API_KEY'),
  };
}

export async function handler(event: SQSEvent, context: Context): Promise<void> {
  const environment = loadWorkerEnvironment();
  const composition = createLiteSlackAgentComposition(environment.runtime, {
    anthropicApiKey: environment.anthropicApiKey,
    documentClient: liteDocumentClient,
  });
  await runSlackAgentWorker({
    event,
    context,
    runtime: environment.runtime,
    composition,
    documentClient: liteDocumentClient,
  });
}
