import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'faq-shell-timing-'));
process.on('exit', () => fs.rmSync(temporary, { recursive: true, force: true }));
const outfile = path.join(temporary, 'timing.mjs');
await build({
  stdin: {
    contents: [
      `export { createFaqHandler } from ${JSON.stringify(path.join(root, 'functions/faq-chat/handler.ts'))};`,
      `export { createStubFaqPorts } from ${JSON.stringify(path.join(root, 'functions/faq-chat/adapters/stub.ts'))};`,
      `export * from ${JSON.stringify(path.join(root, 'functions/faq-chat/shell-timing.ts'))};`,
    ].join('\n'),
    resolveDir: root, loader: 'ts',
  },
  outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent',
});
const runtime = await import(pathToFileURL(outfile).href);
const { createFaqHandler, createStubFaqPorts, runFaqShellTiming, emitFaqChatMetric,
  recordFaqShellDuration, recordFaqQaNotifyOutcome, finalizeFaqQaNotifyOutcome, recordFaqCredentialTiming,
  recordFaqRemoteAttemptTiming, recordFaqGenerateBudget } = runtime;
const CANARY = 'private-question contact@example.invalid secret-canary';
const event = (overrides = {}) => ({
  requestContext: { requestId: 'shell-id', http: { method: 'POST' } },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'こんにちは' }] }),
  ...overrides,
});
const ports = () => createStubFaqPorts({ retrieval: 'empty', settings: { enabled: true } });
const context = { getRemainingTimeInMillis: () => 30_000 };
const terminalMetric = (metrics) => {
  const terminal = metrics.filter(({ metric }) => metric === 'faq_shell_timing');
  assert.equal(terminal.length, 1);
  return terminal[0];
};
const loggedMetrics = (logs) => logs.filter(({ level, args }) => level === 'log' && typeof args[0] === 'string')
  .flatMap(({ args }) => { try { return [JSON.parse(args[0])]; } catch { return []; } });
const diagnosticError = () => Object.assign(new Error(CANARY), {
  name: 'ResourceNotFoundException',
  $metadata: { httpStatusCode: 404, requestId: CANARY },
  authorization: CANARY,
});
function assertSafeDiagnostic(logs) {
  const objects = logs.flatMap(({ args }) => args.flatMap((arg) => {
    if (typeof arg !== 'string') return [arg];
    try { return [JSON.parse(arg)]; } catch { return []; }
  }));
  const diagnostic = objects.find((value) => value?.error_name === 'ResourceNotFoundException');
  assert.ok(diagnostic, 'keeps the SDK error name for classification');
  assert.equal(diagnostic.http_status_code, 404);
  assert.equal(diagnostic.message, undefined);
  assert.equal(diagnostic.stack, undefined);
  assert.equal(diagnostic.$metadata, undefined);
  assert.doesNotMatch(JSON.stringify(logs), /private-question|contact@|secret-canary/);
}
async function capture(callback) {
  const logs = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const key of Object.keys(original)) console[key] = (...args) => logs.push({ level: key, args });
  try {
    const result = await callback(logs);
    const metrics = loggedMetrics(logs);
    return { result, logs, metrics };
  } finally {
    Object.assign(console, original);
  }
}

