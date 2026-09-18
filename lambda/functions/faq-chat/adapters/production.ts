import { createFreeFaqPorts } from './free/index.js';
import { dynamoDbFaqAgentConfig } from './free/agent-config.js';
import { dynamoDbFaqKbSource } from './free/dynamodb-entries.js';
import type { FaqPorts } from '../ports/index.js';
import type { FaqChatSettings, FaqStoragePort } from '../ports/storage.js';
import { getItem, LiteTableNames, putItem } from '../infra/lite-dynamodb.js';
import { createRemoteFaqRagHttpClient } from './remote/http-client.js';
import { createRemoteFaqRagAnswerHttpClient } from './remote/http-client.js';
import { notifyFaqQaLog } from './faq-qa-slack-notify.js';
import { recordFaqQaNotifyOutcome } from '../shell-timing.js';

interface FaqSettingRow {
  key: string;
  value: FaqChatSettings;
  updatedAt?: string;
}

export type ProductionFaqAdapters = FaqPorts;

export function createProductionRemoteFaqRagPort() {
  return createRemoteFaqRagHttpClient();
}

export function createProductionRemoteFaqRagAnswerPort() {
  return createRemoteFaqRagAnswerHttpClient();
}

const storage: FaqStoragePort = {
  async loadSettings() {
    const item = await getItem<FaqSettingRow>(LiteTableNames.Settings, {
      key: 'faq_chat',
    });
    return item?.value ?? null;
  },

  async putQaLog(record) {
    // Persist delivery ownership with the record so toggling the flag cannot
    // make an old synchronous row send again, or strand pending async rows.
    const qaNotifyDelivery = !process.env.FAQ_QA_NOTIFY_WEBHOOK_URL?.trim()
      ? 'disabled'
      : process.env.FAQ_QA_NOTIFY_ASYNC_ENABLED === 'true' ? 'async-v1' : 'sync-v1';
    await putItem(LiteTableNames.FaqQaLogs, { ...record, qaNotifyDelivery }, {
      conditionExpression: 'attribute_not_exists(#ts)',
      expressionAttributeNames: { '#ts': 'ts' },
    });
  },

  async notifyQaLog(record, timeoutMs) {
    if (process.env.FAQ_QA_NOTIFY_ASYNC_ENABLED === 'true') {
      recordFaqQaNotifyOutcome(process.env.FAQ_QA_NOTIFY_WEBHOOK_URL?.trim() ? 'skipped' : 'disabled');
      return;
    }
    await notifyFaqQaLog(record, timeoutMs);
  },
};

/**
 * Keep the canonical export name so composition.ts works unchanged. In the public
 * distribution, "production" means the free adapter plus the standalone lite storage.
 */
export function createProductionFaqAdapters(): ProductionFaqAdapters {
  return {
    ...createFreeFaqPorts({ kbSource: dynamoDbFaqKbSource }),
    agentConfig: dynamoDbFaqAgentConfig,
    storage,
  };
}
