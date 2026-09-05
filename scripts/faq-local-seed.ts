/**
 * FAQ ローカル試用データを DynamoDB Local に投入する。
 *
 * 接続先・テーブル prefix・資格情報は意図的に固定し、ユーザーの AWS profile や
 * 実 AWS DynamoDB に接続しない。PutItem の主キーも固定なので再実行は上書きとなる。
 */
import { readFile } from 'node:fs/promises';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import type { FaqChatSettings } from '../lambda/functions/faq-chat/ports/storage.js';

const LOCAL_DYNAMODB_ENDPOINT = 'http://localhost:8000';
const LOCAL_REGION = 'us-west-2';
const TABLE_PREFIX = 'local-dev';
const KNOWLEDGE_TABLE = `${TABLE_PREFIX}-KnowledgeEntries`;
const SETTINGS_TABLE = `${TABLE_PREFIX}-Settings`;
const SAMPLE_KB_URL = new URL(
  '../lambda/eval/faq-chat/sample-kb.json',
  import.meta.url
);

interface SampleKnowledgeEntry {
  id: string;
  topic: string;
  content: string;
  canonicalUrl?: string;
}

/** Public/local projection only; intentionally independent from the canonical shared model. */
interface PublicKnowledgeSeedRow {
  agentId: 'default';
  entryId: string;
  topicKey: string;
  topic: string;
  changeType: 'add';
  category: 'other';
  answer: string;
  label: 'kb-cat-other';
  status: 'active';
  version: 1;
  source: 'self-update';
  canonicalUrl?: string;
  contentKind: 'document';
  visibility: 'public';
  syncStatus: 'synced';
  syncId: 'kb-cat-other';
  syncedAt: string;
  createdAt: string;
  updatedAt: string;
}

interface FaqSettingSeedRow {
  key: 'faq_chat';
  value: FaqChatSettings;
  updatedAt: string;
}

function parseSampleKnowledgeEntries(value: unknown): SampleKnowledgeEntry[] {
  if (!Array.isArray(value)) {
    throw new Error('sample-kb.json must contain an array');
  }

  return value.map((candidate, index) => {
    if (candidate === null || typeof candidate !== 'object') {
      throw new Error(`sample-kb.json entry ${index} must be an object`);
    }
    const entry = candidate as Record<string, unknown>;
    if (
      typeof entry.id !== 'string' ||
      entry.id.length === 0 ||
      typeof entry.topic !== 'string' ||
      entry.topic.length === 0 ||
      typeof entry.content !== 'string' ||
      entry.content.length === 0 ||
      (entry.canonicalUrl !== undefined && typeof entry.canonicalUrl !== 'string')
    ) {
      throw new Error(`sample-kb.json entry ${index} has an invalid shape`);
    }
    return {
      id: entry.id,
      topic: entry.topic,
      content: entry.content,
      ...(entry.canonicalUrl === undefined
        ? {}
        : { canonicalUrl: entry.canonicalUrl }),
    };
  });
}

// repositories/kbUpdateProposals.ts の normalizeTopic と同じ正規化。
function normalizeTopic(topic: string): string {
  return topic
    .replace(/\s+/g, '')
    .replace(/[（）()・/-]/g, '')
    .toLowerCase()
    .slice(0, 24);
}

const dynamodb = new DynamoDBClient({
  endpoint: LOCAL_DYNAMODB_ENDPOINT,
  region: LOCAL_REGION,
  credentials: {
    accessKeyId: 'local',
    secretAccessKey: 'local',
  },
});
const documentClient = DynamoDBDocumentClient.from(dynamodb, {
  marshallOptions: { removeUndefinedValues: true },
});

async function main(): Promise<void> {
  const sampleEntries = parseSampleKnowledgeEntries(
    JSON.parse(await readFile(SAMPLE_KB_URL, 'utf8')) as unknown
  );
  const now = new Date().toISOString();

  for (const sample of sampleEntries) {
    const knowledgeEntry = {
      agentId: 'default',
      entryId: sample.id,
      topicKey: normalizeTopic(sample.topic),
      topic: sample.topic,
      changeType: 'add',
      category: 'other',
      answer: sample.content,
      label: 'kb-cat-other',
      status: 'active',
      version: 1,
      source: 'self-update',
      ...(sample.canonicalUrl === undefined
        ? {}
        : { canonicalUrl: sample.canonicalUrl }),
      contentKind: 'document',
      visibility: 'public',
      syncStatus: 'synced',
      syncId: 'kb-cat-other',
      syncedAt: now,
      createdAt: now,
      updatedAt: now,
    } satisfies PublicKnowledgeSeedRow;

    await documentClient.send(
      new PutCommand({
        TableName: KNOWLEDGE_TABLE,
        Item: knowledgeEntry,
      })
    );
    console.log(`[OK] Seeded FAQ knowledge entry: ${sample.id}`);
  }

  const faqChatSetting = {
    key: 'faq_chat',
    value: {
      enabled: true,
      smalltalkMode: 'template_only',
      fallbackMessage:
        '申し訳ありません。こちらの質問にはお答えできる情報がありません。',
    },
    updatedAt: now,
  } satisfies FaqSettingSeedRow;

  await documentClient.send(
    new PutCommand({
      TableName: SETTINGS_TABLE,
      Item: faqChatSetting,
    })
  );
  console.log("[OK] Seeded setting: faq_chat");
  console.log(
    `[OK] FAQ local seed complete (${sampleEntries.length} entries, endpoint ${LOCAL_DYNAMODB_ENDPOINT})`
  );
}

main()
  .catch((error: unknown) => {
    console.error('[ERROR] Failed to seed FAQ local data:', error);
    process.exitCode = 1;
  })
  .finally(() => dynamodb.destroy());