test('existing faq_chat stays separate from terminal QA and handler wall time', async () => {
  const originalNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  const configured = ports();
  configured.storage.loadSettings = async () => { now += 7; return { enabled: true }; };
  configured.storage.putQaLog = async () => { now += 41; };
  configured.storage.notifyQaLog = async () => { now += 31; };
  try {
    const { metrics, result } = await capture(() => createFaqHandler(configured)(event(), {
      getRemainingTimeInMillis: () => 40_000 - now,
    }));
    assert.equal(metrics.length, 2);
    const legacy = metrics.find(({ metric }) => metric === 'faq_chat');
    assert.equal(legacy.total_ms, 7);
    assert.equal(legacy.latency_ms, 7);
    assert.equal(legacy.settings_ms, 7);
    assert.equal(legacy.handler_total_ms, undefined);
    assert.equal(legacy.qa_write_ms, undefined);
    const metric = terminalMetric(metrics);
    for (const field of ['total_ms', 'latency_ms', 'route', 'model']) {
      assert.equal(Object.hasOwn(metric, field), false, field);
    }
    assert.equal(metric.handler_total_ms, 79);
    assert.equal(metric.settings_ms, 7);
    assert.equal(metric.qa_write_ms, 41);
    assert.equal(metric.qa_notify_ms, 31);
    assert.equal(metric.qa_write_outcome, 'success');
    assert.equal(metric.qa_notify_outcome, 'success');
    assert.equal(metric.remaining_start_ms, 30_000);
    assert.equal(metric.remaining_return_ms, 29_921);
    assert.equal(metric.generate_end_reason, 'skipped');
    assert.equal(metric.effective_generate_timeout_ms, null);
    assert.equal(metric.requestId, result.headers['x-faq-request-id']);
    assert.equal(metric.requestId, legacy.requestId);
    assert.equal(metric.coldStart, true);
  } finally { Date.now = originalNow; }
});

test('faq_chat is observable while QA is pending, before a hard timeout could omit terminal telemetry', async () => {
  const configured = ports();
  let releaseQa;
  let qaStarted;
  const started = new Promise((resolve) => { qaStarted = resolve; });
  configured.storage.putQaLog = () => {
    qaStarted();
    return new Promise((resolve) => { releaseQa = resolve; });
  };
  const { metrics, result } = await capture(async (logs) => {
    let completed = false;
    const pending = createFaqHandler(configured)(event(), context).then((response) => {
      completed = true;
      return response;
    });
    try {
      await started;
      const beforeQa = loggedMetrics(logs);
      assert.equal(completed, false);
      assert.equal(beforeQa.length, 1);
      assert.equal(beforeQa[0].metric, 'faq_chat');
      assert.equal(beforeQa[0].requestId, 'shell-id');
      assert.equal(beforeQa[0].handler_total_ms, undefined);
    } finally {
      releaseQa();
      await pending;
    }
    return pending;
  });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(metrics.map(({ metric }) => metric), ['faq_chat', 'faq_shell_timing']);
  assert.equal(terminalMetric(metrics).requestId, metrics[0].requestId);
});

test('multiple response metrics are emitted unchanged and shell fields cannot overwrite them', async () => {
  const first = { metric: 'faq_chat', requestId: 'multiple', settings_ms: 11, router_ms: 13, total_ms: 17, route: 'first' };
  const second = { metric: 'faq_chat', requestId: 'multiple', settings_ms: 19, router_ms: 23, total_ms: 29, route: 'second' };
  const { metrics } = await capture(async (logs) => {
    await runFaqShellTiming({ requestId: 'multiple', coldStart: false }, async () => {
      recordFaqShellDuration('settings_ms', 101);
      recordFaqShellDuration('router_ms', 103);
      emitFaqChatMetric(first);
      emitFaqChatMetric(second);
      assert.deepEqual(loggedMetrics(logs), [first, second]);
    });
  });
  assert.deepEqual(metrics.filter(({ metric }) => metric === 'faq_chat'), [first, second]);
  const terminal = terminalMetric(metrics);
  assert.equal(terminal.settings_ms, 101);
  assert.equal(terminal.router_ms, 103);
  assert.equal(terminal.requestId, first.requestId);
  assert.equal(Object.hasOwn(terminal, 'total_ms'), false);
  assert.equal(Object.hasOwn(terminal, 'route'), false);
  assert.equal(terminal.metric.includes('faq_chat'), false);
});

