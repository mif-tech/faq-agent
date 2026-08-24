#!/usr/bin/env node
/** SigV4 remote-v1 HTTP client tests / issue #126. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAQ_ROOT = path.join(HERE, '..', 'functions', 'faq-chat');
const FIXTURE_PATH = path.join(HERE, 'fixtures', 'faq-chat-remote-v1.golden.json');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faq-remote-http-client-test-'));

await build({
  entryPoints: {
    'http-client': path.join(FAQ_ROOT, 'adapters', 'remote', 'http-client.ts'),
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  outdir: outDir,
  outExtension: { '.js': '.mjs' },
});

const { createRemoteFaqRagHttpClient } = await import(
  pathToFileURL(path.join(outDir, 'http-client.mjs')).href
);
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

after(() => {
  const tempRoot = path.resolve(os.tmpdir());
  assert.equal(path.dirname(path.resolve(outDir)), tempRoot);
  fs.rmSync(outDir, { recursive: true, force: true });
});

const ENV = {
  FAQ_REMOTE_RAG_BASE_URL: 'https://example.execute-api.us-west-2.amazonaws.com/api/',
  AWS_REGION: 'us-west-2',
};
const STATIC_CREDENTIALS = async () => ({
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secret-example',
  sessionToken: 'session-example',
});

function jsonResponse(dto, status) {
  return new Response(JSON.stringify(dto), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function withoutConsoleErrors(run) {
  const original = console.error;
  const entries = [];
  console.error = (...args) => entries.push(args.map(String).join(' '));
  try {
    return { value: await run(), entries };
  } finally {
    console.error = original;
  }
}

test('configuration fails fast and normalizes the base URL trailing slash', async () => {
  const common = { credentialsProvider: STATIC_CREDENTIALS };
  assert.throws(
    () => createRemoteFaqRagHttpClient({ ...common, env: { AWS_REGION: 'us-west-2' } }),
    /FAQ_REMOTE_RAG_BASE_URL.*required/
  );
  assert.throws(
    () =>
      createRemoteFaqRagHttpClient({
        ...common,
        env: { FAQ_REMOTE_RAG_BASE_URL: 'http:\/\/example.test', AWS_REGION: 'us-west-2' },
      }),
    /FAQ_REMOTE_RAG_BASE_URL.*https/
  );
  assert.throws(
    () =>
      createRemoteFaqRagHttpClient({
        ...common,
        env: { FAQ_REMOTE_RAG_BASE_URL: 'https:\/\/example.test' },
      }),
    /AWS_REGION.*required/
  );
  assert.throws(
    () =>
      createRemoteFaqRagHttpClient({
        ...common,
        env: { ...ENV, FAQ_REMOTE_RAG_ROLE_ARN: 'not-a-role' },
      }),
    /FAQ_REMOTE_RAG_ROLE_ARN.*IAM role ARN/
  );

  let requestedUrl;
  const client = createRemoteFaqRagHttpClient({
    ...common,
    env: {
      ...ENV,
      FAQ_REMOTE_RAG_BASE_URL: 'https://example.execute-api.us-west-2.amazonaws.com/api///',
    },
    now: () => fixture.clock.initialEpochMs,
    fetch: async (url) => {
      requestedUrl = String(url);
      return jsonResponse(fixture.cases.noMatch.retrieve.response, 404);
    },
  });
  await client.retrieve(fixture.cases.noMatch.retrieve.request);
  assert.equal(
    requestedUrl,
    'https://example.execute-api.us-west-2.amazonaws.com/api/v1/retrieve'
  );
});

test('base URL execute-api region must match AWS_REGION', () => {
  assert.throws(
    () =>
      createRemoteFaqRagHttpClient({
        env: {
          ...ENV,
          FAQ_REMOTE_RAG_BASE_URL: 'https://example.execute-api.us-east-1.amazonaws.com/api/',
        },
        credentialsProvider: STATIC_CREDENTIALS,
      }),
    (error) => {
      assert.match(error.message, /FAQ_REMOTE_RAG_BASE_URL.*region/u);
      return true;
    }
  );
});

test('ExternalId requires a role ARN and is passed only to AssumeRole', async () => {
  const externalId = 'example-external-id';
  assert.throws(
    () =>
      createRemoteFaqRagHttpClient({
        env: { ...ENV, FAQ_REMOTE_RAG_EXTERNAL_ID: externalId },
        credentialsProvider: STATIC_CREDENTIALS,
      }),
    (error) => {
      assert.match(error.message, /FAQ_REMOTE_RAG_EXTERNAL_ID.*FAQ_REMOTE_RAG_ROLE_ARN/);
      assert.doesNotMatch(error.message, new RegExp(externalId));
      return true;
    }
  );

  let assumeRoleInput;
  const client = createRemoteFaqRagHttpClient({
    env: {
      ...ENV,
      FAQ_REMOTE_RAG_ROLE_ARN:
        'arn:aws:iam::111122223333:role/example-remote-rag-invoker',
      FAQ_REMOTE_RAG_EXTERNAL_ID: externalId,
    },
    credentialsProvider: STATIC_CREDENTIALS,
    assumeRole: async (input) => {
      assumeRoleInput = input;
      return {
        accessKeyId: 'ASSUMED',
        secretAccessKey: 'assumed-secret',
        sessionToken: 'assumed-session',
        expiration: new Date(fixture.clock.initialEpochMs + 120_000),
      };
    },
    now: () => fixture.clock.initialEpochMs,
    fetch: async () => jsonResponse(fixture.cases.noMatch.retrieve.response, 404),
  });

  await client.retrieve(fixture.cases.noMatch.retrieve.request);
  assert.equal(assumeRoleInput.externalId, externalId);
  assert.equal(
    assumeRoleInput.roleArn,
    'arn:aws:iam::111122223333:role/example-remote-rag-invoker'
  );
});

test('golden retrieve/generate DTOs cross the signed HTTP boundary unchanged', async () => {
  const success = fixture.cases.success;
  const requests = [];
  const client = createRemoteFaqRagHttpClient({
    env: ENV,
    credentialsProvider: STATIC_CREDENTIALS,
    now: () => fixture.clock.initialEpochMs,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init, body: JSON.parse(init.body) });
      if (String(url).endsWith('/v1/retrieve')) {
        return jsonResponse(success.retrieve.response, 200);
      }
      return jsonResponse(success.generate.response, 200);
    },
  });

  assert.deepEqual(await client.retrieve(success.retrieve.request), success.retrieve.response);
  assert.deepEqual(await client.generate(success.generate.request), success.generate.response);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].body, success.retrieve.request);
  assert.deepEqual(requests[1].body, success.generate.request);
  for (const { init } of requests) {
    const authorization = new Headers(init.headers).get('authorization');
    assert.match(authorization, /^AWS4-HMAC-SHA256 /);
    assert.match(authorization, /Credential=AKIDEXAMPLE\//);
    assert.match(authorization, /\/us-west-2\/execute-api\/aws4_request/);
    assert.equal(new Headers(init.headers).get('x-amz-security-token'), 'session-example');
  }
});

test('AssumeRole credentials are cached and refreshed before expiry', async () => {
  let epochMs = 1_900_000_000_000;
  let assumeCalls = 0;
  const client = createRemoteFaqRagHttpClient({
    env: {
      ...ENV,
      FAQ_REMOTE_RAG_ROLE_ARN:
        'arn:aws:iam::111122223333:role/example-remote-rag-invoker',
    },
    credentialsProvider: STATIC_CREDENTIALS,
    now: () => epochMs,
    assumeRole: async ({ roleArn, region }) => {
      assumeCalls += 1;
      assert.equal(
        roleArn,
        'arn:aws:iam::111122223333:role/example-remote-rag-invoker'
      );
      assert.equal(region, 'us-west-2');
      return {
        accessKeyId: `ASSUMED${assumeCalls}`,
        secretAccessKey: 'assumed-secret',
        sessionToken: 'assumed-session',
        expiration: new Date(epochMs + 120_000),
      };
    },
    fetch: async () => jsonResponse(fixture.cases.noMatch.retrieve.response, 404),
  });

  await client.retrieve(fixture.cases.noMatch.retrieve.request);
  epochMs += 5_000;
  await client.retrieve(fixture.cases.noMatch.retrieve.request);
  assert.equal(assumeCalls, 1, 'credentials outside the refresh window are reused');
  epochMs += 65_000;
  await client.retrieve(fixture.cases.noMatch.retrieve.request);
  assert.equal(assumeCalls, 2, 'credentials are refreshed with less than 60s remaining');
});

test('failed AssumeRole refresh falls back only while cached credentials remain valid', async () => {
  let epochMs = 1_900_000_000_000;
  let assumeCalls = 0;
  let fetchCalls = 0;
  const client = createRemoteFaqRagHttpClient({
    env: {
      ...ENV,
      FAQ_REMOTE_RAG_ROLE_ARN:
        'arn:aws:iam::111122223333:role/example-remote-rag-invoker',
    },
    credentialsProvider: STATIC_CREDENTIALS,
    now: () => epochMs,
    assumeRole: async () => {
      assumeCalls += 1;
      if (assumeCalls > 1) throw new Error('STS unavailable');
      return {
        accessKeyId: 'ASSUMED-CACHED',
        secretAccessKey: 'assumed-secret',
        sessionToken: 'assumed-session',
        expiration: new Date(epochMs + 120_000),
      };
    },
    fetch: async (_url, init) => {
      fetchCalls += 1;
      assert.match(
        new Headers(init.headers).get('authorization'),
        /Credential=ASSUMED-CACHED\//
      );
      return jsonResponse(fixture.cases.noMatch.retrieve.response, 404);
    },
  });

  await client.retrieve(fixture.cases.noMatch.retrieve.request);
  epochMs += 70_000;
  const cachedFallback = await client.retrieve(fixture.cases.noMatch.retrieve.request);
  assert.equal(cachedFallback.error.code, 'no_match');
  assert.equal(assumeCalls, 2, 'refresh is attempted inside the 60s window');
  assert.equal(fetchCalls, 2, 'the still-valid cached credentials are used after refresh failure');

  epochMs += 50_001;
  const expired = await withoutConsoleErrors(() =>
    client.retrieve(fixture.cases.noMatch.retrieve.request)
  );
  assert.equal(expired.value.error.code, 'retrieval_failed');
  assert.equal(assumeCalls, 3, 'refresh is retried after the cached credentials expire');
  assert.equal(fetchCalls, 2, 'expired cached credentials are never used for a request');
});

test('retrieve retries network/5xx failures with bounded 100ms and 300ms backoff', async () => {
  let epochMs = 1_900_000_000_000;
  let fetchCalls = 0;
  const sleeps = [];
  const remainingBudgets = [];
  const client = createRemoteFaqRagHttpClient({
    env: ENV,
    credentialsProvider: STATIC_CREDENTIALS,
    now: () => epochMs,
    random: () => 0,
    sleep: async (delayMs) => {
      sleeps.push(delayMs);
      epochMs += delayMs;
    },
    fetch: async (_url, init) => {
      fetchCalls += 1;
      remainingBudgets.push(JSON.parse(init.body).remainingMs);
      if (fetchCalls < 3) return new Response('temporary failure', { status: 503 });
      return jsonResponse(fixture.cases.success.retrieve.response, 200);
    },
  });

  const { value } = await withoutConsoleErrors(() =>
    client.retrieve(fixture.cases.success.retrieve.request)
  );
  assert.deepEqual(value, fixture.cases.success.retrieve.response);
  assert.equal(fetchCalls, 3);
  assert.deepEqual(sleeps, [100, 300]);
  assert.deepEqual(remainingBudgets, [30_000, 29_900, 29_600]);
});

test('retrieve skips a retry whose backoff would consume the deadline', async () => {
  let fetchCalls = 0;
  const request = { ...fixture.cases.noMatch.retrieve.request, remainingMs: 140 };
  const client = createRemoteFaqRagHttpClient({
    env: ENV,
    credentialsProvider: STATIC_CREDENTIALS,
    now: () => 1_900_000_000_000,
    random: () => 0,
    abortSafetyMarginMs: 50,
    sleep: async () => assert.fail('deadline must prevent sleeping'),
    fetch: async () => {
      fetchCalls += 1;
      throw new Error('network failure');
    },
  });

  const { value } = await withoutConsoleErrors(() => client.retrieve(request));
  assert.equal(fetchCalls, 1);
  assert.deepEqual(value, {
    contractVersion: 'remote-v1',
    ok: false,
    error: { code: 'retrieval_failed', retryable: true },
  });
});

test('credential resolution time is deducted before fetch starts', async () => {
  let epochMs = 1_900_000_000_000;
  let fetchCalls = 0;
  const request = { ...fixture.cases.noMatch.retrieve.request, remainingMs: 140 };
  const client = createRemoteFaqRagHttpClient({
    env: {
      ...ENV,
      FAQ_REMOTE_RAG_ROLE_ARN:
        'arn:aws:iam::111122223333:role/example-remote-rag-invoker',
    },
    credentialsProvider: STATIC_CREDENTIALS,
    now: () => epochMs,
    abortSafetyMarginMs: 50,
    assumeRole: async () => {
      epochMs += 100;
      return {
        accessKeyId: 'ASSUMED',
        secretAccessKey: 'assumed-secret',
        sessionToken: 'assumed-session',
        expiration: new Date(epochMs + 120_000),
      };
    },
    fetch: async () => {
      fetchCalls += 1;
      return jsonResponse(fixture.cases.noMatch.retrieve.response, 404);
    },
  });

  const response = await client.retrieve(request);
  assert.equal(fetchCalls, 0, 'signing/STS consumed the usable fetch budget');
  assert.equal(response.error.code, 'deadline_exceeded');
});

test('outbound remainingMs is recomputed after AssumeRole resolves', async () => {
  let epochMs = 1_900_000_000_000;
  let outboundBody;
  const request = { ...fixture.cases.noMatch.retrieve.request, remainingMs: 1_000 };
  const client = createRemoteFaqRagHttpClient({
    env: {
      ...ENV,
      FAQ_REMOTE_RAG_ROLE_ARN:
        'arn:aws:iam::111122223333:role/example-remote-rag-invoker',
    },
    credentialsProvider: STATIC_CREDENTIALS,
    now: () => epochMs,
    assumeRole: async () => {
      epochMs += 125;
      return {
        accessKeyId: 'ASSUMED',
        secretAccessKey: 'assumed-secret',
        sessionToken: 'assumed-session',
        expiration: new Date(epochMs + 120_000),
      };
    },
    fetch: async (_url, init) => {
      outboundBody = JSON.parse(init.body);
      return jsonResponse(fixture.cases.noMatch.retrieve.response, 404);
    },
  });

  const response = await client.retrieve(request);
  assert.equal(response.error.code, 'no_match');
  assert.equal(outboundBody.remainingMs, 875);
  assert.deepEqual(outboundBody, { ...request, remainingMs: 875 });
});

test('fetch is aborted while waiting for response headers', async () => {
  let sawSignal = false;
  const request = { ...fixture.cases.noMatch.retrieve.request, remainingMs: 20 };
  const client = createRemoteFaqRagHttpClient({
    env: ENV,
    credentialsProvider: STATIC_CREDENTIALS,
    abortSafetyMarginMs: 5,
    fetch: async (_url, init) => {
      sawSignal = init.signal instanceof AbortSignal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          { once: true }
        );
      });
    },
  });

  const response = await client.retrieve(request);
  assert.equal(sawSignal, true);
  assert.deepEqual(response, {
    contractVersion: 'remote-v1',
    ok: false,
    error: { code: 'deadline_exceeded', retryable: true },
  });
});

test('response body parsing remains under the same abort deadline', async () => {
  let sawBodyAbort = false;
  const request = { ...fixture.cases.noMatch.retrieve.request, remainingMs: 20 };
  const client = createRemoteFaqRagHttpClient({
    env: ENV,
    credentialsProvider: STATIC_CREDENTIALS,
    abortSafetyMarginMs: 5,
    fetch: async (_url, init) => ({
      status: 200,
      json: () =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            'abort',
            () => {
              sawBodyAbort = true;
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            },
            { once: true }
          );
        }),
    }),
  });

  const response = await client.retrieve(request);
  assert.equal(sawBodyAbort, true);
  assert.equal(response.error.code, 'deadline_exceeded');
});

test('generate performs one attempt even for retryable transport failure', async () => {
  let fetchCalls = 0;
  const client = createRemoteFaqRagHttpClient({
    env: ENV,
    credentialsProvider: STATIC_CREDENTIALS,
    fetch: async () => {
      fetchCalls += 1;
      return new Response('temporary failure', { status: 503 });
    },
  });

  const { value } = await withoutConsoleErrors(() =>
    client.generate(fixture.cases.success.generate.request)
  );
  assert.equal(fetchCalls, 1);
  assert.deepEqual(value, {
    contractVersion: 'remote-v1',
    ok: false,
    error: { code: 'generation_failed', retryable: true },
  });
});

test('invalid request and response contracts never leak question/message values', async () => {
  const canary = 'PRIVATE_QUESTION_MESSAGE_CANARY_126';
  let fetchCalls = 0;
  const client = createRemoteFaqRagHttpClient({
    env: ENV,
    credentialsProvider: STATIC_CREDENTIALS,
    fetch: async () => {
      fetchCalls += 1;
      return jsonResponse(
        {
          contractVersion: 'remote-v1',
          ok: true,
          response: {
            answer: canary,
            answerable: true,
            sources: [],
            responseType: 'kb_answer',
          },
        },
        200
      );
    },
  });
  const validRequest = {
    ...fixture.cases.success.generate.request,
    currentQuestion: canary,
    messages: [{ role: 'user', content: canary }],
  };

  const invalidResponse = await withoutConsoleErrors(() => client.generate(validRequest));
  assert.deepEqual(invalidResponse.value, {
    contractVersion: 'remote-v1',
    ok: false,
    error: { code: 'invalid_contract', retryable: false },
  });
  assert.equal(fetchCalls, 1);
  assert.match(invalidResponse.entries.join('\n'), /field=generateResponse\.response/);
  assert.doesNotMatch(invalidResponse.entries.join('\n'), new RegExp(canary));
  assert.doesNotMatch(JSON.stringify(invalidResponse.value), new RegExp(canary));

  const invalidRequest = {
    ...validRequest,
    messages: [{ role: 'user', content: `does not end with the question: ${canary}!` }],
  };
  const outgoing = await withoutConsoleErrors(() => client.generate(invalidRequest));
  assert.equal(fetchCalls, 1, 'invalid outgoing DTO is rejected before fetch');
  assert.equal(outgoing.value.error.code, 'invalid_contract');
  assert.doesNotMatch(outgoing.entries.join('\n'), new RegExp(canary));
});

test('HTTP/DTO mismatches are invalid_contract while valid error DTOs pass through', async () => {
  const success = fixture.cases.success.retrieve.response;
  const mismatchClient = createRemoteFaqRagHttpClient({
    env: ENV,
    credentialsProvider: STATIC_CREDENTIALS,
    fetch: async () => jsonResponse(success, 503),
  });
  const mismatch = await withoutConsoleErrors(() =>
    mismatchClient.retrieve(fixture.cases.success.retrieve.request)
  );
  assert.equal(mismatch.value.error.code, 'invalid_contract');
  assert.match(mismatch.entries.join('\n'), /field=retrieveResponse\.ok status=503/);

  const killSwitch = {
    contractVersion: 'remote-v1',
    ok: false,
    error: { code: 'kill_switch', retryable: true },
  };
  let calls = 0;
  const errorClient = createRemoteFaqRagHttpClient({
    env: ENV,
    credentialsProvider: STATIC_CREDENTIALS,
    fetch: async () => {
      calls += 1;
      return jsonResponse(killSwitch, 503);
    },
  });
  assert.deepEqual(
    await errorClient.retrieve(fixture.cases.noMatch.retrieve.request),
    killSwitch
  );
  assert.equal(calls, 1, 'kill switch is retryable later, not immediately');
});

test('unreadable 401/403 and 5xx bodies map to operation-specific retryable failures', async () => {
  for (const status of [401, 403, 502]) {
    const retrieve = createRemoteFaqRagHttpClient({
      env: ENV,
      credentialsProvider: STATIC_CREDENTIALS,
      abortSafetyMarginMs: 29_950,
      fetch: async () => new Response('not a remote-v1 DTO', { status }),
    });
    const generate = createRemoteFaqRagHttpClient({
      env: ENV,
      credentialsProvider: STATIC_CREDENTIALS,
      fetch: async () => new Response('not a remote-v1 DTO', { status }),
    });
    const result = await withoutConsoleErrors(async () => ({
      retrieve: await retrieve.retrieve(fixture.cases.noMatch.retrieve.request),
      generate: await generate.generate(fixture.cases.success.generate.request),
    }));
    assert.equal(result.value.retrieve.error.code, 'retrieval_failed');
    assert.equal(result.value.retrieve.error.retryable, true);
    assert.equal(result.value.generate.error.code, 'generation_failed');
    assert.equal(result.value.generate.error.retryable, true);
  }
});
