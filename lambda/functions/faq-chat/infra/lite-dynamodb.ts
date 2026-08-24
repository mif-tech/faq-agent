import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? '';
const region = process.env.AWS_REGION ?? 'us-west-2';

const DYNAMODB_TABLE_NAME_PATTERN = /^[A-Za-z0-9_.-]{3,255}$/u;
const TABLE_NAME_ENV = {
  Settings: 'FAQ_SETTINGS_TABLE_NAME',
  KnowledgeEntries: 'FAQ_KNOWLEDGE_ENTRIES_TABLE_NAME',
  FaqQaLogs: 'FAQ_QA_LOGS_TABLE_NAME',
} as const;
const TABLE_SUFFIX = {
  Settings: 'Settings',
  KnowledgeEntries: 'KnowledgeEntries',
  FaqQaLogs: 'FaqQaLogs',
} as const;

export interface LiteTableNameMap {
  Settings: string;
  KnowledgeEntries: string;
  FaqQaLogs: string;
}

function requiredEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string
): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be set to a non-empty value`);
  }
  if (value !== value.trim()) {
    throw new Error(`${name} must not contain leading or trailing whitespace`);
  }
  return value;
}

function validateTableName(name: string, value: string): void {
  if (!DYNAMODB_TABLE_NAME_PATTERN.test(value)) {
    throw new Error(
      `${name} must be a valid DynamoDB table name using 3-255 ` +
        'letters, digits, underscores, hyphens, or periods'
    );
  }
}

export function resolveLiteTableNames(
  environment: NodeJS.ProcessEnv = process.env
): Readonly<LiteTableNameMap> {
  const prefix = requiredEnvironmentValue(environment, 'FAQ_TABLE_NAME_PREFIX');
  const resolved = Object.fromEntries(
    Object.entries(TABLE_NAME_ENV).map(([key, environmentName]) => {
      const tableName = requiredEnvironmentValue(environment, environmentName);
      validateTableName(environmentName, tableName);
      return [key, tableName];
    })
  ) as unknown as LiteTableNameMap;

  if (new Set(Object.values(resolved)).size !== Object.keys(resolved).length) {
    throw new Error('FAQ table names must be distinct and must not be interchanged');
  }

  for (const key of Object.keys(TABLE_NAME_ENV) as Array<keyof LiteTableNameMap>) {
    const expected = `${prefix}-${TABLE_SUFFIX[key]}`;
    if (resolved[key] !== expected) {
      throw new Error(
        `${TABLE_NAME_ENV[key]} must exactly match ${expected} for ` +
          'FAQ_TABLE_NAME_PREFIX'
      );
    }
  }

  return Object.freeze(resolved);
}

const clientConfig: ConstructorParameters<typeof DynamoDBClient>[0] = { region };
if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
  clientConfig.endpoint = endpoint;
  clientConfig.credentials = {
    accessKeyId: 'local',
    secretAccessKey: 'local',
  };
}

const client = DynamoDBDocumentClient.from(new DynamoDBClient(clientConfig), {
  marshallOptions: { removeUndefinedValues: true, convertEmptyValues: false },
  unmarshallOptions: { wrapNumbers: false },
});

export const LiteTableNames = resolveLiteTableNames();

export interface LitePutOptions {
  conditionExpression?: string;
  expressionAttributeNames?: Record<string, string>;
  expressionAttributeValues?: Record<string, unknown>;
}

export interface LiteScanOptions {
  filterExpression?: string;
  expressionAttributeNames?: Record<string, string>;
  expressionAttributeValues?: Record<string, unknown>;
  consistentRead?: boolean;
}

export async function getItem<T>(
  tableName: string,
  key: Record<string, unknown>
): Promise<T | null> {
  const result = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: key,
    })
  );
  return (result.Item as T | undefined) ?? null;
}

export async function putItem(
  tableName: string,
  item: Record<string, unknown>,
  options: LitePutOptions = {}
): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: tableName,
      Item: item,
      ConditionExpression: options.conditionExpression,
      ExpressionAttributeNames: options.expressionAttributeNames,
      ExpressionAttributeValues: options.expressionAttributeValues,
    })
  );
}

/** Read every page of a small FAQ table. The free retriever is intentionally small-scale. */
export async function scanAll<T>(
  tableName: string,
  options: LiteScanOptions = {}
): Promise<T[]> {
  const items: T[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  for (let page = 0; page < 100; page += 1) {
    const result = await client.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: options.filterExpression,
        ExpressionAttributeNames: options.expressionAttributeNames,
        ExpressionAttributeValues: options.expressionAttributeValues,
        ConsistentRead: options.consistentRead,
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    items.push(...((result.Items as T[] | undefined) ?? []));
    exclusiveStartKey = result.LastEvaluatedKey;
    if (!exclusiveStartKey) return items;
  }

  throw new Error(`DynamoDB scan exceeded 100 pages for ${tableName}`);
}