test('early HTTP exits emit outer telemetry without inventing existing total_ms', async () => {
  for (const [httpEvent, setting, statusCode] of [
    [event({ requestContext: { http: { method: 'OPTIONS' } } }), { enabled: true }, 204],
    [event({ requestContext: { http: { method: 'GET' } } }), { enabled: true }, 405],
    [event(), { enabled: false }, 503],
    [event({ body: '{' }), { enabled: true }, 400],
  ]) {
    const configured = createStubFaqPorts({ settings: setting });
    const { metrics, result } = await capture(() => createFaqHandler(configured)(httpEvent));
    assert.equal(result.statusCode, statusCode);
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0].metric, 'faq_shell_timing');
    assert.equal(metrics[0].total_ms, undefined);
    assert.equal(metrics[0].remaining_start_ms, null);
    assert.equal(metrics[0].remaining_return_ms, null);
    assert.equal(metrics[0].qa_write_outcome, 'skipped');
  }
});

test('settings and named-config exceptions keep safe SDK diagnostics and terminal metrics', async () => {
  for (const named of [false, true]) {
    const configured = ports();
    if (named) configured.agentConfig.resolveAgentProfile = async () => { throw diagnosticError(); };
    else configured.storage.loadSettings = async () => { throw diagnosticError(); };
    const { result, metrics, logs } = await capture(() => createFaqHandler(configured)(
      event(named ? { pathParameters: { agentId: 'sample' } } : {}), context
    ));
    assert.equal(result.statusCode, named ? 404 : 503);
    const terminal = terminalMetric(metrics);
    assert.equal(terminal.qa_write_outcome, 'skipped');
    assertSafeDiagnostic(logs);
  }
});

test('QA write rejection keeps safe diagnostics without notification or error message', async () => {
  const configured = ports();
  let calls = 0;
  configured.storage.putQaLog = async () => { throw diagnosticError(); };
  configured.storage.notifyQaLog = async () => { calls += 1; };
  const { result, metrics, logs } = await capture(() => createFaqHandler(configured)(event(), context));
  assert.equal(result.statusCode, 200);
  assert.equal(calls, 0);
  assert.equal(terminalMetric(metrics).qa_write_outcome, 'failure');
  assert.equal(terminalMetric(metrics).qa_notify_outcome, 'skipped');
  assertSafeDiagnostic(logs);
});

test('named effective limit rejection retains its model classification', async () => {
  const model = 'claude-haiku-4-5-20251001';
  const configured = createStubFaqPorts({
    settings: { enabled: true, model, maxOutputTokens: Number.NaN },
    agentProfiles: [{ agentId: 'sample', enabled: true }],
  });
  const { result, logs } = await capture(() => createFaqHandler(configured)(
    event({ pathParameters: { agentId: 'sample' } }), context
  ));
  assert.equal(result.statusCode, 404);
  const warning = logs.filter(({ level }) => level === 'warn')
    .map(({ args }) => JSON.parse(args[0]))
    .find(({ reason }) => reason === 'effective_limits_invalid');
  assert.ok(warning);
  assert.equal(warning.model, model);
});

test('notifier outcomes distinguish delivery, disabled, queued async, timeout and failure', async () => {
  for (const outcome of ['success', 'disabled', 'skipped', 'timeout', 'failure']) {
    const configured = ports();
    configured.storage.notifyQaLog = async () => { recordFaqQaNotifyOutcome(outcome); };
    const { metrics } = await capture(() => createFaqHandler(configured)(event(), context));
    assert.equal(terminalMetric(metrics).qa_write_outcome, 'success');
    assert.equal(terminalMetric(metrics).qa_notify_outcome, outcome);
  }
  const configured = ports();
  configured.storage.notifyQaLog = async () => {
    recordFaqQaNotifyOutcome('success');
    throw new Error(CANARY);
  };
  const { metrics, logs } = await capture(() => createFaqHandler(configured)(event(), context));
  assert.equal(terminalMetric(metrics).qa_notify_outcome, 'failure');
  assert.doesNotMatch(JSON.stringify(logs), /private-question|contact@|secret-canary/);
});

