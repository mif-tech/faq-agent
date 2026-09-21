import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'faq-notify-worker-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
const output = path.join(temp, 'worker.mjs');
await build({
  entryPoints: [path.join(root, 'functions/faq-qa-notify-worker/handler.ts')],
  outfile: output, bundle: true, format: 'esm', platform: 'node', target: 'node22',
  plugins: [{ name: 'no-network', setup(esbuild) {
    // Use the allowlisted shared module in both generated-tree and raw-overlay tests.
    esbuild.onResolve({ filter: /shell-timing\.js$/ }, () => {
      const relative = 'functions/faq-chat/shell-timing.ts';
      const local = path.join(root, relative);
      return { path: fs.existsSync(local) ? local : path.resolve(root, '../../../../lambda', relative) };
    });
    esbuild.onResolve({ filter: /^@aws-sdk\// }, ({ path }) => ({ path, namespace: 'test' }));
    esbuild.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
      contents: `export class DynamoDBClient {}
          export class DynamoDBDocumentClient {
            static from() {
              return { send(command) {
                if (!globalThis.__faqNotifyTestClient) throw new Error('live client prohibited');
                return globalThis.__faqNotifyTestClient.send(command);
              } };
            }
          }
          export class GetCommand { constructor(input) { this.input = input; this.kind = 'get'; } }
          export class UpdateCommand { constructor(input) { this.input = input; this.kind = 'update'; } }`,
      loader: 'js',
    }));
  } }],
});
const {
  handler, createFaqQaNotifyWorker, createDynamoNotifyStore, NOTIFY_LEASE_MS, COMPLETE_RESERVE_MS,
} = await import(pathToFileURL(output));

