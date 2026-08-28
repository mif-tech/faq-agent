#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAMBDA_ROOT = path.resolve(HERE, '..');
const OVERLAY_ROOT = path.resolve(LAMBDA_ROOT, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-lite-entrypoints-test-'));

after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

async function bundle(entryPoint, name, setup = () => {}) {
  const outfile = path.join(tempRoot, `${name}.mjs`);
  await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outfile,
    logLevel: 'silent',
    plugins: [{ name: `slack-lite-${name}`, setup }],
  });
  return import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);
}

function virtualModule(esbuild, filter, pathName, contents) {
  esbuild.onResolve({ filter }, () => ({ path: pathName, namespace: 'slack-lite-test' }));
  esbuild.onLoad(
    { filter: new RegExp(`^${pathName.replaceAll('-', '\\-')}$`), namespace: 'slack-lite-test' },
    () => ({ contents, loader: 'js' })
  );
}

async function withEnvironment(values, operation) {
  const original = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await operation();
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('Slack QA writer preserves generated-to-posted and skipped contracts', async () => {
  const state = { calls: [], failConditional: false };
  globalThis.__slackLiteQaState = state;
  const module = await bundle(
    path.join(LAMBDA_ROOT, 'shared-lite', 'slack-agent-qa-log-dynamo.ts'),
    'qa-log',
    (esbuild) => {
      virtualModule(
        esbuild,
        /^@aws-sdk\/lib-dynamodb$/,
        'lib-dynamodb',
        `
          class Command { constructor(input) { this.input = input; } }
          export class PutCommand extends Command {}
          export class UpdateCommand extends Command {}
        `
      );
      virtualModule(
        esbuild,
        /faq-chat[\\/]infra[\\/]lite-dynamodb\.js$/,
        'lite-dynamodb',
        `
          export const liteDocumentClient = {
            async send(command, options) {
              globalThis.__slackLiteQaState.calls.push({ input: command.input, options });
              if (globalThis.__slackLiteQaState.failConditional) {
                globalThis.__slackLiteQaState.failConditional = false;
                const error = new Error('conditional');
                error.name = 'ConditionalCheckFailedException';
                throw error;
              }
              return {};
            }
          };
        `
      );
    }
  );

  const writer = new module.LiteDynamoSlackAgentQaLogWriter(
    'candidate-SlackQaLogs',
    'support'
  );
  const entry = {
    agentId: 'support',
    trustClass: 'slack',
    sourceEventId: 'Ev-1',
    teamId: 'T-1',
    channel: 'C-1',
    slackUserId: 'U-1',
    responseType: 'answer',
    latencyMs: 12,
    deliveryStatus: 'generated',
    createdAt: '2026-08-27T12:00:00.000Z',
    logPolicy: 'metadata_only',
  };

  assert.deepEqual(await writer.saveGenerated(entry), {
    ref: { agentId: 'support', trustClass: 'slack', sourceEventId: 'Ev-1' },
    skipped: false,
  });
  const put = state.calls[0].input;
  assert.equal(put.TableName, 'candidate-SlackQaLogs');
  assert.equal(put.Item.sourceEventId, 'Ev-1');
  assert.equal(
    put.Item.ttl,
    Math.floor(Date.parse(entry.createdAt) / 1000) + 180 * 24 * 60 * 60
  );
  assert.equal(
    put.ConditionExpression,
    'attribute_not_exists(#sourceEventId) OR #deliveryStatus = :generated'
  );

  state.failConditional = true;
  assert.deepEqual(await writer.saveGenerated(entry), {
    ref: { agentId: 'support', trustClass: 'slack', sourceEventId: 'Ev-1' },
    skipped: true,
  });

  await writer.markPosted({
    ref: { agentId: 'support', trustClass: 'slack', sourceEventId: 'Ev-1' },
    slackMessageTs: '123.000001',
    postedAt: '2026-08-27T12:00:01.000Z',
  });
  const update = state.calls[2].input;
  assert.deepEqual(update.Key, { sourceEventId: 'Ev-1' });
  assert.match(update.ConditionExpression, /#agentId = :agentId/);
  assert.match(update.ConditionExpression, /#trustClass = :trustClass/);
  assert.match(update.ConditionExpression, /#deliveryStatus = :generated/);

  await assert.rejects(
    writer.markPosted({
      ref: { agentId: 'other', trustClass: 'slack', sourceEventId: 'Ev-2' },
      slackMessageTs: '123.000002',
      postedAt: '2026-08-27T12:00:02.000Z',
    }),
    /trust boundary mismatch/
  );
  assert.equal(state.calls.length, 3);
});

test('lite composition rejects a missing required port before startup', async () => {
  const module = await bundle(
    path.join(LAMBDA_ROOT, 'shared-lite', 'slack-agent-composition.ts'),
    'composition',
    (esbuild) => {
      // 共有port検査は実物を通す。公開ツリーではローカルに存在し、canonical repoから
      // 実行する場合は正本の lambda/shared/public/ へ解決する。
      esbuild.onResolve(
        { filter: /shared[\\/]public[\\/]slack-agent-composition\.js$/ },
        () => {
          const local = path.join(
            LAMBDA_ROOT,
            'shared',
            'public',
            'slack-agent-composition.ts'
          );
          const canonical = path.join(
            OVERLAY_ROOT,
            '..',
            '..',
            '..',
            'lambda',
            'shared',
            'public',
            'slack-agent-composition.ts'
          );
          return { path: fs.existsSync(local) ? local : canonical };
        }
      );
      virtualModule(
        esbuild,
        /adapters[\\/]free[\\/]anthropic-generation\.js$/,
        'generation-adapter',
        'export function createAnthropicGenerationPort() { return { async generate() { return null; } }; }'
      );
      virtualModule(
        esbuild,
        /(?:^|[\\/])slack-agent-config\.js$/,
        'config-adapter',
        'export function createLiteSlackAgentConfigPort() { return { async resolve() { return null; } }; }'
      );
      virtualModule(
        esbuild,
        /(?:^|[\\/])slack-kb\.js$/,
        'kb-adapter',
        'export const liteSlackKbPort = { async load() { return { block: "", sourceIds: [] }; } };'
      );
      virtualModule(
        esbuild,
        /(?:^|[\\/])slack-agent-policy\.js$/,
        'policy-adapter',
        `
          export const liteSlackAgentPolicy = {
            isTrustClass() {}, qaLogPolicyOverrides: {}, inspectJob() {},
            assertAgentConfigBoundary() {},
            selectKbInjectionStrategy() {}, canSendQaLogNotification() {},
            async sendQaLogNotification() {}
          };
        `
      );
      virtualModule(
        esbuild,
        /(?:^|[\\/])slack-agent-qa-log-dynamo\.js$/,
        'qa-adapter',
        'export class LiteDynamoSlackAgentQaLogWriter { async saveGenerated() {} async markPosted() {} }'
      );
    }
  );

  const complete = {
    config: { resolve() {} },
    kb: { load() {} },
    generation: { generate() {} },
    qaLog: { saveGenerated() {}, markPosted() {} },
    policy: {
      isTrustClass() {},
      qaLogPolicyOverrides: {},
      inspectJob() {},
      assertAgentConfigBoundary() {},
      selectKbInjectionStrategy() {},
      canSendQaLogNotification() {},
      sendQaLogNotification() {},
    },
  };
  assert.strictEqual(module.createSlackAgentComposition(complete), complete);
  assert.throws(
    () => module.createSlackAgentComposition({ ...complete, qaLog: { saveGenerated() {} } }),
    /qaLog\.markPosted must be a function/
  );
  assert.throws(
    () => module.createLiteSlackAgentComposition({
      agentId: 'support',
      trustClass: 'other',
      kbTableName: 'candidate-KnowledgeEntries',
      qaLogTableName: 'candidate-SlackQaLogs',
    }, { generation: complete.generation }),
    /trust class must be slack/
  );
  const composed = module.createLiteSlackAgentComposition({
    agentId: 'support',
    trustClass: 'slack',
    kbTableName: 'candidate-KnowledgeEntries',
    qaLogTableName: 'candidate-SlackQaLogs',
  }, { generation: complete.generation });
  assert.equal(typeof composed.qaLog.markPosted, 'function');
});

test('worker entrypoint accepts only the slack trust class', async () => {
  const state = { compositions: [], runs: [] };
  globalThis.__slackLiteWorkerState = state;
  const module = await bundle(
    path.join(LAMBDA_ROOT, 'functions', 'slack-agent-worker', 'handler.ts'),
    'worker',
    (esbuild) => {
      virtualModule(
        esbuild,
        /shared-lite[\\/]slack-agent-composition\.js$/,
        'worker-composition',
        `
          export function createLiteSlackAgentComposition(runtime, options) {
            const value = { runtime, options };
            globalThis.__slackLiteWorkerState.compositions.push(value);
            return value;
          }
        `
      );
      virtualModule(
        esbuild,
        /shared[\\/]public[\\/]slack-worker-core\.js$/,
        'worker-core',
        `
          export async function runSlackAgentWorker(input) {
            globalThis.__slackLiteWorkerState.runs.push(input);
          }
        `
      );
      virtualModule(
        esbuild,
        /faq-chat[\\/]infra[\\/]lite-dynamodb\.js$/,
        'worker-dynamodb',
        `
          export const LiteTableNames = {
            KnowledgeEntries: 'candidate-KnowledgeEntries'
          };
          export const liteDocumentClient = { send() {} };
        `
      );
    }
  );
  const valid = {
    TRUST_CLASS: 'slack',
    AGENT_ID: 'support',
    SLACK_BOT_TOKEN: 'token-for-test',
    EXPECTED_BOT_USER_ID: 'U-BOT',
    IDEMPOTENCY_TABLE_NAME: 'candidate-SlackIdempotency',
    KB_TABLE_NAME: 'candidate-KnowledgeEntries',
    SLACK_QA_LOG_TABLE_NAME: 'candidate-SlackQaLogs',
    ANTHROPIC_API_KEY: 'api-key-for-test',
    QUEUE_MAX_RECEIVE_COUNT: '5',
  };

  // 欠落・不正はfail closed（redriveとずれると最終失敗通知が重複/未通知になるため）。

  await withEnvironment({ ...valid, TRUST_CLASS: 'other' }, async () => {
    assert.throws(() => module.loadWorkerEnvironment(), /TRUST_CLASS must be slack/);
  });
  await withEnvironment({ ...valid, KB_TABLE_NAME: 'other-KnowledgeEntries' }, async () => {
    assert.throws(
      () => module.loadWorkerEnvironment(),
      /KB_TABLE_NAME must match FAQ_KNOWLEDGE_ENTRIES_TABLE_NAME/
    );
  });
  await withEnvironment({ ...valid, QUEUE_MAX_RECEIVE_COUNT: undefined }, async () => {
    assert.throws(() => module.loadWorkerEnvironment(), /QUEUE_MAX_RECEIVE_COUNT is required/);
  });
  await withEnvironment({ ...valid, QUEUE_MAX_RECEIVE_COUNT: 'many' }, async () => {
    assert.throws(
      () => module.loadWorkerEnvironment(),
      /QUEUE_MAX_RECEIVE_COUNT must be an integer between 1 and 100/
    );
  });
  await withEnvironment(valid, async () => {
    const loaded = module.loadWorkerEnvironment();
    assert.equal(loaded.runtime.trustClass, 'slack');
    assert.equal(loaded.runtime.qaLogTableName, 'candidate-SlackQaLogs');
    assert.equal(loaded.runtime.maxReceiveCount, 5);
    await module.handler({ Records: [] }, { awsRequestId: 'request-1' });
  });
  assert.equal(state.compositions.length, 1);
  assert.equal(state.runs.length, 1);
  assert.strictEqual(
    state.runs[0].documentClient,
    state.compositions[0].options.documentClient
  );
});

test('ingress requires a channel allowlist and never forces direct messages', async () => {
  const state = { queues: [], runs: [] };
  globalThis.__slackLiteIngressState = state;
  const module = await bundle(
    path.join(LAMBDA_ROOT, 'functions', 'slack-ingress', 'handler.ts'),
    'ingress',
    (esbuild) => {
      virtualModule(
        esbuild,
        /shared[\\/]public[\\/]slack-ingress-core\.js$/,
        'ingress-core',
        `
          export async function runSlackIngress(event, runtime, queue) {
            globalThis.__slackLiteIngressState.runs.push({ event, runtime, queue });
            return { statusCode: 202, headers: {}, body: '{"ok":true}' };
          }
        `
      );
      virtualModule(
        esbuild,
        /shared-lite[\\/]slack-sqs\.js$/,
        'ingress-sqs',
        `
          export function createLiteSqsQueue(options) {
            const queue = { options, send() {} };
            globalThis.__slackLiteIngressState.queues.push(queue);
            return queue;
          }
          export function getLiteSqsQueue(region) {
            return createLiteSqsQueue({ region });
          }
        `
      );
    }
  );
  const valid = {
    TRUST_CLASS: 'slack',
    AGENT_ID: 'support',
    SLACK_SIGNING_SECRET: 'signing-secret-for-test',
    EXPECTED_API_APP_ID: 'A-APP',
    EXPECTED_TEAM_ID: 'T-TEAM',
    EXPECTED_BOT_USER_ID: 'U-BOT',
    ALLOWED_CHANNEL_IDS: ' C-ONE, C-TWO ',
    SLACK_EVENT_QUEUE_URL: 'https://sqs.example.test/123/queue.fifo',
    AWS_REGION: 'example-region-1',
  };
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await withEnvironment({ ...valid, TRUST_CLASS: 'other' }, async () => {
      const result = await module.handler({});
      assert.equal(result.statusCode, 503);
    });
    await withEnvironment({ ...valid, ALLOWED_CHANNEL_IDS: undefined }, async () => {
      const result = await module.handler({});
      assert.equal(result.statusCode, 503);
    });
    await withEnvironment({ ...valid, ALLOWED_CHANNEL_IDS: ' , ' }, async () => {
      const result = await module.handler({});
      assert.equal(result.statusCode, 503);
    });
  } finally {
    console.error = originalConsoleError;
  }

  await withEnvironment(valid, async () => {
    const result = await module.handler({ body: '{}' });
    assert.equal(result.statusCode, 202);
  });
  assert.equal(state.runs.length, 1);
  assert.deepEqual([...state.runs[0].runtime.allowedChannelIds], ['C-ONE', 'C-TWO']);
  assert.equal(state.runs[0].runtime.requiresDirectMessage('slack'), false);
  assert.equal(state.queues[0].options.region, 'example-region-1');
});

test('lite SQS adapter signs the Query API request without an extra SDK package', async () => {
  const state = { signed: null, fetched: null };
  globalThis.__slackLiteSqsState = state;
  const module = await bundle(
    path.join(LAMBDA_ROOT, 'shared-lite', 'slack-sqs.ts'),
    'sqs',
    (esbuild) => {
      virtualModule(esbuild, /^@aws-crypto\/sha256-js$/, 'sha256', 'export class Sha256 {}');
      virtualModule(
        esbuild,
        /^@aws-sdk\/credential-provider-node$/,
        'credentials',
        'export function defaultProvider() { return async () => ({ accessKeyId: "a", secretAccessKey: "b" }); }'
      );
      virtualModule(
        esbuild,
        /^@smithy\/signature-v4$/,
        'signature',
        `
          export class SignatureV4 {
            constructor(options) { this.options = options; }
            async sign(request) {
              globalThis.__slackLiteSqsState.signed = { options: this.options, request };
              return { ...request, headers: { ...request.headers, authorization: 'signed' } };
            }
          }
        `
      );
    }
  );
  const signal = AbortSignal.timeout(1_000);
  const queue = module.createLiteSqsQueue({
    region: 'example-region-1',
    credentialsProvider: async () => ({ accessKeyId: 'a', secretAccessKey: 'b' }),
    fetch: async (url, init) => {
      state.fetched = { url: String(url), init };
      return new Response('', { status: 200 });
    },
  });
  await queue.send({
    QueueUrl: 'https://sqs.example.test/123/queue.fifo',
    MessageBody: '{"job":1}',
    MessageGroupId: 'group',
    MessageDeduplicationId: 'dedupe',
  }, { abortSignal: signal });

  assert.equal(state.signed.options.service, 'sqs');
  const body = new URLSearchParams(state.signed.request.body);
  assert.equal(body.get('Action'), 'SendMessage');
  assert.equal(body.get('MessageBody'), '{"job":1}');
  assert.equal(body.get('MessageGroupId'), 'group');
  assert.equal(body.get('MessageDeduplicationId'), 'dedupe');
  assert.equal(state.fetched.url, 'https://sqs.example.test/123/queue.fifo');
  assert.strictEqual(state.fetched.init.signal, signal);

  const source = fs.readFileSync(
    path.join(LAMBDA_ROOT, 'shared-lite', 'slack-sqs.ts'),
    'utf8'
  );
  assert.doesNotMatch(source, /client-sqs/);
});