test('notification finalization preserves explicit outcomes and ignores late results before terminal emission', async () => {
  for (const [observed, settled, expected] of [
    [undefined, 'success', 'success'],
    ['disabled', 'success', 'disabled'],
    ['skipped', 'success', 'skipped'],
    ['timeout', 'success', 'timeout'],
    ['failure', 'success', 'failure'],
    ['success', 'timeout', 'timeout'],
    ['success', 'failure', 'failure'],
  ]) {
    const { metrics } = await capture(() => runFaqShellTiming({ requestId: 'notify', coldStart: false }, async () => {
      if (observed !== undefined) recordFaqQaNotifyOutcome(observed);
      finalizeFaqQaNotifyOutcome(settled);
      await Promise.resolve();
      recordFaqQaNotifyOutcome('success');
      recordFaqQaNotifyOutcome('failure');
      finalizeFaqQaNotifyOutcome('success');
    }));
    assert.equal(terminalMetric(metrics).qa_notify_outcome, expected);
  }
});

test('QA timeout returns before late work and never starts notification', async () => {
  const configured = ports();
  let finish;
  let calls = 0;
  configured.storage.putQaLog = () => new Promise((resolve) => { finish = resolve; });
  configured.storage.notifyQaLog = async () => { calls += 1; };
  const { metrics } = await capture(() => createFaqHandler(configured)(event(), {
    getRemainingTimeInMillis: () => 810,
  }));
  assert.equal(terminalMetric(metrics).qa_write_outcome, 'timeout');
  assert.equal(terminalMetric(metrics).qa_notify_outcome, 'skipped');
  finish();
  await Promise.resolve();
  assert.equal(calls, 0);
});

test('handler bounds a notifier that does not honor its timeout', async () => {
  const configured = ports();
  configured.storage.notifyQaLog = () => new Promise(() => {});
  const { metrics, result } = await capture(() => createFaqHandler(configured)(event(), {
    getRemainingTimeInMillis: () => 810,
  }));
  assert.equal(result.statusCode, 200);
  assert.equal(terminalMetric(metrics).qa_notify_outcome, 'timeout');
  assert.equal(terminalMetric(metrics).qa_write_outcome, 'success');
});

test('timing recorder projects enums and numeric fields; unknown keys never enter logs', async () => {
  const { metrics, logs } = await capture(() => runFaqShellTiming({ requestId: 'safe', coldStart: true }, async () => {
    recordFaqCredentialTiming({ credential_cache: 'cold', credential_wait_ms: 12, assume_role_ms: 10,
      assume_role_attempts: 2, outcome: 'success', text: CANARY });
    recordFaqRemoteAttemptTiming({ operation: 'retrieve', attempt: 1, signing_ms: 2, http_headers_ms: 3,
      body_parse_ms: 4, retry_wait_ms: 5, outcome: 'success', authorization: CANARY });
    recordFaqRemoteAttemptTiming({ operation: CANARY, attempt: 1, outcome: 'success' });
    recordFaqCredentialTiming({ credential_cache: CANARY, outcome: 'failure' });
    recordFaqQaNotifyOutcome(CANARY);
    recordFaqGenerateBudget({ generate_end_reason: CANARY });
    recordFaqShellDuration(CANARY, 1);
  }));
  assert.equal(metrics[0].credential_events.length, 1);
  assert.equal(metrics[0].remote_attempts.length, 1);
  assert.equal(metrics[0].assume_role_attempts, 2);
  assert.equal(metrics[0].retrieve_attempts, 1);
  assert.equal(metrics[0].generate_end_reason, 'skipped');
  assert.doesNotMatch(JSON.stringify(logs), /private-question|contact@|secret-canary/);
});