const qa = {
  dateBucket: '2026-09-01', ts: '2026-09-01T00:00:00.000Z#synthetic',
  question: 'BODY_CANARY', answer: 'ANSWER_CANARY', responseType: 'kb_answer', route: 'kb_answer',
  scopeFallback: false, failureKind: null, guardDetail: null, sources: [], model: null, totalMs: 100,
  qaNotifyDelivery: 'async-v1',
};
const key = { dateBucket: qa.dateBucket, ts: qa.ts };
function insert(sequence = '100', delivery = 'async-v1') {
  return {
    eventName: 'INSERT',
    dynamodb: { SequenceNumber: sequence, Keys: { dateBucket: { S: qa.dateBucket }, ts: { S: qa.ts } },
      NewImage: { qaNotifyDelivery: { S: delivery } } },
  };
}
function runtime(overrides = {}) {
  let row = { ...qa };
  let clock = 1000;
  let sends = 0;
  const operations = [];
  // Emulate Dynamo conditional contention against a single durable item; the
  // real store below must issue owner-fenced conditions and exact table keys.
  const client = { async send(command) {
    operations.push(command);
    const input = command.input;
    assert.equal(input.TableName, 'test-notify-FaqQaLogs');
    assert.deepEqual(input.Key, key);
    if (command.kind === 'get') {
      assert.equal(input.ConsistentRead, true);
      return { Item: row && { ...row } };
    }
    const values = input.ExpressionAttributeValues;
    const conditional = () => { throw Object.assign(new Error('private canary'), { name: 'ConditionalCheckFailedException' }); };
    if (input.ReturnValues === 'ALL_NEW') {
      assert.match(input.ConditionExpression, /attribute_exists\(#ts\).*#delivery = :async/u);
      assert.equal(input.ExpressionAttributeNames['#status'], 'qaNotifyStatus');
      if (!row || row.qaNotifyDelivery !== values[':async'] ||
          (row.qaNotifyStatus !== undefined &&
            !(row.qaNotifyStatus === 'sending' && row.qaNotifyLeaseUntil <= values[':now']))) conditional();
      row = { ...row, qaNotifyStatus: 'sending', qaNotifyOwner: values[':owner'],
        qaNotifyLeaseUntil: values[':lease'], qaNotifySequenceNumber: values[':sequence'] };
      overrides.afterClaim?.();
      return { Attributes: { ...row } };
    }
    assert.equal(input.ConditionExpression, '#status = :sending AND #owner = :owner');
    if (!row || row.qaNotifyStatus !== 'sending' || row.qaNotifyOwner !== values[':owner']) conditional();
    if (values[':sent']) {
      overrides.beforeComplete?.();
      if (overrides.commitFailure?.()) throw new Error('commit BODY_CANARY');
      row.qaNotifyStatus = 'sent';
      delete row.qaNotifyOwner;
      delete row.qaNotifyLeaseUntil;
    } else row.qaNotifyLeaseUntil = values[':expired'];
    return {};
  } };
  const store = createDynamoNotifyStore(client, 'test-notify-FaqQaLogs');
  const worker = createFaqQaNotifyWorker({ store, now: () => clock, send: async (record, budgetMs) => {
    sends += 1;
    assert.equal(record.question, qa.question);
    return overrides.send ? overrides.send(record, budgetMs) : 'success';
  } });
  return { worker, store, client, operations, sends: () => sends, row: () => row,
    setRow: (value) => { row = value; }, tick: (ms) => { clock += ms; } };
}

test('successful delivery is committed once; duplicate stream invocation is suppressed', async () => {
  const rt = runtime();
  assert.deepEqual(await rt.worker({ Records: [insert(), insert()] }), { batchItemFailures: [] });
  assert.equal(rt.sends(), 1);
  assert.equal(rt.row().qaNotifyStatus, 'sent');
  assert.equal(rt.row().qaNotifySequenceNumber, '100');
  assert.equal(rt.row().qaNotifyOwner, undefined);
});

test('stream send budget keeps the 10-second cap and context-free fallback', async () => {
  for (const context of [undefined, { getRemainingTimeInMillis: () => 15_000 }]) {
    const budgets = [];
    const rt = runtime({ send: (_record, budgetMs) => {
      budgets.push(budgetMs);
      return 'success';
    } });
    assert.deepEqual(await rt.worker({ Records: [insert()] }, context), { batchItemFailures: [] });
    assert.deepEqual(budgets, [10_000]);
  }
});

test('exported handler uses post-claim remaining time and leaves the completion reserve', async () => {
  const keys = ['FAQ_TABLE_NAME_PREFIX', 'FAQ_QA_LOGS_TABLE_NAME', 'FAQ_QA_NOTIFY_WEBHOOK_URL'];
  const oldEnv = Object.fromEntries(keys.map((name) => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  const originalClient = globalThis.__faqNotifyTestClient;
  let remainingMs = 15_000;
  let sendBudget;
  let completionRemaining;
  const rt = runtime({
    afterClaim: () => { remainingMs -= 9000; },
    beforeComplete: () => { completionRemaining = remainingMs; },
  });
  try {
    process.env.FAQ_TABLE_NAME_PREFIX = 'test-notify';
    process.env.FAQ_QA_LOGS_TABLE_NAME = 'test-notify-FaqQaLogs';
    process.env.FAQ_QA_NOTIFY_WEBHOOK_URL = 'https://hooks.slack.com/services/TEST/ONLY/SYNTHETIC';
    globalThis.__faqNotifyTestClient = rt.client;
    AbortSignal.timeout = (budgetMs) => {
      sendBudget = budgetMs;
      return new AbortController().signal;
    };
    globalThis.fetch = async (_url, options) => {
      assert.equal(options.method, 'POST');
      remainingMs -= sendBudget;
      return new Response(null, { status: 200 });
    };
    const context = { getRemainingTimeInMillis: () => remainingMs };
    assert.deepEqual(await handler({ Records: [insert()] }, context), { batchItemFailures: [] });
    assert.equal(sendBudget, 4000, 'claim time must be deducted before assigning the HTTP timeout');
    assert.equal(completionRemaining, COMPLETE_RESERVE_MS);
    assert.equal(rt.row().qaNotifyStatus, 'sent');
  } finally {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
    if (originalClient === undefined) delete globalThis.__faqNotifyTestClient;
    else globalThis.__faqNotifyTestClient = originalClient;
    for (const name of keys) {
      if (oldEnv[name] === undefined) delete process.env[name];
      else process.env[name] = oldEnv[name];
    }
  }
});

test('zero or exhausted send budget releases the claim for retry without sending', async () => {
  for (const remainingMs of [COMPLETE_RESERVE_MS, COMPLETE_RESERVE_MS - 1, 0]) {
    const rt = runtime();
    const context = { getRemainingTimeInMillis: () => remainingMs };
    assert.deepEqual(await rt.worker({ Records: [insert()] }, context), {
      batchItemFailures: [{ itemIdentifier: '100' }],
    });
    assert.equal(rt.sends(), 0);
    assert.equal(rt.row().qaNotifyLeaseUntil, 0);
    assert.equal(rt.row().qaNotifyStatus, 'sending');
    assert.deepEqual(await rt.worker({ Records: [insert()] }), { batchItemFailures: [] });
    assert.equal(rt.sends(), 1);
  }
});

test('only async INSERT owns delivery, including after the deployment flag is rolled back', async () => {
  const rt = runtime();
  const sync = insert('1', 'sync-v1');
  const disabled = insert('2', 'disabled');
  const historical = insert('3');
  delete historical.dynamodb.NewImage.qaNotifyDelivery;
  const modify = { ...insert('4'), eventName: 'MODIFY' };
  const remove = { ...insert('5'), eventName: 'REMOVE' };
  assert.deepEqual(await rt.worker({ Records: [sync, disabled, historical, modify, remove] }), { batchItemFailures: [] });
  assert.equal(rt.operations.length, 0);
  assert.deepEqual(await rt.worker({ Records: [insert()] }), { batchItemFailures: [] });
  assert.equal(rt.sends(), 1, 'worker does not consult the caller deployment flag');
});

test('missing QA row (including failed Put) never sends and returns a retry identifier', async () => {
  const rt = runtime();
  rt.setRow(undefined);
  assert.deepEqual(await rt.worker({ Records: [insert('123')] }), { batchItemFailures: [{ itemIdentifier: '123' }] });
  assert.equal(rt.sends(), 0);
});

test('active owner is retried without a concurrent send and becomes claimable after lease expiry', async () => {
  const rt = runtime();
  assert.equal((await rt.store.claim(key, 'owner-one', 1000, '100')).state, 'claimed');
  assert.deepEqual(await rt.worker({ Records: [insert()] }), { batchItemFailures: [{ itemIdentifier: '100' }] });
  assert.equal(rt.sends(), 0);
  rt.tick(NOTIFY_LEASE_MS);
  assert.deepEqual(await rt.worker({ Records: [insert()] }), { batchItemFailures: [] });
  assert.equal(rt.sends(), 1);
});

test('an old lease owner cannot complete or release the current delivery', async () => {
  const rt = runtime();
  await rt.store.claim(key, 'owner-one', 1000, '100');
  await rt.store.claim(key, 'owner-two', 1000 + NOTIFY_LEASE_MS, '100');
  await assert.rejects(rt.store.complete(key, 'owner-one'), { name: 'ConditionalCheckFailedException' });
  await assert.rejects(rt.store.release(key, 'owner-one'), { name: 'ConditionalCheckFailedException' });
  assert.equal(rt.row().qaNotifyOwner, 'owner-two');
});

test('HTTP failure, timeout, disabled destination, and skipped send remain retryable', async () => {
  for (const outcome of ['failure', 'timeout', 'disabled', 'skipped']) {
    let fail = true;
    const rt = runtime({ send: () => fail ? outcome : 'success' });
    assert.deepEqual(await rt.worker({ Records: [insert()] }), { batchItemFailures: [{ itemIdentifier: '100' }] });
    assert.equal(rt.row().qaNotifyLeaseUntil, 0);
    fail = false;
    assert.deepEqual(await rt.worker({ Records: [insert()] }), { batchItemFailures: [] });
    assert.equal(rt.sends(), 2);
  }
});

test('send/commit failure retains lease then can duplicate on retry, without claiming exactly once', async () => {
  let failCommit = true;
  const rt = runtime({ commitFailure: () => failCommit });
  assert.deepEqual(await rt.worker({ Records: [insert()] }), { batchItemFailures: [{ itemIdentifier: '100' }] });
  assert.equal(rt.sends(), 1);
  assert.equal(rt.row().qaNotifyLeaseUntil, 1000 + NOTIFY_LEASE_MS);
  failCommit = false;
  rt.tick(NOTIFY_LEASE_MS);
  assert.deepEqual(await rt.worker({ Records: [insert()] }), { batchItemFailures: [] });
  assert.equal(rt.sends(), 2, 'Slack send and DynamoDB commit cannot be atomic');
});

test('persistent failure stays in ReportBatchItemFailures for event-source retry exhaustion/DLQ', async () => {
  const rt = runtime({ send: () => 'failure' });
  for (let attempt = 0; attempt <= 10; attempt += 1) {
    assert.deepEqual(await rt.worker({ Records: [insert('789')] }), { batchItemFailures: [{ itemIdentifier: '789' }] });
  }
  assert.equal(rt.row().qaNotifyStatus, 'sending');
  assert.equal(rt.sends(), 11);
});

test('malformed owned records retry and never log body, key, webhook, or error text', async () => {
  const infos = [];
  const oldWarn = console.warn;
  const oldInfo = console.info;
  console.warn = console.info = (...args) => infos.push(args.join(' '));
  try {
    const rt = runtime({ send: () => { throw new Error('BODY_CANARY secret-url'); } });
    const malformed = insert('200');
    delete malformed.dynamodb.Keys;
    assert.deepEqual(await rt.worker({ Records: [malformed, insert('300')] }), {
      batchItemFailures: [{ itemIdentifier: '200' }, { itemIdentifier: '300' }],
    });
    assert.deepEqual(infos, ['faq_qa_notify_worker outcome=failure', 'faq_qa_notify_worker outcome=failure']);
  } finally { console.warn = oldWarn; console.info = oldInfo; }
});

test('missing sequence on an owned record rejects whole batch instead of acknowledging data loss', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  const malformed = insert();
  delete malformed.dynamodb.SequenceNumber;
  const rt = runtime();
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await assert.rejects(rt.worker({ Records: [malformed] }), /QA_NOTIFY_MISSING_SEQUENCE/u);
    assert.equal(rt.operations.length, 0);
    assert.deepEqual(warnings, ['faq_qa_notify_worker outcome=failure']);
  } finally { console.warn = originalWarn; }
});
