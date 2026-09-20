import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { before, test } from 'node:test';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'faq-inflight-'));
process.on('exit', () => fs.rmSync(temporary, { recursive: true, force: true }));
let runtime;
before(async () => {
  const outfile = path.join(temporary, 'runtime.mjs');
  await build({
    stdin: {
      contents: [
        `export * from ${JSON.stringify(path.join(root, 'functions/faq-chat/adapters/inflight.ts'))};`,
        `export { createFaqHandler } from ${JSON.stringify(path.join(root, 'functions/faq-chat/handler.ts'))};`,
        `export { createStubFaqPorts } from ${JSON.stringify(path.join(root, 'functions/faq-chat/adapters/stub.ts'))};`,
      ].join('\n'),
      resolveDir: root, loader: 'ts',
    },
    outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent',
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
  runtime = await import(pathToFileURL(outfile).href);
});

function fakeState(maxInflight = 2, ownerToken) {
  const rows = new Map();
  const calls = [];
  let now = 1_000;
  let nextToken = 0;
  const conflict = () => { throw Object.assign(new Error('conflict'), { name: 'ConditionalCheckFailedException' }); };
  const client = {
    async send(command) {
      const input = command.input;
      calls.push(input);
      assert.equal(input.TableName, 'unit-Settings');
      assert.deepEqual(Object.keys(input.Key), ['key']);
      assert.match(input.Key.key, /^faq_inflight_slot#[0-9]$/);
      assert.equal(input.ExpressionAttributeNames['#value'], 'value');
      assert.equal(input.ExpressionAttributeNames['#leaseUntil'], 'leaseUntil');
      const row = rows.get(input.Key.key);
      if (input.UpdateExpression === 'SET #value = :lease') {
        assert.equal(input.ConditionExpression, 'attribute_not_exists(#value.#leaseUntil) OR #value.#leaseUntil < :now');
        if (row?.value.leaseUntil !== undefined && row.value.leaseUntil >= input.ExpressionAttributeValues[':now']) conflict();
        rows.set(input.Key.key, { ...input.Key, value: { ...input.ExpressionAttributeValues[':lease'] } });
      } else {
        assert.equal(input.UpdateExpression, 'REMOVE #value.#leaseUntil');
        assert.equal(input.ConditionExpression, '#value.#ownerToken = :ownerToken');
        assert.equal(input.ExpressionAttributeNames['#ownerToken'], 'ownerToken');
        if (row?.value.ownerToken !== input.ExpressionAttributeValues[':ownerToken']) conflict();
        delete row.value.leaseUntil;
      }
      return {};
    },
  };
  const port = runtime.createDynamoFaqInflightPort({
    client, tableName: 'unit-Settings', maxInflight,
    now: () => now, ownerToken: ownerToken ?? (() => `owner-${++nextToken}`),
  });
  return { port, rows, calls, client, advance: (milliseconds) => { now += milliseconds; } };
}

test('zero/default capacity performs no state calls and configuration validates 0..10', async () => {
  assert.equal(runtime.readFaqMaxInflight({}), 0);
  for (let count = 0; count <= 10; count += 1) {
    assert.equal(runtime.readFaqMaxInflight({ FAQ_MAX_INFLIGHT: String(count) }), count);
  }
  for (const value of ['', ' ', '-1', '11', '1.5', '01', '1e0', 'NaN']) {
    assert.throws(() => runtime.readFaqMaxInflight({ FAQ_MAX_INFLIGHT: value }), /FAQ_MAX_INFLIGHT/);
  }
  const state = fakeState(0);
  assert.deepEqual(await state.port.acquire(NaN), { kind: 'disabled' });
  assert.equal(state.calls.length, 0);
});

test('acquire/release uses fixed Settings keys, remaining lifetime and no TTL', async () => {
  const state = fakeState(2);
  const lease = await state.port.acquire(41_234.2);
  assert.equal(lease.kind, 'acquired');
  const key = `faq_inflight_slot#${lease.slot}`;
  assert.deepEqual(state.rows.get(key), {
    key, value: { ownerToken: 'owner-1', leaseUntil: 42_235 },
  });
  await lease.release();
  await lease.release();
  assert.equal(state.rows.get(key).value.leaseUntil, undefined);
  assert.equal(state.calls.length, 2, 'release is idempotent');
  await assert.rejects(state.port.acquire(NaN), /remaining lifetime/);
  assert.equal(state.calls.length, 2);
});

test('owner tokens choose different deterministic starting slots', async () => {
  const firstSlots = [];
  for (const token of ['owner-0', 'owner-1', 'owner-0']) {
    const state = fakeState(3, () => token);
    const held = await state.port.acquire(30_000);
    assert.equal(held.kind, 'acquired');
    assert.equal(state.calls.length, 1);
    assert.equal(state.calls[0].Key.key, `faq_inflight_slot#${held.slot}`);
    firstSlots.push(held.slot);
    await held.release();
  }
  assert.notEqual(firstSlots[0], firstSlots[1]);
  assert.equal(firstSlots[0], firstSlots[2]);
});

test('N occupied slots reject N+1 immediately within N Updates without polling or sleep', async () => {
  const state = fakeState(2);
  const first = await state.port.acquire(30_000);
  const second = await state.port.acquire(30_000);
  assert.notEqual(first.slot, second.slot);
  const before = state.calls.length;
  const originalTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => { throw new Error('slot acquisition must not wait'); };
  try {
    assert.deepEqual(await state.port.acquire(30_000), { kind: 'busy' });
  } finally { globalThis.setTimeout = originalTimeout; }
  assert.equal(state.calls.length - before, 2);
  const attempted = state.calls.slice(before).map((call) => Number(call.Key.key.split('#')[1]));
  assert.deepEqual(attempted, [attempted[0], (attempted[0] + 1) % 2]);
  await first.release();
  const replacement = await state.port.acquire(30_000);
  assert.equal(replacement.slot, first.slot);
  await second.release();
  await replacement.release();
});

test('strict expiry enables reuse; the old owner cannot release a successor', async () => {
  const state = fakeState(1);
  const expired = await state.port.acquire(100);
  state.advance(100);
  assert.deepEqual(await state.port.acquire(200), { kind: 'busy' }, 'equality is still occupied');
  state.advance(1);
  const successor = await state.port.acquire(300);
  assert.equal(successor.kind, 'acquired');
  await expired.release();
  assert.deepEqual(state.rows.get('faq_inflight_slot#0').value, { ownerToken: 'owner-3', leaseUntil: 1_401 });
  await successor.release();
  assert.equal(state.rows.get('faq_inflight_slot#0').value.leaseUntil, undefined);
});

const event = (question = '料金について教えてください') => ({
  requestContext: { requestId: 'inflight-test', http: { method: 'POST' } },
  body: JSON.stringify({ messages: [{ role: 'user', content: question }] }),
});
const context = { getRemainingTimeInMillis: () => 45_123 };
async function capture(callback) {
  const logs = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const level of Object.keys(original)) console[level] = (...args) => logs.push({ level, args });
  try {
    const result = await callback();
    const metrics = logs.flatMap(({ args }) => {
      try { return [JSON.parse(args[0])]; } catch { return []; }
    });
    return { result, logs, timing: metrics.find((metric) => metric.metric === 'faq_shell_timing'), metrics };
  } finally { Object.assign(console, original); }
}
function assertBusy(response, retryAfter = '5') {
  assert.equal(response.statusCode, 429);
  assert.deepEqual(JSON.parse(response.body), { error: 'busy', retryable: true });
  assert.equal(response.headers['Retry-After'], retryAfter);
  assert.equal(response.headers['Access-Control-Allow-Methods'], 'POST, OPTIONS');
  assert.ok(response.headers['Access-Control-Allow-Origin']);
  assert.equal(response.headers['Cache-Control'], 'no-store');
}

test('shell busy precedes generated router and retrieval; input and templates skip admission', async () => {
  const ports = runtime.createStubFaqPorts({ settings: { enabled: true, smalltalkMode: 'generated' } });
  let calls = 0;
  ports.inflight = { async acquire(remainingMs) { calls += 1; assert.equal(remainingMs, 45_123); return { kind: 'busy' }; } };
  const handler = runtime.createFaqHandler(ports);
  const busy = await capture(() => handler(event(), context));
  assertBusy(busy.result);
  assert.equal(busy.timing.inflight_outcome, 'busy');
  assert.equal(busy.timing.inflight_slot, null);
  assert.equal(busy.timing.inflight_release_outcome, 'skipped');
  assert.equal(ports.smalltalkGeneration.calls.length, 0);
  assert.equal(ports.retrieval.calls.length, 0);
  const templatePorts = runtime.createStubFaqPorts({ settings: { enabled: true, smalltalkMode: 'template_only' } });
  templatePorts.inflight = ports.inflight;
  const template = await capture(() => runtime.createFaqHandler(templatePorts)(event('こんにちは'), context));
  assert.equal(template.result.statusCode, 200);
  assert.equal(template.timing.inflight_outcome, 'disabled');
  assert.equal(template.timing.inflight_release_outcome, 'skipped');
  const invalid = await capture(() => handler({ ...event(), body: '{' }, context));
  assert.equal(invalid.result.statusCode, 400);
  assert.equal(calls, 1);
});

test('shell releases after success and processing exceptions, retaining existing faq_chat metrics', async () => {
  for (const retrieval of ['empty', 'throw']) {
    const state = fakeState(2);
    const ports = runtime.createStubFaqPorts({ retrieval });
    ports.inflight = state.port;
    const result = await capture(() => runtime.createFaqHandler(ports)(event(), context));
    assert.equal(result.result.statusCode, retrieval === 'throw' ? 503 : 200);
    assert.equal(result.timing.inflight_outcome, 'acquired');
    const acquiredSlot = Number(state.calls[0].Key.key.split('#')[1]);
    assert.equal(acquiredSlot, 1, 'the owner starts at a nonzero slot');
    assert.equal(result.timing.inflight_slot, acquiredSlot);
    assert.equal(result.timing.inflight_release_outcome, 'success');
    assert.equal(state.rows.get(`faq_inflight_slot#${acquiredSlot}`).value.leaseUntil, undefined);
    const legacy = result.metrics.find((metric) => metric.metric === 'faq_chat');
    assert.ok(legacy);
    assert.equal(Object.hasOwn(legacy, 'inflight_outcome'), false);
    assert.equal(state.calls[0].ExpressionAttributeValues[':lease'].leaseUntil, 46_123);
  }
});

test('release failure only warns and retains expiry without changing the HTTP result', async () => {
  const ports = runtime.createStubFaqPorts({ retrieval: 'empty' });
  ports.inflight = { async acquire() { return { kind: 'acquired', slot: 0, async release() { throw new Error('secret'); } }; } };
  const result = await capture(() => runtime.createFaqHandler(ports)(event(), context));
  assert.equal(result.result.statusCode, 200);
  assert.equal(result.timing.inflight_release_outcome, 'failure');
  assert.equal(result.logs.filter((log) => log.level === 'warn').length, 1);
  assert.doesNotMatch(JSON.stringify(result.logs), /secret/);
});

for (const operation of ['retrieve', 'generate', 'answer']) {
  for (const [retryAfterMs, retryAfter] of [[1, '1'], [5_000, '5'], [12_000, '12'], [12_001, '13'], [86_400_000, '60']]) {
    test(`remote ${operation} busy ${retryAfterMs}ms becomes shell HTTP 429 with Retry-After ${retryAfter} and releases shell capacity`, async () => {
      const state = fakeState(1);
      const ports = runtime.createStubFaqPorts();
      ports.inflight = state.port;
      const busy = { contractVersion: 'remote-v1', ok: false, error: { code: 'busy', retryable: true, retryAfterMs } };
      let generateCalls = 0;
      const transport = operation === 'answer'
        ? { kind: 'one-shot-v1', port: { async answer() { return { ...busy, contractVersion: 'remote-answer-v1' }; } } }
        : { kind: 'split-v1', port: {
          async retrieve() {
            return operation === 'retrieve' ? busy : { contractVersion: 'remote-v1', ok: true, sessionToken: 'opaque', expiresAtEpochMs: 99_999 };
          },
          async generate() { generateCalls += 1; return busy; },
        } };
      const result = await capture(() => runtime.createFaqHandler(ports, transport)(event(), context));
      assertBusy(result.result, retryAfter);
      assert.equal(generateCalls, operation === 'generate' ? 1 : 0);
      assert.equal(result.timing.inflight_release_outcome, 'success');
      assert.equal(state.rows.get('faq_inflight_slot#0').value.leaseUntil, undefined);
      assert.equal(ports.storage.qaLogs.length, 0, 'busy never persists a refusal envelope');
    });
  }
}

test('remote deadline releases the shell lease after the pending refusal Q&A write completes', async () => {
  const state = fakeState(1);
  const ports = runtime.createStubFaqPorts();
  ports.inflight = state.port;
  let finishWrite;
  let signalWrite;
  const writeStarted = new Promise((resolve) => { signalWrite = resolve; });
  ports.storage.putQaLog = () => {
    signalWrite();
    return new Promise((resolve) => { finishWrite = resolve; });
  };
  const transport = { kind: 'one-shot-v1', port: {
    async answer() {
      return { contractVersion: 'remote-answer-v1', ok: false, error: { code: 'deadline_exceeded', retryable: true } };
    },
  } };
  const result = await capture(async () => {
    const pending = runtime.createFaqHandler(ports, transport)(event(), context);
    await writeStarted;
    try {
      assert.equal(state.calls.length, 1, 'response processing still owns its lease');
      assert.deepEqual(await state.port.acquire(10_000), { kind: 'busy' });
    } finally { finishWrite(); }
    return pending;
  });
  assert.equal(result.result.statusCode, 200, 'existing deadline refusal contract is unchanged');
  assert.equal(result.timing.generate_end_reason, 'timeout');
  assert.equal(result.timing.inflight_release_outcome, 'success');
  assert.equal(state.rows.get('faq_inflight_slot#0').value.leaseUntil, undefined);
});

test('existing UI consumes HTTP 429 without changes', () => {
  const source = fs.readFileSync(path.join(root, '..', 'faq', 'app.js'), 'utf8');
  assert.match(source, /result\.status === 429/);
  assert.match(source, /アクセスが集中しています/);
});
