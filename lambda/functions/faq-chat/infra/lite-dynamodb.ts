import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? '';
const tablePrefix = process.env.DYNAMODB_TABLE_PREFIX ?? 'dev';
const region = process.env.AWS_REGION ?? 'us-west-2';

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

export const LiteTableNames = Object.freeze({
  Settings: `${tablePrefix}-Settings`,
  KnowledgeEntries: `${tablePrefix}-KnowledgeEntries`,
  FaqQaLogs: `${tablePrefix}-FaqQaLogs`,
});

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