test('concurrent invocations and detached work cannot mutate another invocation or a finalized metric', async () => {
  let finishLate;
  let late;
  const { metrics } = await capture(async () => {
    await runFaqShellTiming({ requestId: 'first', coldStart: true }, async () => {
      late = new Promise((resolve) => { finishLate = resolve; }).then(() => {
        recordFaqShellDuration('qa_write_ms', 999);
        recordFaqQaNotifyOutcome('failure');
        emitFaqChatMetric({ metric: 'faq_chat', text: CANARY });
      });
      recordFaqShellDuration('qa_write_ms', 3);
      emitFaqChatMetric({ metric: 'faq_chat', total_ms: 2 });
    });
    await runFaqShellTiming({ requestId: 'second', coldStart: false }, async () => {
      finishLate();
      await late;
      recordFaqShellDuration('qa_write_ms', 5);
    });
  });
  assert.equal(metrics.length, 3);
  assert.deepEqual(metrics[0], { metric: 'faq_chat', total_ms: 2 });
  const terminal = metrics.filter(({ metric }) => metric === 'faq_shell_timing');
  assert.equal(terminal[0].requestId, 'first');
  assert.equal(terminal[0].qa_write_ms, 3);
  assert.equal(terminal[1].requestId, 'second');
  assert.equal(terminal[1].qa_write_ms, 5);
  assert.equal(terminal[1].qa_notify_outcome, 'skipped');
  assert.doesNotMatch(JSON.stringify(metrics), /private-question|contact@|secret-canary/);
});

test('outer exceptions finalize one safe event and preserve rejection behavior', async () => {
  const { metrics, logs } = await capture(async () => {
    await assert.rejects(runFaqShellTiming({ requestId: 'safe', coldStart: true }, async () => {
      throw new Error(CANARY);
    }), /secret-canary/);
  });
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].handler_outcome, 'failure');
  assert.doesNotMatch(JSON.stringify(logs), /private-question|contact@|secret-canary/);
});

test('generation budget and final reason distinguish valid, invalid, refused, failed and skipped calls', async () => {
  for (const [answerGeneration, available, reason] of [
    ['envelope', 30_000, 'success'],
    ['invalid_json', 30_000, 'invalid_response'],
    ['max_tokens', 30_000, 'truncated'],
    [{ stopReason: 'refusal' }, 30_000, 'refused'],
    ['null', 30_000, 'failure'],
    ['envelope', 6_000, 'skipped'],
  ]) {
    const configured = createStubFaqPorts({ settings: { enabled: true }, retrieval: 'normal',
      entries: [{ id: 'sample', topic: '料金', content: '料金は500円です。' }], answerGeneration });
    const { metrics } = await capture(() => createFaqHandler(configured)(event({
      body: JSON.stringify({ messages: [{ role: 'user', content: '料金について' }] }),
    }), { getRemainingTimeInMillis: () => available }));
    const terminal = terminalMetric(metrics);
    assert.equal(terminal.generate_end_reason, reason);
    assert.equal(terminal.remaining_at_generate_start_ms, available - 2_500);
    assert.equal(terminal.effective_generate_timeout_ms, Math.min(20_000, available - 2_500));
    assert.equal(configured.answerGeneration.calls.length, reason === 'skipped' ? 0 : 1);
  }
});

test('generation without Lambda context reports unknown remaining time and the configured default cap', async () => {
  const configured = createStubFaqPorts({ settings: { enabled: true }, retrieval: 'normal',
    entries: [{ id: 'sample', topic: '料金', content: '料金は500円です。' }], answerGeneration: 'envelope' });
  const { metrics } = await capture(() => createFaqHandler(configured)(event({
    body: JSON.stringify({ messages: [{ role: 'user', content: '料金について' }] }),
  })));
  const terminal = terminalMetric(metrics);
  assert.equal(terminal.generate_end_reason, 'success');
  assert.equal(terminal.remaining_at_generate_start_ms, null);
  assert.equal(terminal.effective_generate_timeout_ms, 20_000);
  assert.equal(configured.answerGeneration.calls.length, 1);
});
