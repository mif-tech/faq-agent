import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAQ_ROOT = path.join(HERE, '..', 'functions', 'faq-chat');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faq-answer-client-test-'));
const timingModulePath = '../../shell-timing.js';
// Keep client and invocation timing in the same bundle/AsyncLocalStorage instance.
const timingTestExports = {
  name: 'timing-test-exports',
  setup(builder) {
    builder.onLoad({ filter: /remote[\\/]http-client\.ts$/ }, (args) => ({
      contents: fs.readFileSync(args.path, 'utf8') +
        '\nexport { runFaqShellTiming } from ' + JSON.stringify(timingModulePath) + ';' +
        "\nexport { STSClient as TestSTSClient } from '@aws-sdk/client-sts';",
      loader: 'ts',
    }));
  },
};
await build({
  entryPoints: {
    client: path.join(FAQ_ROOT, 'adapters', 'remote', 'http-client.ts'),
    contract: path.join(FAQ_ROOT, 'adapters', 'remote', 'answer-contract.ts'),
  },
  bundle: true, format: 'esm', platform: 'node', outdir: outDir,
  outExtension: { '.js': '.mjs' },
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  plugins: [timingTestExports],
});
const { createRemoteFaqRagAnswerHttpClient, createRemoteFaqRagHttpClient, runFaqShellTiming, TestSTSClient } = await import(
  pathToFileURL(path.join(outDir, 'client.mjs')).href
);
const { parseRemoteOneShotAnswerResponse } = await import(pathToFileURL(path.join(outDir, 'contract.mjs')).href);
const signerTestKey = Symbol.for('faq-answer-signer-test');
await build({
  entryPoints: [path.join(FAQ_ROOT, 'adapters', 'remote', 'http-client.ts')],
  bundle: true, format: 'esm', platform: 'node', outfile: path.join(outDir, 'stalled-signer.mjs'),
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  plugins: [timingTestExports, {
    name: 'controlled-signer',
    setup(builder) {
      builder.onResolve({ filter: /^@smithy\/signature-v4$/ }, () => ({ path: 'signer', namespace: 'test' }));
      builder.onLoad({ filter: /^signer$/, namespace: 'test' }, () => ({
        contents: "export class SignatureV4 { sign(request) { return globalThis[Symbol.for('faq-answer-signer-test')](request); } }",
        loader: 'js',
      }));
    },
  }],
});
const {
  createRemoteFaqRagAnswerHttpClient: createClientWithControlledSigner,
  createRemoteFaqRagHttpClient: createSplitWithControlledSigner,
  runFaqShellTiming: runWithControlledSignerTiming,
} = await import(
  pathToFileURL(path.join(outDir, 'stalled-signer.mjs')).href
);
const golden = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'faq-chat-remote-one-shot-v1.golden.json'), 'utf8'));
const splitGolden = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'faq-chat-remote-v1.golden.json'), 'utf8'));
const request = JSON.parse(golden.request);
const success = golden.responses[0];
const noMatch = golden.responses.find((item) => item.statusCode === 404);
const ENV = {
  FAQ_REMOTE_RAG_BASE_URL: 'https://example.execute-api.us-west-2.amazonaws.com/api/',
  AWS_REGION: 'us-west-2',
};
const credentials = async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'example-secret', sessionToken: 'example-session' });
const common = { env: ENV, credentialsProvider: credentials, now: () => 1_900_000_000_000 };
const response = (fixture) => new Response(fixture.body, { status: fixture.statusCode });

after(() => {
  assert.equal(path.dirname(path.resolve(outDir)), path.resolve(os.tmpdir()));
  fs.rmSync(outDir, { recursive: true, force: true });
});

