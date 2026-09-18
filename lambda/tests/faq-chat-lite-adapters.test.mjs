#!/usr/bin/env node
/** Public-only contract tests for the lite DynamoDB adapter boundary. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAMBDA_ROOT = path.resolve(HERE, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'faq-lite-adapters-test-'));
const TABLE_ENV_NAMES = [
  'FAQ_TABLE_NAME_PREFIX',
  'FAQ_SETTINGS_TABLE_NAME',
  'FAQ_AGENT_CONFIG_TABLE_NAME',
  'FAQ_KNOWLEDGE_ENTRIES_TABLE_NAME',
  'FAQ_QA_LOGS_TABLE_NAME',
];

after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

function tableEnvironment(prefix = 'prod-candidate') {
  return {
    FAQ_TABLE_NAME_PREFIX: prefix,
    FAQ_SETTINGS_TABLE_NAME: `${prefix}-Settings`,
    FAQ_AGENT_CONFIG_TABLE_NAME: `${prefix}-AgentConfig`,
    FAQ_KNOWLEDGE_ENTRIES_TABLE_NAME: `${prefix}-KnowledgeEntries`,
    FAQ_QA_LOGS_TABLE_NAME: `${prefix}-FaqQaLogs`,
  };
}

async function withTableEnvironment(environment, callback) {
  const previous = Object.fromEntries(
    TABLE_ENV_NAMES.map((name) => [name, process.env[name]])
  );

  for (const name of TABLE_ENV_NAMES) {
    const value = environment[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  try {
    return await callback();
  } finally {
    for (const name of TABLE_ENV_NAMES) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function bundle(entryPoint, outfile, setup) {
  await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outfile,
    logLevel: 'silent',
    plugins: [{ name: 'lite-dynamodb-contract-stub', setup }],
  });
  return import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);
}

test('lite DynamoDB resolves and uses only exact candidate table names', async () => {
  const state = {
    calls: [],
    clientConfigs: [],
    documentClientOptions: [],
    responses: {
      GetCommand: { Item: { key: 'faq_chat' } },
      ScanCommand: { Items: [{ entryId: 'candidate-entry' }] },
      PutCommand: {},
    },
  };
  globalThis.__faqLiteDynamoState = state;

  const candidateEnvironment = tableEnvironment();
  const module = await withTableEnvironment(candidateEnvironment, () =>
    bundle(
      path.join(
        LAMBDA_ROOT,
        'functions',
        'faq-chat',
        'infra',
        'lite-dynamodb.ts'
      ),
      path.join(tempRoot, 'lite-dynamodb.mjs'),
      (esbuild) => {
        esbuild.onResolve(
          { filter: /^@aws-sdk\/client-dynamodb$/ },
          () => ({ path: 'client-dynamodb', namespace: 'lite-test' })
        );
        esbuild.onResolve(
          { filter: /^@aws-sdk\/lib-dynamodb$/ },
          () => ({ path: 'lib-dynamodb', namespace: 'lite-test' })
        );
        esbuild.onLoad(
          { filter: /^client-dynamodb$/, namespace: 'lite-test' },
          () => ({
            contents: `
              export class DynamoDBClient {
                constructor(config) {
                  this.config = config;
                  globalThis.__faqLiteDynamoState.clientConfigs.push(config);
                }
              }
            `,
            loader: 'js',
          })
        );
        esbuild.onLoad(
          { filter: /^lib-dynamodb$/, namespace: 'lite-test' },
          () => ({
            contents: `
              class StubCommand {
                constructor(kind, input) {
                  this.kind = kind;
                  this.input = input;
                }
              }
              export class GetCommand extends StubCommand {
                constructor(input) { super('GetCommand', input); }
              }
              export class PutCommand extends StubCommand {
                constructor(input) { super('PutCommand', input); }
              }
              export class ScanCommand extends StubCommand {
                constructor(input) { super('ScanCommand', input); }
              }
              export class DynamoDBDocumentClient {
                static from(client, options) {
                  globalThis.__faqLiteDynamoState.documentClientOptions.push({
                    clientConfig: client.config,
                    options,
                  });
                  return {
                    async send(command) {
                      globalThis.__faqLiteDynamoState.calls.push({
                        kind: command.kind,
                        input: command.input,
                      });
                      return globalThis.__faqLiteDynamoState.responses[command.kind] ?? {};
                    },
                  };
                }
              }
            `,
            loader: 'js',
          })
        );
      }
    )
  );

  assert.deepEqual(module.LiteTableNames, {
    Settings: 'prod-candidate-Settings',
    AgentConfig: 'prod-candidate-AgentConfig',
    KnowledgeEntries: 'prod-candidate-KnowledgeEntries',
    FaqQaLogs: 'prod-candidate-FaqQaLogs',
  });
  assert.equal(Object.isFrozen(module.LiteTableNames), true);
  assert.throws(
    () => {
      module.LiteTableNames.Settings = 'prod-Settings';
    },
    TypeError
  );
  assert.equal(module.LiteTableNames.Settings, 'prod-candidate-Settings');

  assert.deepEqual(module.resolveLiteTableNames(candidateEnvironment), {
    Settings: 'prod-candidate-Settings',
    AgentConfig: 'prod-candidate-AgentConfig',
    KnowledgeEntries: 'prod-candidate-KnowledgeEntries',
    FaqQaLogs: 'prod-candidate-FaqQaLogs',
  });
  assert.equal(
    Object.isFrozen(module.resolveLiteTableNames(candidateEnvironment)),
    true
  );

  assert.throws(
    () => module.resolveLiteTableNames({}),
    /FAQ_TABLE_NAME_PREFIX must be set to a non-empty value/
  );
  assert.throws(
    () =>
      module.resolveLiteTableNames({
        FAQ_TABLE_NAME_PREFIX: 'prod-candidate',
      }),
    /FAQ_SETTINGS_TABLE_NAME must be set to a non-empty value/
  );
  assert.throws(
    () =>
      module.resolveLiteTableNames({
        ...candidateEnvironment,
        FAQ_KNOWLEDGE_ENTRIES_TABLE_NAME: undefined,
      }),
    /FAQ_KNOWLEDGE_ENTRIES_TABLE_NAME must be set to a non-empty value/
  );
  assert.throws(
    () =>
      module.resolveLiteTableNames({
        DYNAMODB_TABLE_PREFIX: 'dev',
      }),
    /FAQ_TABLE_NAME_PREFIX must be set to a non-empty value/,
    'legacy prefix must not restore an implicit dev fallback'
  );
  assert.throws(
    () =>
      module.resolveLiteTableNames({
        ...candidateEnvironment,
        FAQ_SETTINGS_TABLE_NAME: '',
      }),
    /FAQ_SETTINGS_TABLE_NAME must be set to a non-empty value/
  );
  assert.throws(
    () =>
      module.resolveLiteTableNames({
        ...candidateEnvironment,
        FAQ_TABLE_NAME_PREFIX: ' prod-candidate',
      }),
    /FAQ_TABLE_NAME_PREFIX must not contain leading or trailing whitespace/
  );
  assert.throws(
    () =>
      module.resolveLiteTableNames({
        ...candidateEnvironment,
        FAQ_SETTINGS_TABLE_NAME: 'prod-candidate-Settings ',
      }),
    /FAQ_SETTINGS_TABLE_NAME must not contain leading or trailing whitespace/
  );
  assert.throws(
    () =>
      module.resolveLiteTableNames({
        ...candidateEnvironment,
        FAQ_SETTINGS_TABLE_NAME: 'prod-candidate-Settings!',
      }),
    /FAQ_SETTINGS_TABLE_NAME must be a valid DynamoDB table name/
  );
  assert.throws(
    () =>
      module.resolveLiteTableNames({
        ...candidateEnvironment,
        FAQ_SETTINGS_TABLE_NAME: 'ab',
      }),
    /FAQ_SETTINGS_TABLE_NAME must be a valid DynamoDB table name/
  );

  const longEnvironment = tableEnvironment('x'.repeat(250));
  assert.throws(
    () => module.resolveLiteTableNames(longEnvironment),
    /FAQ_SETTINGS_TABLE_NAME must be a valid DynamoDB table name/
  );
  assert.throws(
    () =>
      module.resolveLiteTableNames({
        ...candidateEnvironment,
        FAQ_SETTINGS_TABLE_NAME: 'prod-other-Settings',
      }),
    /FAQ_SETTINGS_TABLE_NAME must exactly match prod-candidate-Settings/
  );
  assert.throws(
    () =>
      module.resolveLiteTableNames({
        ...candidateEnvironment,
        FAQ_SETTINGS_TABLE_NAME: 'prod-candidate-KnowledgeEntries',
        FAQ_KNOWLEDGE_ENTRIES_TABLE_NAME: 'prod-candidate-Settings',
      }),
    /FAQ_SETTINGS_TABLE_NAME must exactly match prod-candidate-Settings/
  );
  assert.throws(
    () =>
      module.resolveLiteTableNames({
        ...candidateEnvironment,
        FAQ_KNOWLEDGE_ENTRIES_TABLE_NAME: 'prod-candidate-Settings',
      }),
    /FAQ table names must be distinct and must not be interchanged/
  );

  assert.deepEqual(
    await module.getItem(module.LiteTableNames.Settings, { key: 'faq_chat' }),
    { key: 'faq_chat' }
  );
  assert.deepEqual(
    await module.getItem(module.LiteTableNames.AgentConfig, { agentId: 'support' }),
    { key: 'faq_chat' }
  );
  assert.deepEqual(
    await module.scanAll(module.LiteTableNames.KnowledgeEntries),
    [{ entryId: 'candidate-entry' }]
  );
  await module.putItem(module.LiteTableNames.FaqQaLogs, { ts: 'candidate-log' });

  assert.deepEqual(
    state.calls.map(({ kind, input }) => ({
      kind,
      tableName: input.TableName,
    })),
    [
      { kind: 'GetCommand', tableName: 'prod-candidate-Settings' },
      { kind: 'GetCommand', tableName: 'prod-candidate-AgentConfig' },
      { kind: 'ScanCommand', tableName: 'prod-candidate-KnowledgeEntries' },
      { kind: 'PutCommand', tableName: 'prod-candidate-FaqQaLogs' },
    ]
  );
  assert.equal(
    state.calls.every(({ input }) =>
      input.TableName.startsWith('prod-candidate-')
    ),
    true
  );
});

test('public production adapter delegates remote creation and keeps free/storage contracts', async (t) => {
  const oldAsync = process.env.FAQ_QA_NOTIFY_ASYNC_ENABLED;
  const oldWebhook = process.env.FAQ_QA_NOTIFY_WEBHOOK_URL;
  process.env.FAQ_QA_NOTIFY_ASYNC_ENABLED = 'false';
  process.env.FAQ_QA_NOTIFY_WEBHOOK_URL = 'configured-test-webhook';
  t.after(() => {
    if (oldAsync === undefined) delete process.env.FAQ_QA_NOTIFY_ASYNC_ENABLED;
    else process.env.FAQ_QA_NOTIFY_ASYNC_ENABLED = oldAsync;
    if (oldWebhook === undefined) delete process.env.FAQ_QA_NOTIFY_WEBHOOK_URL;
    else process.env.FAQ_QA_NOTIFY_WEBHOOK_URL = oldWebhook;
  });
  const state = {
    outcomes: [],
    events: [],
    freeCalls: [],
    getCalls: [],
    putCalls: [],
    notifyCalls: [],
    putError: null,
    remoteCalls: 0,
    remotePort: { kind: 'remote-http-client' },
    agentConfigPort: { kind: 'lite-agent-config' },
    smalltalkPort: { kind: 'free-smalltalk-port' },
    settingRow: { key: 'faq_chat', value: { enabled: true, fallbackMessage: 'fallback' } },
  };
  globalThis.__faqLiteStorageState = state;

  const module = await bundle(
    path.join(LAMBDA_ROOT, 'functions', 'faq-chat', 'adapters', 'production.ts'),
    path.join(tempRoot, 'production.mjs'),
    (esbuild) => {
      esbuild.onResolve({ filter: /shell-timing\.js$/ }, () => ({
        path: 'timing', namespace: 'lite-test',
      }));
      esbuild.onLoad({ filter: /^timing$/, namespace: 'lite-test' }, () => ({
        contents: `export function recordFaqQaNotifyOutcome(value) {
          globalThis.__faqLiteStorageState.outcomes.push(value);
        }`, loader: 'js',
      }));
      esbuild.onResolve({ filter: /free[\\/]index\.js$/ }, () => ({
        path: 'free-index',
        namespace: 'lite-test',
      }));
      esbuild.onResolve({ filter: /free[\\/]agent-config\.js$/ }, () => ({
        path: 'free-agent-config',
        namespace: 'lite-test',
      }));
      esbuild.onResolve({ filter: /free[\\/]dynamodb-entries\.js$/ }, () => ({
        path: 'free-kb',
        namespace: 'lite-test',
      }));
      esbuild.onResolve({ filter: /remote[\\/]http-client\.js$/ }, () => ({
        path: 'remote-http-client',
        namespace: 'lite-test',
      }));
      esbuild.onResolve({ filter: /faq-qa-slack-notify\.js$/ }, () => ({
        path: 'faq-qa-slack-notify',
        namespace: 'lite-test',
      }));
      esbuild.onResolve({ filter: /infra[\\/]lite-dynamodb\.js$/ }, () => ({
        path: 'lite-dynamodb',
        namespace: 'lite-test',
      }));
      esbuild.onLoad({ filter: /^free-index$/, namespace: 'lite-test' }, () => ({
        contents: `export function createFreeFaqPorts(options) {
          globalThis.__faqLiteStorageState.freeCalls.push(options.kbSource.kind);
          return { retrieval: {}, answerGeneration: {},
            smalltalkGeneration: globalThis.__faqLiteStorageState.smalltalkPort,
            answerPrompt: {}, defaultModel: 'free-test' };
        }`,
        loader: 'js',
      }));
      esbuild.onLoad({ filter: /^free-kb$/, namespace: 'lite-test' }, () => ({
        contents: "export const dynamoDbFaqKbSource = { kind: 'lite-dynamodb-kb' };",
        loader: 'js',
      }));
      esbuild.onLoad({ filter: /^free-agent-config$/, namespace: 'lite-test' }, () => ({
        contents:
          'export const dynamoDbFaqAgentConfig = globalThis.__faqLiteStorageState.agentConfigPort;',
        loader: 'js',
      }));
      esbuild.onLoad({ filter: /^remote-http-client$/, namespace: 'lite-test' }, () => ({
        contents: `export function createRemoteFaqRagHttpClient() {
          globalThis.__faqLiteStorageState.remoteCalls += 1;
          return globalThis.__faqLiteStorageState.remotePort;
        }
        export const createRemoteFaqRagAnswerHttpClient = createRemoteFaqRagHttpClient;`,
        loader: 'js',
      }));
      esbuild.onLoad({ filter: /^faq-qa-slack-notify$/, namespace: 'lite-test' }, () => ({
        contents: `export async function notifyFaqQaLog(record, timeoutMs) {
          globalThis.__faqLiteStorageState.events.push('notify');
          globalThis.__faqLiteStorageState.notifyCalls.push({ record, timeoutMs });
        }`,
        loader: 'js',
      }));
      esbuild.onLoad({ filter: /^lite-dynamodb$/, namespace: 'lite-test' }, () => ({
        contents: `
          export const LiteTableNames = {
            Settings: 'prod-candidate-Settings',
            AgentConfig: 'prod-candidate-AgentConfig',
            KnowledgeEntries: 'prod-candidate-KnowledgeEntries',
            FaqQaLogs: 'prod-candidate-FaqQaLogs'
          };
          export async function getItem(table, key) {
            globalThis.__faqLiteStorageState.getCalls.push({ table, key });
            return globalThis.__faqLiteStorageState.settingRow;
          }
          export async function putItem(table, item, options) {
            globalThis.__faqLiteStorageState.events.push('put');
            globalThis.__faqLiteStorageState.putCalls.push({ table, item, options });
            if (globalThis.__faqLiteStorageState.putError) {
              throw globalThis.__faqLiteStorageState.putError;
            }
          }
        `,
        loader: 'js',
      }));
    }
  );

  assert.equal(module.createProductionRemoteFaqRagPort(), state.remotePort);
  assert.equal(state.remoteCalls, 1);

  const adapters = module.createProductionFaqAdapters();
  assert.equal(adapters.defaultModel, 'free-test');
  assert.strictEqual(adapters.smalltalkGeneration, state.smalltalkPort);
  assert.strictEqual(adapters.agentConfig, state.agentConfigPort);
  assert.deepEqual(state.freeCalls, ['lite-dynamodb-kb']);
  assert.equal(state.remoteCalls, 1, 'free factory must not initialize the remote client');
  assert.deepEqual(await adapters.storage.loadSettings(), state.settingRow.value);
  assert.deepEqual(state.getCalls, [
    { table: 'prod-candidate-Settings', key: { key: 'faq_chat' } },
  ]);

  const record = {
    dateBucket: '2026-08-21',
    ts: '2026-08-21T00:00:00.000Z#abcd1234',
    question: 'question',
    answer: 'answer',
    responseType: 'answer',
    route: 'answer',
    scopeFallback: false,
    failureKind: null,
    guardDetail: null,
    sources: ['source'],
    model: null,
    totalMs: 10,
    ttl: 1_800_000_000,
  };
  await adapters.storage.putQaLog(record);
  assert.deepEqual(state.putCalls, [
    {
      table: 'prod-candidate-FaqQaLogs',
      item: { ...record, qaNotifyDelivery: 'sync-v1' },
      options: {
        conditionExpression: 'attribute_not_exists(#ts)',
        expressionAttributeNames: { '#ts': 'ts' },
      },
    },
  ]);
  assert.deepEqual(state.events, ['put']);
  assert.deepEqual(state.notifyCalls, []);

  await adapters.storage.notifyQaLog(record, 375);
  assert.deepEqual(state.events, ['put', 'notify']);
  assert.deepEqual(state.notifyCalls, [{ record, timeoutMs: 375 }]);

  state.putError = new Error('put failed');
  await assert.rejects(
    adapters.storage.putQaLog({ ...record, ts: `${record.ts}-failed` }),
    /put failed/
  );
  assert.deepEqual(state.events, ['put', 'notify', 'put']);
  assert.deepEqual(
    state.notifyCalls,
    [{ record, timeoutMs: 375 }],
    'putQaLog must remain persistence-only even when a later Put fails'
  );

  process.env.FAQ_QA_NOTIFY_ASYNC_ENABLED = 'true';
  // A rejected Put never causes an async marker or stream event to be committed.
  await assert.rejects(adapters.storage.putQaLog(record), /put failed/);
  assert.equal(state.notifyCalls.length, 1);
  state.putError = null;
  await adapters.storage.putQaLog(record);
  assert.equal(state.putCalls.at(-1).item.qaNotifyDelivery, 'async-v1');
  await adapters.storage.notifyQaLog(record, 375);
  assert.equal(state.notifyCalls.length, 1, 'async delivery must never call the synchronous sender');
  assert.equal(state.outcomes.at(-1), 'skipped');
  delete process.env.FAQ_QA_NOTIFY_WEBHOOK_URL;
  await adapters.storage.putQaLog(record);
  assert.equal(state.putCalls.at(-1).item.qaNotifyDelivery, 'disabled');
  await adapters.storage.notifyQaLog(record, 375);
  assert.equal(state.outcomes.at(-1), 'disabled');
  assert.equal(state.notifyCalls.length, 1);
});

test('public KB source filters active public default-agent rows twice', async () => {
  const state = {
    calls: [],
    rows: [
      { entryId: 'a', topic: 'A', answer: 'Answer A', status: 'active', visibility: 'public' },
      { entryId: 'b', topic: 'B', answer: 'Answer B', status: 'active', visibility: 'public', agentId: 'default', canonicalUrl: 'https://example.jp/b' },
      { entryId: 'inactive', topic: 'X', answer: 'X', status: 'inactive', visibility: 'public' },
      { entryId: 'private', topic: 'X', answer: 'X', status: 'active', visibility: 'internal' },
      { entryId: 'other-agent', topic: 'X', answer: 'X', status: 'active', visibility: 'public', agentId: 'other' },
      { entryId: 'invalid', topic: 'X', status: 'active', visibility: 'public' },
    ],
  };
  globalThis.__faqLiteKbState = state;

  const module = await bundle(
    path.join(
      LAMBDA_ROOT,
      'functions',
      'faq-chat',
      'adapters',
      'free',
      'dynamodb-entries.ts'
    ),
    path.join(tempRoot, 'dynamodb-entries.mjs'),
    (esbuild) => {
      esbuild.onResolve({ filter: /infra[\\/]lite-dynamodb\.js$/ }, () => ({
        path: 'lite-dynamodb',
        namespace: 'lite-test',
      }));
      esbuild.onLoad({ filter: /^lite-dynamodb$/, namespace: 'lite-test' }, () => ({
        contents: `
          export const LiteTableNames = {
            KnowledgeEntries: 'prod-candidate-KnowledgeEntries'
          };
          export async function scanAll(table, options) {
            globalThis.__faqLiteKbState.calls.push({ table, options });
            return globalThis.__faqLiteKbState.rows;
          }
        `,
        loader: 'js',
      }));
    }
  );

  assert.deepEqual(await module.loadPublicKnowledgeEntries(), [
    { id: 'a', topic: 'A', content: 'Answer A' },
    { id: 'b', topic: 'B', content: 'Answer B', canonicalUrl: 'https://example.jp/b' },
  ]);
  assert.deepEqual(state.calls, [
    {
      table: 'prod-candidate-KnowledgeEntries',
      options: {
        filterExpression:
          '#status = :active AND #visibility = :public AND ' +
          '(attribute_not_exists(#agentId) OR #agentId = :defaultAgentId)',
        expressionAttributeNames: {
          '#status': 'status',
          '#visibility': 'visibility',
          '#agentId': 'agentId',
        },
        expressionAttributeValues: {
          ':active': 'active',
          ':public': 'public',
          ':defaultAgentId': 'default',
        },
      },
    },
  ]);
});
