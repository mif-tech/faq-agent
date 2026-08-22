/** Create only the three tables used by the standalone FAQ sample. */
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  UpdateTimeToLiveCommand,
  type CreateTableCommandInput,
} from '@aws-sdk/client-dynamodb';
import { pathToFileURL } from 'node:url';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';
const region = process.env.AWS_REGION ?? 'us-west-2';
const tablePrefix = process.env.DYNAMODB_TABLE_PREFIX ?? 'dev';

const endpointUrl = new URL(endpoint);
if (!['localhost', '127.0.0.1', 'dynamodb-local'].includes(endpointUrl.hostname)) {
  throw new Error(
    `Refusing to initialize a non-local DynamoDB endpoint: ${endpointUrl.hostname}`
  );
}

const client = new DynamoDBClient({
  endpoint,
  region,
  credentials: {
    accessKeyId: 'local',
    secretAccessKey: 'local',
  },
});

export const faqTableDefinitions: CreateTableCommandInput[] = [
  {
    TableName: `${tablePrefix}-Settings`,
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [{ AttributeName: 'key', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'key', AttributeType: 'S' }],
  },
  {
    TableName: `${tablePrefix}-KnowledgeEntries`,
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [{ AttributeName: 'entryId', KeyType: 'HASH' }],
    AttributeDefinitions: [
      { AttributeName: 'entryId', AttributeType: 'S' },
      { AttributeName: 'topicKey', AttributeType: 'S' },
      { AttributeName: 'syncQueueStatus', AttributeType: 'S' },
      { AttributeName: 'updatedAt', AttributeType: 'S' },
      { AttributeName: 'category', AttributeType: 'S' },
      { AttributeName: 'status', AttributeType: 'S' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'topicKey-index',
        KeySchema: [{ AttributeName: 'topicKey', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: 'syncQueueStatus-updatedAt-index',
        KeySchema: [
          { AttributeName: 'syncQueueStatus', KeyType: 'HASH' },
          { AttributeName: 'updatedAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: 'category-status-index',
        KeySchema: [
          { AttributeName: 'category', KeyType: 'HASH' },
          { AttributeName: 'status', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  },
  {
    TableName: `${tablePrefix}-FaqQaLogs`,
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [
      { AttributeName: 'dateBucket', KeyType: 'HASH' },
      { AttributeName: 'ts', KeyType: 'RANGE' },
    ],
    AttributeDefinitions: [
      { AttributeName: 'dateBucket', AttributeType: 'S' },
      { AttributeName: 'ts', AttributeType: 'S' },
    ],
  },
];

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

async function tableExists(tableName: string): Promise<boolean> {
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    return true;
  } catch (error) {
    if (errorName(error) === 'ResourceNotFoundException') return false;
    throw error;
  }
}

async function waitUntilActive(tableName: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await client.send(new DescribeTableCommand({ TableName: tableName }));
    if (result.Table?.TableStatus === 'ACTIVE') return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${tableName} to become ACTIVE`);
}

async function ensureTable(definition: CreateTableCommandInput): Promise<void> {
  const tableName = definition.TableName;
  if (!tableName) throw new Error('FAQ table definition is missing TableName');

  if (await tableExists(tableName)) {
    console.log(`[SKIP] ${tableName} already exists`);
  } else {
    await client.send(new CreateTableCommand(definition));
    console.log(`[OK] Created ${tableName}`);
  }
  await waitUntilActive(tableName);
}

async function enableFaqLogTtl(): Promise<void> {
  const tableName = `${tablePrefix}-FaqQaLogs`;
  try {
    await client.send(
      new UpdateTimeToLiveCommand({
        TableName: tableName,
        TimeToLiveSpecification: {
          AttributeName: 'ttl',
          Enabled: true,
        },
      })
    );
    console.log(`[OK] Enabled ttl on ${tableName}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/already enabled|TimeToLive is already enabled/i.test(message)) {
      console.log(`[SKIP] ttl already enabled on ${tableName}`);
      return;
    }
    throw error;
  }
}

async function main(): Promise<void> {
  for (const definition of faqTableDefinitions) {
    await ensureTable(definition);
  }
  await enableFaqLogTtl();
  console.log(`[OK] FAQ tables are ready at ${endpoint}`);
}

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  main()
    .catch((error: unknown) => {
      console.error('[ERROR] Failed to initialize FAQ tables:', error);
      process.exitCode = 1;
    })
    .finally(() => client.destroy());
}