async function captureErrors(run) {
  const entries = [];
  const original = console.error;
  console.error = (...args) => entries.push(args.map(String).join(' '));
  try { return { value: await run(), entries }; }
  finally { console.error = original; }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

async function captureTiming(run, timing = runFaqShellTiming) {
  const entries = [];
  const original = console.log;
  console.log = (entry) => entries.push(JSON.parse(entry));
  try {
    const value = await timing({ requestId: 'shell-timing-test', coldStart: false }, run);
    assert.equal(entries.length, 1);
    return { value, metric: entries[0] };
  } finally {
    console.log = original;
  }
}

test('every one-shot golden crosses one signed /answer request without retry or DTO changes', async () => {
  for (const fixture of golden.responses) {
    const calls = [];
    let observedCalls = 0;
    const client = createRemoteFaqRagAnswerHttpClient({
      ...common,
      sleep: async () => assert.fail('one-shot must never retry'),
      fetch: async (url, init) => {
        calls.push(String(url));
        assert.equal(init.body, golden.request);
        assert.equal(init.redirect, 'manual');
        assert.equal(init.method, 'POST');
        assert.match(new Headers(init.headers).get('authorization'), /Credential=AKIDEXAMPLE\/.*\/us-west-2\/execute-api\/aws4_request/);
        assert.equal(new Headers(init.headers).get('x-amz-security-token'), 'example-session');
        return response(fixture);
      },
    });
    assert.deepEqual(await client.answer(request, { onHttpRequest: () => { observedCalls += 1; } }), JSON.parse(fixture.body));
    assert.deepEqual(calls, ['https://example.execute-api.us-west-2.amazonaws.com/api/v1/answer']);
    assert.equal(observedCalls, 1);
  }
});

test('one-shot caches AssumeRole credentials, refreshes, and charges signing time to the wire deadline', async () => {
  let now = 1_900_000_000_000;
  let assumeCalls = 0;
  const budgets = [];
  const roleArn = 'arn:aws:iam::111122223333:role/example-invoker';
  const client = createRemoteFaqRagAnswerHttpClient({
    ...common,
    env: { ...ENV, FAQ_REMOTE_RAG_ROLE_ARN: roleArn, FAQ_REMOTE_RAG_EXTERNAL_ID: 'example-external-id' },
    now: () => now,
    assumeRole: async (input) => {
      assumeCalls += 1;
      assert.equal(input.roleArn, roleArn);
      assert.equal(input.externalId, 'example-external-id');
      now += 125;
      return { accessKeyId: `ASSUMED${assumeCalls}`, secretAccessKey: 'assumed-secret', sessionToken: 'assumed-session', expiration: new Date(now + 120_000) };
    },
    fetch: async (_url, init) => {
      budgets.push(JSON.parse(init.body).remainingMs);
      assert.match(new Headers(init.headers).get('authorization'), /Credential=ASSUMED/);
      assert.doesNotMatch(init.body, /example-external-id|role\/example-invoker/);
      return response(noMatch);
    },
  });
  await client.answer(request);
  await client.answer({ ...request, idempotencyKey: 'synthetic-call-002' });
  assert.equal(assumeCalls, 1);
  now += 61_000;
  await client.answer({ ...request, idempotencyKey: 'synthetic-call-003' });
  assert.equal(assumeCalls, 2);
  assert.deepEqual(budgets, [19_875, 20_000, 19_875]);
});

test('only valid one-shot no_match 404 is a normal no-match; unsupported routes are local technical diagnoses', async () => {
  const bodies = [
    'Not Found',
    JSON.stringify({ message: 'Missing Authentication Token' }),
    JSON.stringify({ contractVersion: 'remote-v1', ok: false, error: { code: 'no_match', retryable: false } }),
    JSON.stringify({ contractVersion: 'remote-one-shot-v1', ok: false, error: { code: 'no_match', retryable: true } }),
  ];
  for (const status of [404, 501]) {
    for (const body of bodies) {
      let calls = 0;
      const client = createRemoteFaqRagAnswerHttpClient({
        ...common, fetch: async (url) => {
          calls += 1;
          assert.match(String(url), /\/v1\/answer$/);
          return new Response(body, { status });
        },
      });
      const { value, entries } = await captureErrors(() => client.answer(request));
      assert.equal(value.error.code, 'remote_transport_unsupported');
      assert.equal(value.error.retryable, false);
      assert.equal(calls, 1);
      assert.match(entries.join('\n'), /operation=answer code=remote_transport_unsupported/);
      assert.throws(() => parseRemoteOneShotAnswerResponse(value), /invalid|Invalid/);
    }
  }
});

test('HTTP status must match the validated one-shot outcome', async () => {
  for (const [body, status] of [[noMatch.body, 401], [noMatch.body, 200], [success.body, 201]]) {
    const client = createRemoteFaqRagAnswerHttpClient({ ...common, fetch: async () => new Response(body, { status }) });
    const { value } = await captureErrors(() => client.answer(request));
    assert.equal(value.error.code, 'invalid_contract');
  }
});

test('404/501 responses with otherwise valid DTOs remain unsupported unless exactly no_match 404', async () => {
  for (const status of [404, 501]) {
    for (const fixture of golden.responses) {
      if (status === 404 && fixture.statusCode === 404) continue;
      const client = createRemoteFaqRagAnswerHttpClient({
        ...common, fetch: async () => new Response(fixture.body, { status }),
      });
      const { value } = await captureErrors(() => client.answer(request));
      assert.equal(value.error.code, 'remote_transport_unsupported');
    }
  }
});

test('network, authentication, throttle and server failures never retry or invoke a split route', async () => {
  for (const status of [undefined, 401, 403, 429, 500, 502, 503, 504]) {
    let calls = 0;
    let observedCalls = 0;
    const client = createRemoteFaqRagAnswerHttpClient({
      ...common,
      sleep: async () => assert.fail('one-shot must never retry'),
      fetch: async (url) => {
        calls += 1;
        assert.match(String(url), /\/v1\/answer$/);
        if (status === undefined) throw new Error('synthetic network error');
        return new Response('synthetic gateway failure', { status });
      },
    });
    const { value } = await captureErrors(() => client.answer(request, { onHttpRequest: () => { observedCalls += 1; } }));
    assert.equal(value.error.code, 'retrieval_failed');
    assert.equal(value.error.retryable, true);
    assert.equal(calls, 1);
    assert.equal(observedCalls, 1);
  }
});

test('a terminal deadline DTO preserves caller key on explicit replay and never retries automatically', async () => {
  const deadline = golden.responses.find((item) => item.statusCode === 504);
  const requests = [];
  const client = createRemoteFaqRagAnswerHttpClient({
    ...common,
    fetch: async (_url, init) => { requests.push(JSON.parse(init.body)); return response(deadline); },
  });
  assert.deepEqual(await client.answer(request), JSON.parse(deadline.body));
  assert.equal(requests.length, 1);
  const replay = { ...request, remainingMs: 10_000 };
  assert.deepEqual(await client.answer(replay), JSON.parse(deadline.body));
  assert.equal(requests.length, 2);
  assert.equal(requests[0].idempotencyKey, requests[1].idempotencyKey);
  assert.equal(requests[1].remainingMs, 10_000);
  assert.throws(() => parseRemoteOneShotAnswerResponse({
    contractVersion: 'remote-one-shot-v1', ok: false,
    error: { code: 'deadline_exceeded', retryable: false },
  }), /Invalid/);
});

test('credential failures and exhausted pre-fetch budgets produce zero observed HTTP calls', async () => {
  for (const failure of ['expired-budget', 'credentials']) {
    let now = 1_900_000_000_000;
    const client = createRemoteFaqRagAnswerHttpClient({
      ...common, now: () => now,
      credentialsProvider: async () => {
        if (failure === 'credentials') throw new Error('synthetic credentials failure');
        now += 200;
        return credentials();
      },
      fetch: async () => assert.fail('credentials/budget failure must not fetch'),
    });
    const { value } = await captureErrors(() => client.answer(
      { ...request, remainingMs: 200 }, { onHttpRequest: () => assert.fail('not an HTTP call') }
    ));
    assert.equal(value.error.code, failure === 'credentials' ? 'retrieval_failed' : 'deadline_exceeded');
  }
});

test('a never-resolving credential provider cannot outlive the one-shot caller deadline', { timeout: 1000 }, async () => {
  const client = createRemoteFaqRagAnswerHttpClient({
    ...common, abortSafetyMarginMs: 5,
    credentialsProvider: () => new Promise(() => {}),
    fetch: async () => assert.fail('stalled credentials must not fetch'),
  });
  const value = await client.answer(
    { ...request, remainingMs: 40 }, { onHttpRequest: () => assert.fail('not an HTTP call') }
  );
  assert.equal(value.error.code, 'deadline_exceeded');
});

test('late credential success or rejection cannot fetch after a terminal caller timeout', { timeout: 1000 }, async () => {
  for (const outcome of ['resolve', 'reject']) {
    const pending = deferred();
    let calls = 0;
    const client = createRemoteFaqRagAnswerHttpClient({
      ...common, abortSafetyMarginMs: 5, credentialsProvider: () => pending.promise,
      fetch: async () => { calls += 1; return response(success); },
    });
    const value = await client.answer({ ...request, remainingMs: 30 });
    assert.equal(value.error.code, 'deadline_exceeded');
    if (outcome === 'resolve') pending.resolve(await credentials());
    else pending.reject(new Error('synthetic late credential rejection'));
    await new Promise(setImmediate);
    assert.equal(calls, 0);
  }
});

test('short caller timeout preserves shared AssumeRole refresh for a longer caller and warm cache', { timeout: 1500 }, async () => {
  const pending = deferred();
  const calls = [];
  let assumeCalls = 0;
  const client = createRemoteFaqRagAnswerHttpClient({
    ...common, abortSafetyMarginMs: 5,
    env: { ...ENV, FAQ_REMOTE_RAG_ROLE_ARN: 'arn:aws:iam::111122223333:role/example-invoker' },
    assumeRole: () => { assumeCalls += 1; return pending.promise; },
    fetch: async (_url, init) => { calls.push(JSON.parse(init.body).idempotencyKey); return response(success); },
  });
  const short = client.answer({ ...request, idempotencyKey: 'synthetic-short', remainingMs: 40 });
  const long = client.answer({ ...request, idempotencyKey: 'synthetic-long', remainingMs: 1000 });
  assert.equal((await short).error.code, 'deadline_exceeded');
  assert.equal(assumeCalls, 1);
  pending.resolve({ ...await credentials(), expiration: new Date(common.now() + 120_000) });
  assert.equal((await long).ok, true);
  assert.equal((await client.answer({ ...request, idempotencyKey: 'synthetic-warm' })).ok, true);
  assert.equal(assumeCalls, 1);
  assert.deepEqual(calls, ['synthetic-long', 'synthetic-warm']);
});

test('stalled signing is bounded and late signer completion or rejection cannot start HTTP', { timeout: 1000 }, async () => {
  try {
    for (const outcome of ['resolve', 'reject']) {
      const pending = deferred();
      let signCalls = 0;
      let httpCalls = 0;
      globalThis[signerTestKey] = () => { signCalls += 1; return pending.promise; };
      const client = createClientWithControlledSigner({
        ...common, abortSafetyMarginMs: 5,
        fetch: async () => { httpCalls += 1; return response(success); },
      });
      const value = await client.answer({ ...request, remainingMs: 30 });
      assert.equal(value.error.code, 'deadline_exceeded');
      assert.equal(signCalls, 1);
      if (outcome === 'resolve') pending.resolve({ headers: {} });
      else pending.reject(new Error('synthetic late signing rejection'));
      await new Promise(setImmediate);
      assert.equal(httpCalls, 0);
    }
  } finally {
    delete globalThis[signerTestKey];
  }
});

test('one abort deadline covers both HTTP headers and response body without retry', async () => {
  for (const phase of ['headers', 'body']) {
    let calls = 0;
    const client = createRemoteFaqRagAnswerHttpClient({
      ...common, abortSafetyMarginMs: 5,
      fetch: async (_url, init) => {
        calls += 1;
        const pending = () => new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
        return phase === 'headers' ? pending() : { status: 200, json: pending };
      },
    });
    const value = await client.answer({ ...request, remainingMs: 30 });
    assert.equal(value.error.code, 'deadline_exceeded');
    assert.equal(calls, 1);
  }
});

test('strict validation fails closed without logging caller values or raw response data', async () => {
  const canary = 'SYNTHETIC_PRIVATE_CANARY_212';
  let calls = 0;
  const client = createRemoteFaqRagAnswerHttpClient({
    ...common, fetch: async () => {
      calls += 1;
      return new Response(JSON.stringify({ ...JSON.parse(success.body), telemetry: canary }), { status: 200 });
    },
  });
  const safeRequest = { ...request, currentQuestion: canary, messages: [{ role: 'user', content: canary }], idempotencyKey: canary };
  const outgoing = await captureErrors(() => client.answer({ ...safeRequest, tenantId: canary }));
  assert.equal(outgoing.value.error.code, 'invalid_contract');
  assert.equal(calls, 0);
  const incoming = await captureErrors(() => client.answer(safeRequest));
  assert.equal(incoming.value.error.code, 'invalid_contract');
  assert.equal(calls, 1);
  assert.doesNotMatch([...outgoing.entries, ...incoming.entries].join('\n'), new RegExp(canary));
});

test('split observations count actual retry attempts and remain invocation-local', async () => {
  const observations = [0, 0];
  let calls = 0;
  const client = createRemoteFaqRagHttpClient({
    ...common, random: () => 0, sleep: async () => {},
    fetch: async () => {
      calls += 1;
      if (calls < 3) throw new Error('synthetic transient failure');
      return new Response(JSON.stringify({ contractVersion: 'remote-v1', ok: false, error: { code: 'no_match', retryable: false } }), { status: 404 });
    },
  });
  for (let i = 0; i < 2; i += 1) {
    await captureErrors(() => client.retrieve(
      { contractVersion: 'remote-v1', question: request.currentQuestion, remainingMs: 1000 },
      { onHttpRequest: () => { observations[i] += 1; } }
    ));
  }
  assert.deepEqual(observations, [3, 1]);
});

test('split retrieve and generate bound hung credentials and late resolve/reject without HTTP', { timeout: 2000 }, async () => {
  for (const operation of ['retrieve', 'generate']) {
    for (const outcome of ['resolve', 'reject']) {
      const pending = deferred();
      let calls = 0;
      const client = createRemoteFaqRagHttpClient({
        ...common, abortSafetyMarginMs: 5, credentialsProvider: () => pending.promise,
        fetch: async () => { calls += 1; throw new Error('must not fetch'); },
        sleep: async () => assert.fail('credentials timeout must not retry'),
      });
      const value = await client[operation](
        { ...splitGolden.cases.success[operation].request, remainingMs: 30 },
        { onHttpRequest: () => assert.fail('not an HTTP call') }
      );
      assert.equal(value.error.code, 'deadline_exceeded');
      if (outcome === 'resolve') pending.resolve(await credentials());
      else pending.reject(new Error('synthetic late credential rejection'));
      await new Promise(setImmediate);
      assert.equal(calls, 0);
    }
  }
});

test('split signing shares the caller deadline and cannot resume HTTP after terminal timeout', { timeout: 2000 }, async () => {
  try {
    for (const operation of ['retrieve', 'generate']) {
      for (const outcome of ['resolve', 'reject']) {
        const pending = deferred();
        let signCalls = 0;
        let httpCalls = 0;
        globalThis[signerTestKey] = () => { signCalls += 1; return pending.promise; };
        const client = createSplitWithControlledSigner({
          ...common, abortSafetyMarginMs: 5,
          fetch: async () => { httpCalls += 1; throw new Error('must not fetch'); },
          sleep: async () => assert.fail('signer timeout must not retry'),
        });
        const value = await client[operation]({ ...splitGolden.cases.success[operation].request, remainingMs: 30 });
        assert.equal(value.error.code, 'deadline_exceeded');
        assert.equal(signCalls, 1);
        if (outcome === 'resolve') pending.resolve({ headers: {} });
        else pending.reject(new Error('synthetic late signer rejection'));
        await new Promise(setImmediate);
        assert.equal(httpCalls, 0);
      }
    }
  } finally {
    delete globalThis[signerTestKey];
  }
});

test('deadline wins over credentials/signing rejection after budget exhaustion for both transports', async () => {
  try {
    for (const phase of ['credentials', 'signing']) {
      for (const operation of ['retrieve', 'generate', 'answer']) {
        let now = common.now();
        const rejectAfterBudget = () => {
          now += 100;
          throw new Error('synthetic failure after budget');
        };
        globalThis[signerTestKey] = rejectAfterBudget;
        const create = operation === 'answer' ? createClientWithControlledSigner : createSplitWithControlledSigner;
        const client = create({
          ...common, now: () => now, abortSafetyMarginMs: 5,
          credentialsProvider: phase === 'credentials' ? rejectAfterBudget : credentials,
          fetch: async () => assert.fail('no fetch after deadline'),
        });
        const input = operation === 'answer' ? request : splitGolden.cases.success[operation].request;
        assert.equal((await client[operation]({ ...input, remainingMs: 100 })).error.code, 'deadline_exceeded');
      }
    }
  } finally {
    delete globalThis[signerTestKey];
  }
});

test('split caller timeout keeps shared AssumeRole available to longer caller and warm cache', { timeout: 1500 }, async () => {
  const pending = deferred();
  let assumeCalls = 0;
  let httpCalls = 0;
  const client = createRemoteFaqRagHttpClient({
    ...common, abortSafetyMarginMs: 5,
    env: { ...ENV, FAQ_REMOTE_RAG_ROLE_ARN: 'arn:aws:iam::111122223333:role/example-invoker' },
    assumeRole: () => { assumeCalls += 1; return pending.promise; },
    fetch: async () => {
      httpCalls += 1;
      return new Response(JSON.stringify(splitGolden.cases.success.retrieve.response), { status: 200 });
    },
  });
  const input = splitGolden.cases.success.retrieve.request;
  const short = client.retrieve({ ...input, remainingMs: 30 });
  const long = client.retrieve({ ...input, remainingMs: 1000 });
  assert.equal((await short).error.code, 'deadline_exceeded');
  pending.resolve({ ...await credentials(), expiration: new Date(common.now() + 120_000) });
  assert.equal((await long).ok, true);
  assert.equal((await client.retrieve(input)).ok, true);
  assert.equal(assumeCalls, 1);
  assert.equal(httpCalls, 2);
});

test('both transports terminate when HTTP headers or body ignore AbortSignal', { timeout: 2000 }, async () => {
  for (const operation of ['retrieve', 'generate', 'answer']) {
    for (const phase of ['headers', 'body']) {
      let calls = 0;
      const create = operation === 'answer' ? createRemoteFaqRagAnswerHttpClient : createRemoteFaqRagHttpClient;
      const client = create({
        ...common, abortSafetyMarginMs: 5,
        fetch: async () => {
          calls += 1;
          return phase === 'headers' ? new Promise(() => {}) : { status: 200, json: () => new Promise(() => {}) };
        },
        sleep: async () => assert.fail('deadline must not retry'),
      });
      const input = operation === 'answer' ? request : splitGolden.cases.success[operation].request;
      assert.equal((await client[operation]({ ...input, remainingMs: 30 })).error.code, 'deadline_exceeded');
      assert.equal(calls, 1);
    }
  }
});

test('trusted evaluation composition disables split retries without changing production defaults', async () => {
  for (const [retrieveMaxRetries, expectedCalls] of [[0, 1], [1, 2], [undefined, 3]]) {
    let calls = 0;
    const observations = [];
    const client = createRemoteFaqRagHttpClient({
      ...common, retrieveMaxRetries, random: () => 0, sleep: async () => {},
      fetch: async () => {
        calls += 1;
        return new Response('synthetic server failure', { status: 502, headers: { 'x-faq-remote-request-id': `remote-${calls}` } });
      },
    });
    const { value } = await captureErrors(() => client.retrieve(splitGolden.cases.success.retrieve.request, {
      onHttpResponse: (observation) => observations.push(observation),
    }));
    assert.equal(value.error.code, 'retrieval_failed');
    assert.equal(calls, expectedCalls);
    assert.deepEqual(observations, Array.from({ length: expectedCalls }, (_, i) => ({ operation: 'retrieve', status: 502, requestId: `remote-${i + 1}` })));
  }
  for (const retrieveMaxRetries of [-1, 0.5, 3, NaN, '0']) {
    assert.throws(() => createRemoteFaqRagHttpClient({ ...common, retrieveMaxRetries }), /retrieveMaxRetries/);
  }
});

test('one-shot failures retain HTTP status and request ID for operator diagnostics without body values', async () => {
  const canary = 'SYNTHETIC_SECRET_RESPONSE_VALUE';
  for (const status of [401, 403, 429, 500, 502, 503, 504]) {
    for (const body of [canary, noMatch.body]) {
      const observations = [];
      const client = createRemoteFaqRagAnswerHttpClient({
        ...common, fetch: async () => new Response(body, {
          status, headers: { 'x-amzn-requestid': 'gateway-212', 'x-faq-remote-request-id': 'remote-212' },
        }),
      });
      const { value, entries } = await captureErrors(() => client.answer(request, {
        onHttpResponse: (observation) => observations.push(observation),
      }));
      assert.equal(value.ok, false);
      assert.notEqual(value.error.code, 'remote_transport_unsupported');
      assert.deepEqual(observations, [{ operation: 'answer', status, requestId: 'remote-212' }]);
      assert.match(entries.join('\n'), new RegExp(`status=${status}(?: |$)`));
      assert.doesNotMatch(entries.join('\n'), new RegExp(canary));
    }
  }
  for (const fixture of golden.responses.filter((item) => [429, 502, 503, 504].includes(item.statusCode))) {
    const observations = [];
    const client = createRemoteFaqRagAnswerHttpClient({ ...common, fetch: async () => response(fixture) });
    const { value, entries } = await captureErrors(() => client.answer(request, { onHttpResponse: (item) => observations.push(item) }));
    assert.deepEqual(value, JSON.parse(fixture.body));
    assert.deepEqual(observations, [{ operation: 'answer', status: fixture.statusCode }]);
    assert.match(entries.join('\n'), new RegExp(`code=${value.error.code} status=${fixture.statusCode}`));
  }
});

test('correlation rejects oversized or unsafe IDs and accepts bounded API Gateway fallback IDs', async () => {
  for (const [headers, expected] of [
    [{ 'x-faq-remote-request-id': 'x'.repeat(129) }, undefined],
    [{ 'x-faq-remote-request-id': 'unsafe request id' }, undefined],
    [{ 'x-faq-remote-request-id': 'unsafe request id', 'x-amzn-request-id': 'gateway-212' }, 'gateway-212'],
    [{ 'apigw-requestid': 'apigw_212=' }, 'apigw_212='],
    [{ 'x-faq-remote-request-id': 'remote:212.1' }, 'remote:212.1'],
  ]) {
    const observations = [];
    const client = createRemoteFaqRagAnswerHttpClient({
      ...common, fetch: async () => new Response(noMatch.body, { status: 404, headers }),
    });
    assert.equal((await client.answer(request, { onHttpResponse: (item) => observations.push(item) })).error.code, 'no_match');
    assert.deepEqual(observations, [{ operation: 'answer', status: 404, ...(expected === undefined ? {} : { requestId: expected }) }]);
  }
});

test('caller timings separate credentials, signing, headers and JSON parse on every transport operation', async () => {
  const canary = 'PRIVATE-CALLER-CANARY contact@example.invalid';
  for (const operation of ['retrieve', 'generate', 'answer']) {
    let epochMs = 1_900_000_000_000;
    globalThis[signerTestKey] = async (value) => { epochMs += 11; return value; };
    const input = operation === 'answer' ? request : splitGolden.cases.success[operation].request;
    const output = operation === 'answer' ? JSON.parse(success.body) : splitGolden.cases.success[operation].response;
    const factory = operation === 'answer' ? createClientWithControlledSigner : createSplitWithControlledSigner;
    const client = factory({
      ...common, now: () => epochMs,
      credentialsProvider: async () => { epochMs += 7; return credentials(); },
      fetch: async () => {
        epochMs += 13;
        return { status: 200, headers: new Headers({ 'x-faq-remote-request-id': 'remote-safe-id' }),
          json: async () => { epochMs += 17; return output; } };
      },
    });
    const observations = [];
    const safeInput = operation === 'retrieve' ? { ...input, question: canary } : input;
    const { value, metric } = await captureTiming(
      () => client[operation](safeInput, { onHttpResponse: (entry) => observations.push(entry) }),
      runWithControlledSignerTiming
    );
    assert.deepEqual(value, output);
    assert.deepEqual(metric.credential_events, [{ credential_wait_ms: 7, credential_cache: 'hit', assume_role_ms: 0, assume_role_attempts: 0, outcome: 'success' }]);
    assert.deepEqual(metric.remote_attempts, [{ operation, attempt: 1, signing_ms: 11, http_headers_ms: 13, body_parse_ms: 17, retry_wait_ms: 0, outcome: 'success' }]);
    assert.deepEqual(observations, [{ operation, status: 200, requestId: 'remote-safe-id' }]);
    assert.equal(metric[`${operation}_attempts`], 1);
    assert.equal(metric.effective_generate_timeout_ms, operation === 'generate' ? input.remainingMs - 100 : null);
    assert.equal(metric.remaining_at_answer_start_ms, operation === 'answer' ? input.remainingMs : null);
    assert.equal(metric.effective_answer_timeout_ms, operation === 'answer' ? input.remainingMs - 100 : null);
    assert.doesNotMatch(JSON.stringify(metric), /PRIVATE-CALLER-CANARY|contact@example|AKIDEXAMPLE|example-secret|example-session/);
    delete globalThis[signerTestKey];
  }
});

test('credential timing distinguishes cold, hit, refresh fallback and expired failure with SDK attempt counts', async () => {
  for (const operation of ['retrieve', 'answer']) {
    let epochMs = 1_900_000_000_000;
    let calls = 0;
    const factory = operation === 'answer' ? createRemoteFaqRagAnswerHttpClient : createRemoteFaqRagHttpClient;
    const input = operation === 'answer' ? request : splitGolden.cases.success.retrieve.request;
    const client = factory({
      ...common, now: () => epochMs,
      env: { ...ENV, FAQ_REMOTE_RAG_ROLE_ARN: 'arn:aws:iam::111122223333:role/example-invoker' },
      assumeRole: async ({ onSdkAttempt }) => {
        calls += 1;
        for (let i = 0; i < calls + 1; i += 1) onSdkAttempt();
        epochMs += 20;
        if (calls > 1) throw new Error('PRIVATE-STS-ERROR-CANARY');
        return { ...(await credentials()), expiration: new Date(epochMs + 120_000) };
      },
      fetch: async () => operation === 'answer' ? response(success) : new Response(JSON.stringify(splitGolden.cases.success.retrieve.response), { status: 200 }),
    });
    const metrics = [];
    for (const elapsed of [0, 5_000, 65_000, 65_000]) {
      epochMs += elapsed;
      const { value: captured } = await captureErrors(() => captureTiming(() => client[operation](input)));
      metrics.push(captured.metric);
    }
    assert.deepEqual(metrics.map((entry) => entry.credential_events[0]), [
      { credential_wait_ms: 20, credential_cache: 'cold', assume_role_ms: 20, assume_role_attempts: 2, outcome: 'success' },
      { credential_wait_ms: 0, credential_cache: 'hit', assume_role_ms: 0, assume_role_attempts: 0, outcome: 'success' },
      { credential_wait_ms: 20, credential_cache: 'refresh', assume_role_ms: 20, assume_role_attempts: 3, outcome: 'failure' },
      { credential_wait_ms: 20, credential_cache: 'refresh', assume_role_ms: 20, assume_role_attempts: 4, outcome: 'failure' },
    ]);
    assert.deepEqual(metrics.map((entry) => entry.remote_attempts[0].outcome), ['success', 'success', 'success', 'failure']);
    assert.doesNotMatch(JSON.stringify(metrics), /PRIVATE-STS-ERROR|111122223333|example-secret|example-session/);
  }
});

test('retry timings attach actual wait to the preceding retrieve attempt and omit a skipped backoff', async () => {
  for (const remainingMs of [5_000, 150]) {
    let epochMs = 1_900_000_000_000;
    let calls = 0;
    const client = createRemoteFaqRagHttpClient({
      ...common, now: () => epochMs, random: () => 0,
      sleep: async (delayMs) => { epochMs += delayMs; },
      fetch: async () => {
        epochMs += 5;
        calls += 1;
        if (calls === 1) throw new Error('PRIVATE-NETWORK-ERROR-CANARY');
        return { status: calls === 2 ? 502 : 200, headers: new Headers(), json: async () => {
          epochMs += 9;
          return calls === 2 ? { contractVersion: 'remote-v1', ok: false, error: { code: 'retrieval_failed', retryable: true } } : splitGolden.cases.success.retrieve.response;
        } };
      },
    });
    const { value: { metric } } = await captureErrors(() => captureTiming(() => client.retrieve({ ...splitGolden.cases.success.retrieve.request, remainingMs })));
    const expected = remainingMs === 150 ? [
      { operation: 'retrieve', attempt: 1, signing_ms: 0, http_headers_ms: 5, body_parse_ms: 0, retry_wait_ms: 0, outcome: 'failure' },
    ] : [
      { operation: 'retrieve', attempt: 1, signing_ms: 0, http_headers_ms: 5, body_parse_ms: 0, retry_wait_ms: 100, outcome: 'failure' },
      { operation: 'retrieve', attempt: 2, signing_ms: 0, http_headers_ms: 5, body_parse_ms: 9, retry_wait_ms: 300, outcome: 'failure' },
      { operation: 'retrieve', attempt: 3, signing_ms: 0, http_headers_ms: 5, body_parse_ms: 9, retry_wait_ms: 0, outcome: 'success' },
    ];
    assert.deepEqual(metric.remote_attempts, expected);
    assert.equal(metric.retrieve_attempts, calls);
    assert.doesNotMatch(JSON.stringify(metric), /PRIVATE-NETWORK-ERROR/);
  }
});

test('deadline timings stop on the caller arm and late work never changes an emitted invocation', { timeout: 3000 }, async () => {
  for (const operation of ['retrieve', 'generate', 'answer']) {
    for (const phase of ['credentials', 'signing', 'headers', 'body']) {
      const late = deferred();
      const input = operation === 'answer' ? request : splitGolden.cases.success[operation].request;
      const output = operation === 'answer' ? JSON.parse(success.body) : splitGolden.cases.success[operation].response;
      globalThis[signerTestKey] = async (value) => phase === 'signing' ? late.promise : value;
      const factory = operation === 'answer' ? createClientWithControlledSigner : createSplitWithControlledSigner;
      const client = factory({
        env: ENV, abortSafetyMarginMs: 0,
        credentialsProvider: async () => phase === 'credentials' ? late.promise : credentials(),
        fetch: async () => phase === 'headers' ? late.promise : { status: 200, headers: new Headers(), json: async () => phase === 'body' ? late.promise : output },
      });
      const entries = [];
      const original = console.log;
      console.log = (entry) => entries.push(JSON.parse(entry));
      try {
        const value = await runWithControlledSignerTiming({ requestId: 'short-caller', coldStart: true }, () => client[operation]({ ...input, remainingMs: 25 }));
        assert.equal(value.error.code, 'deadline_exceeded');
        assert.equal(entries.length, 1);
        const metric = entries[0];
        assert.equal(metric.remote_attempts.length, 1);
        assert.equal(metric.remote_attempts[0].outcome, 'timeout');
        if (phase === 'credentials') assert.equal(metric.credential_events[0].outcome, 'timeout');
        else assert.ok(metric.remote_attempts[0][{ signing: 'signing_ms', headers: 'http_headers_ms', body: 'body_parse_ms' }[phase]] >= 1);
        const before = JSON.stringify(metric);
        late.reject(new Error('PRIVATE-LATE-ERROR-CANARY'));
        await new Promise((resolve) => setImmediate(resolve));
        await runWithControlledSignerTiming({ requestId: 'next-caller', coldStart: false }, async () => {});
        assert.equal(entries.length, 2);
        assert.equal(JSON.stringify(entries[0]), before);
        assert.deepEqual(entries[1].remote_attempts, []);
        assert.deepEqual(entries[1].credential_events, []);
        assert.doesNotMatch(JSON.stringify(entries), /PRIVATE-LATE-ERROR/);
      } finally {
        console.log = original;
        delete globalThis[signerTestKey];
      }
    }
  }
});

test('invalid or exhausted requests emit no invented remote or credential attempts', async () => {
  for (const operation of ['retrieve', 'generate', 'answer']) {
    const input = operation === 'answer' ? request : splitGolden.cases.success[operation].request;
    const factory = operation === 'answer' ? createRemoteFaqRagAnswerHttpClient : createRemoteFaqRagHttpClient;
    const client = factory({ ...common, credentialsProvider: async () => assert.fail('no credential lookup'), fetch: async () => assert.fail('no HTTP') });
    for (const value of [{ ...input, remainingMs: 100 }, { ...input, privateCanary: 'PRIVATE-INPUT-CANARY' }]) {
      const { value: { metric } } = await captureErrors(() => captureTiming(() => client[operation](value)));
      assert.deepEqual(metric.remote_attempts, []);
      assert.deepEqual(metric.credential_events, []);
      assert.doesNotMatch(JSON.stringify(metric), /PRIVATE-INPUT-CANARY/);
    }
  }
});

test('production AssumeRole timing counts two SDK retries at the HTTP boundary without making network calls', async () => {
  let epochMs = 1_900_000_000_000;
  let sends = 0;
  let sdkCalls = 0;
  const originalSend = TestSTSClient.prototype.send;
  TestSTSClient.prototype.send = function (...args) {
    sdkCalls += 1;
    this.config.maxAttempts = async () => 3;
    this.config.requestHandler = {
      handle: async () => {
        sends += 1;
        epochMs += 8;
        const body = sends < 3
          ? '<ErrorResponse><Error><Type>Receiver</Type><Code>ServiceUnavailable</Code><Message>PRIVATE-STS-BODY-CANARY</Message></Error></ErrorResponse>'
          : '<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>EXAMPLE</AccessKeyId><SecretAccessKey>example-secret</SecretAccessKey><SessionToken>example-session</SessionToken><Expiration>2031-01-01T00:00:00Z</Expiration></Credentials></AssumeRoleResult><ResponseMetadata><RequestId>safe-sts-id</RequestId></ResponseMetadata></AssumeRoleResponse>';
        return { response: { statusCode: sends < 3 ? 503 : 200, headers: { 'content-type': 'text/xml' }, body: Buffer.from(body) } };
      },
    };
    return originalSend.apply(this, args);
  };
  try {
    const client = createRemoteFaqRagAnswerHttpClient({
      ...common, now: () => epochMs,
      env: { ...ENV, FAQ_REMOTE_RAG_ROLE_ARN: 'arn:aws:iam::111122223333:role/example-invoker' },
      fetch: async () => response(success),
    });
    const { value, metric } = await captureTiming(() => client.answer(request));
    assert.equal(value.ok, true);
    assert.equal(sdkCalls, 1);
    assert.equal(sends, 3);
    assert.equal(metric.assume_role_attempts, sends);
    assert.equal(metric.assume_role_ms, 24);
    assert.equal(metric.credential_cache, 'cold');
    assert.doesNotMatch(JSON.stringify(metric), /PRIVATE-STS-BODY|example-secret|example-session|111122223333/);
  } finally {
    TestSTSClient.prototype.send = originalSend;
  }
});

test('AssumeRole metrics tolerate registration failure and missing or renamed retry middleware', async (t) => {
  const stsTestKey = Symbol.for('faq-answer-sts-registration-test');
  const outfile = path.join(outDir, 'failed-sts-registration.mjs');
  await build({
    entryPoints: [path.join(FAQ_ROOT, 'adapters', 'remote', 'http-client.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile,
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    plugins: [timingTestExports, {
      name: 'failed-sts-registration',
      setup(builder) {
        builder.onResolve({ filter: /^@aws-sdk\/client-sts$/ }, (args) =>
          /remote[\\/]http-client\.ts$/.test(args.importer) ? { path: 'sts', namespace: 'test' } : undefined);
        builder.onLoad({ filter: /^sts$/, namespace: 'test' }, () => ({
          contents: `
            const state = () => globalThis[Symbol.for('faq-answer-sts-registration-test')];
            export class AssumeRoleCommand { constructor(input) { this.input = input; } }
            export class STSClient {
              middlewareStack = state().stack;
              send(command) { return state().send(command, this.middlewareStack); }
            }
          `,
          loader: 'js',
        }));
      },
    }],
  });
  const isolated = await import(pathToFileURL(outfile).href);
  for (const scenario of ['registration throws', 'no retry middleware', 'renamed retry middleware']) {
    await t.test(scenario, async () => {
      // Reuse the SDK's real stack implementation without adding a transitive import.
      // Remove built-ins (including signing's own relative links) to model a different SDK stack.
      const stack = new TestSTSClient({ region: ENV.AWS_REGION, credentials }).middlewareStack;
      const remove = (middleware) => stack.remove(middleware);
      stack.clone().applyToStack({ add: remove, addRelativeTo: remove, identifyOnResolve() {} });
      assert.deepEqual(stack.identify(), []);
      const retries = scenario === 'renamed retry middleware' ? 2 : 0;
      if (retries > 0) {
        stack.add((next) => async (args) => {
          for (let attempt = 0; ; attempt += 1) {
            try { return await next(args); }
            catch (error) { if (attempt >= retries) throw error; }
          }
        }, { step: 'finalizeRequest', priority: 'high', name: 'renamedRetry' });
      }
      const registrations = [];
      const originalAdd = stack.add.bind(stack);
      stack.add = (middleware, options) => {
        registrations.push(options);
        if (scenario === 'registration throws') throw new Error('PRIVATE-STS-REGISTRATION-CANARY');
        return originalAdd(middleware, options);
      };
      let assumeCalls = 0;
      let attempts = 0;
      let httpCalls = 0;
      globalThis[stsTestKey] = {
        stack,
        send: async (command, middlewareStack) => {
          assumeCalls += 1;
          // Relative registrations succeed initially, but missing targets fail here during send.
          const handle = middlewareStack.resolve(async ({ input }) => {
            attempts += 1;
            assert.equal(input.RoleArn, 'arn:aws:iam::111122223333:role/example-invoker');
            if (attempts <= retries) throw new Error('PRIVATE-STS-RETRY-CANARY');
            return { response: {}, output: { Credentials: {
              AccessKeyId: 'EXAMPLE', SecretAccessKey: 'example-secret',
              SessionToken: 'example-session', Expiration: new Date(common.now() + 120_000),
            } } };
          }, {});
          return (await handle({ input: command.input })).output;
        },
      };
      try {
        const client = isolated.createRemoteFaqRagAnswerHttpClient({
          ...common,
          env: { ...ENV, FAQ_REMOTE_RAG_ROLE_ARN: 'arn:aws:iam::111122223333:role/example-invoker' },
          fetch: async (_url, init) => {
            httpCalls += 1;
            assert.match(new Headers(init.headers).get('authorization'), /Credential=EXAMPLE\//);
            return response(success);
          },
        });
        const { value, metric } = await captureTiming(() => client.answer(request), isolated.runFaqShellTiming);
        assert.deepEqual(value, JSON.parse(success.body));
        assert.deepEqual(registrations, [{
          step: 'finalizeRequest', name: 'faqShellAssumeRoleAttempts',
          priority: 'low', tags: ['FAQ_SHELL_TIMING'],
        }]);
        assert.equal(assumeCalls, 1);
        assert.equal(attempts, retries + 1);
        assert.equal(httpCalls, 1);
        assert.equal(metric.assume_role_attempts, scenario === 'registration throws' ? 0 : attempts);
        assert.equal(metric.credential_outcome, 'success');
        assert.equal(metric.remote_attempts[0].outcome, 'success');
        assert.doesNotMatch(JSON.stringify(metric), /PRIVATE-STS|example-secret|example-session|111122223333/);
      } finally {
        delete globalThis[stsTestKey];
      }
    });
  }
});

test('shared STS refresh metrics stay with each waiting invocation and late completion only warms the cache', { timeout: 1500 }, async () => {
  const shared = deferred();
  let assumeCalls = 0;
  const client = createRemoteFaqRagAnswerHttpClient({
    env: { ...ENV, FAQ_REMOTE_RAG_ROLE_ARN: 'arn:aws:iam::111122223333:role/example-invoker' },
    credentialsProvider: credentials, abortSafetyMarginMs: 0,
    assumeRole: async ({ onSdkAttempt }) => { assumeCalls += 1; onSdkAttempt(); return shared.promise; },
    fetch: async () => response(success),
  });
  const entries = [];
  const original = console.log;
  console.log = (entry) => entries.push(JSON.parse(entry));
  try {
    const short = runFaqShellTiming({ requestId: 'short-caller', coldStart: true }, () => client.answer({ ...request, remainingMs: 25 }));
    const long = runFaqShellTiming({ requestId: 'long-caller', coldStart: false }, () => client.answer({ ...request, remainingMs: 600 }));
    assert.equal((await short).error.code, 'deadline_exceeded');
    const shortSnapshot = JSON.stringify(entries[0]);
    shared.resolve({ ...(await credentials()), expiration: new Date(Date.now() + 120_000) });
    assert.equal((await long).ok, true);
    await runFaqShellTiming({ requestId: 'warm-caller', coldStart: false }, () => client.answer(request));
    assert.equal(assumeCalls, 1);
    assert.equal(entries.length, 3);
    assert.equal(JSON.stringify(entries[0]), shortSnapshot);
    assert.deepEqual(entries.map((entry) => [entry.requestId, entry.credential_cache, entry.credential_outcome, entry.assume_role_attempts]), [
      ['short-caller', 'cold', 'timeout', 1],
      ['long-caller', 'cold', 'success', 1],
      ['warm-caller', 'hit', 'success', 0],
    ]);
    assert.deepEqual(entries.map((entry) => entry.remote_attempts[0].outcome), ['timeout', 'success', 'success']);
  } finally {
    console.log = original;
  }
});
