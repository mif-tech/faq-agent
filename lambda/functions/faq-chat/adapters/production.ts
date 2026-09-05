import { createFreeFaqPorts } from './free/index.js';
import { dynamoDbFaqAgentConfig } from './free/agent-config.js';
import { dynamoDbFaqKbSource } from './free/dynamodb-entries.js';
import type { FaqPorts } from '../ports/index.js';
import type { FaqChatSettings, FaqStoragePort } from '../ports/storage.js';
import { getItem, LiteTableNames, putItem } from '../infra/lite-dynamodb.js';
import { createRemoteFaqRagHttpClient } from './remote/http-client.js';
import { notifyFaqQaLog } from './faq-qa-slack-notify.js';

interface FaqSettingRow {
  key: string;
  value: FaqChatSettings;
  updatedAt?: string;
}

export type ProductionFaqAdapters = FaqPorts;

export function createProductionRemoteFaqRagPort() {
  return createRemoteFaqRagHttpClient();
}

const storage: FaqStoragePort = {
  async loadSettings() {
    const item = await getItem<FaqSettingRow>(LiteTableNames.Settings, {
      key: 'faq_chat',
    });
    return item?.value ?? null;
  },

  async putQaLog(record) {
    await putItem(LiteTableNames.FaqQaLogs, { ...record }, {
      conditionExpression: 'attribute_not_exists(#ts)',
      expressionAttributeNames: { '#ts': 'ts' },
    });
  },

  async notifyQaLog(record, timeoutMs) {
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
