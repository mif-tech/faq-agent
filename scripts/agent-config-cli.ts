#!/usr/bin/env node
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  AGENT_ID_PATTERN,
  validateFaqAgentProfile,
  type FaqAgentProfileValidationError,
} from '../lambda/functions/faq-chat/adapters/free/agent-profile.js';

const DYNAMODB_TABLE_NAME_PATTERN = /^[A-Za-z0-9_.-]{3,255}$/u;
const MAX_SCAN_PAGES = 100;

type DocumentClient = Pick<DynamoDBDocumentClient, 'send'>;

export interface AgentConfigCliRuntime {
  environment?: NodeJS.ProcessEnv;
  documentClient?: DocumentClient;
  readTextFile?: (filePath: string) => Promise<string>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

function usage(): string {
  return [
    'Usage:',
    '  agent-config-cli.ts list',
    '  agent-config-cli.ts validate <profile.json>',
    '  agent-config-cli.ts upsert <profile.json> [--replace]',
    '  agent-config-cli.ts disable <agentId>',
    '',
    'list/upsert/disable require FAQ_TABLE_NAME_PREFIX and FAQ_AGENT_CONFIG_TABLE_NAME.',
    'upsert replaces the whole row (shared by HTTP and Slack); dropping existing',
    'fields requires --replace so shared settings are never removed silently.',
  ].join('\n');
}

export function resolveAgentConfigTableName(
  environment: NodeJS.ProcessEnv = process.env
): string {
  const value = environment.FAQ_AGENT_CONFIG_TABLE_NAME;
  if (value === undefined || value.length === 0) {
    throw new Error('FAQ_AGENT_CONFIG_TABLE_NAME must be set to a non-empty value');
  }
  if (value !== value.trim()) {
    throw new Error(
      'FAQ_AGENT_CONFIG_TABLE_NAME must not contain leading or trailing whitespace'
    );
  }
  if (!DYNAMODB_TABLE_NAME_PATTERN.test(value)) {
    throw new Error('FAQ_AGENT_CONFIG_TABLE_NAME must be a valid DynamoDB table name');
  }

  const prefix = environment.FAQ_TABLE_NAME_PREFIX;
  if (prefix === undefined || prefix.length === 0) {
    throw new Error('FAQ_TABLE_NAME_PREFIX must be set to a non-empty value');
  }
  if (prefix !== prefix.trim() || !DYNAMODB_TABLE_NAME_PATTERN.test(prefix)) {
    throw new Error('FAQ_TABLE_NAME_PREFIX must be a valid DynamoDB table-name prefix');
  }
  if (value !== `${prefix}-AgentConfig`) {
    throw new Error(
      `FAQ_AGENT_CONFIG_TABLE_NAME must exactly match ${prefix}-AgentConfig`
    );
  }
  return value;
}

export function resolveDynamoDbEndpoint(
  environment: NodeJS.ProcessEnv = process.env
): string | undefined {
  const endpoint = environment.DYNAMODB_ENDPOINT;
  if (endpoint === undefined || endpoint.length === 0) return undefined;
  if (endpoint !== endpoint.trim()) {
    throw new Error('DYNAMODB_ENDPOINT must not contain leading or trailing whitespace');
  }

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error('DYNAMODB_ENDPOINT must be a valid http(s) URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.hostname.length === 0) {
    throw new Error('DYNAMODB_ENDPOINT must be a valid http(s) URL');
  }
  return endpoint;
}

function createDocumentClient(
  environment: NodeJS.ProcessEnv
): { client: DocumentClient; destroy: () => void } {
  const endpoint = resolveDynamoDbEndpoint(environment);
  const config: ConstructorParameters<typeof DynamoDBClient>[0] = {
    region: environment.AWS_REGION ?? 'us-west-2',
  };
  if (endpoint !== undefined) {
    config.endpoint = endpoint;
    config.credentials = {
      accessKeyId: 'local',
      secretAccessKey: 'local',
    };
  }
  const baseClient = new DynamoDBClient(config);
  return {
    client: DynamoDBDocumentClient.from(baseClient, {
      marshallOptions: { removeUndefinedValues: true, convertEmptyValues: false },
      unmarshallOptions: { wrapNumbers: false },
    }),
    destroy: () => baseClient.destroy(),
  };
}

async function withDocumentClient<T>(
  runtime: AgentConfigCliRuntime,
  operation: (client: DocumentClient) => Promise<T>
): Promise<T> {
  if (runtime.documentClient) return operation(runtime.documentClient);
  const created = createDocumentClient(runtime.environment ?? process.env);
  try {
    return await operation(created.client);
  } finally {
    created.destroy();
  }
}

function formatValidationErrors(errors: FaqAgentProfileValidationError[]): string {
  return errors.map(({ field, reason }) => `${field}: ${reason}`).join('\n');
}

async function readAndValidateProfile(
  filePath: string,
  runtime: AgentConfigCliRuntime
) {
  const readTextFile = runtime.readTextFile ?? ((path: string) => readFile(path, 'utf8'));
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readTextFile(filePath));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`could not read profile JSON ${filePath}: ${message}`);
  }
  return validateFaqAgentProfile(parsed);
}

async function listProfiles(
  client: DocumentClient,
  tableName: string
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    const result = await client.send(
      new ScanCommand({
        TableName: tableName,
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    items.push(...((result.Items as Record<string, unknown>[] | undefined) ?? []));
    exclusiveStartKey = result.LastEvaluatedKey;
    if (!exclusiveStartKey) {
      return items.sort((left, right) =>
        String(left.agentId ?? '').localeCompare(String(right.agentId ?? ''))
      );
    }
  }
  throw new Error(`DynamoDB scan exceeded ${MAX_SCAN_PAGES} pages for ${tableName}`);
}

/** Run one CLI command and return a process exit code without calling process.exit(). */
export async function runAgentConfigCli(
  argv: string[],
  runtime: AgentConfigCliRuntime = {}
): Promise<number> {
  const stdout = runtime.stdout ?? console.log;
  const stderr = runtime.stderr ?? console.error;
  const environment = runtime.environment ?? process.env;
  const [command, operand, ...extra] = argv;
  const replaceRequested = command === 'upsert' && extra.length === 1 && extra[0] === '--replace';

  if (!command || (extra.length > 0 && !replaceRequested)) {
    stderr(usage());
    return 2;
  }

  try {
    if (command === 'validate' || command === 'upsert') {
      if (!operand) {
        stderr(usage());
        return 2;
      }
      const validation = await readAndValidateProfile(operand, runtime);
      if (validation.ok === false) {
        stderr(formatValidationErrors(validation.errors));
        return 1;
      }

      if (command === 'validate') {
        stdout(JSON.stringify(validation.value, null, 2));
        return 0;
      }

      const tableName = resolveAgentConfigTableName(environment);
      const removedKeys = await withDocumentClient(runtime, async (client) => {
        // upsertは全置換。行はHTTPとSlackで共用のため、既存キーが新プロファイルに無い場合は
        // 黙って消さずに--replaceの明示を要求する（累積レビュー指摘）。
        const existing = await client.send(
          new GetCommand({
            TableName: tableName,
            Key: { agentId: validation.value.agentId },
            ConsistentRead: true,
          })
        );
        const existingItem = existing.Item as Record<string, unknown> | undefined;
        const dropped =
          existingItem === undefined
            ? []
            : Object.keys(existingItem)
                .filter((key) => key !== 'agentId')
                .filter((key) => !(key in validation.value))
                .sort();
        if (dropped.length > 0 && !replaceRequested) return dropped;
        await client.send(
          new PutCommand({
            TableName: tableName,
            Item: validation.value,
          })
        );
        return [];
      });
      if (removedKeys.length > 0) {
        stderr(
          `refusing to drop existing fields without --replace: ${removedKeys.join(', ')}
` +
            'The row is shared by the HTTP named route and the Slack agent. Re-run with ' +
            '--replace to intentionally remove them, or include the fields in the profile.'
        );
        return 1;
      }
      stdout(`[OK] upserted ${validation.value.agentId}`);
      return 0;
    }

    if (command === 'disable') {
      if (!operand) {
        stderr(usage());
        return 2;
      }
      if (!AGENT_ID_PATTERN.test(operand)) {
        stderr('agentId: must match ^[a-z0-9][a-z0-9_-]{0,63}$');
        return 1;
      }

      const tableName = resolveAgentConfigTableName(environment);
      await withDocumentClient(runtime, (client) =>
        client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { agentId: operand },
            UpdateExpression: 'SET #enabled = :disabled',
            ConditionExpression: 'attribute_exists(#agentId)',
            ExpressionAttributeNames: {
              '#agentId': 'agentId',
              '#enabled': 'enabled',
            },
            ExpressionAttributeValues: { ':disabled': false },
          })
        )
      );
      stdout(`[OK] disabled ${operand}`);
      return 0;
    }

    if (command === 'list') {
      if (operand !== undefined) {
        stderr(usage());
        return 2;
      }
      const tableName = resolveAgentConfigTableName(environment);
      const items = await withDocumentClient(runtime, (client) =>
        listProfiles(client, tableName)
      );
      stdout(JSON.stringify(items, null, 2));
      return 0;
    }

    stderr(usage());
    return 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(`[ERROR] ${message}`);
    return 1;
  }
}

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  runAgentConfigCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
