import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(HERE, '..', 'functions', 'faq-chat', 'adapters', 'remote', 'http-client.ts');
const timingPath = path.resolve(path.dirname(clientPath), '..', '..', 'shell-timing.ts');
const splitGolden = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'faq-chat-remote-v1.golden.json'), 'utf8'));
const answerGolden = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'faq-chat-remote-one-shot-v1.golden.json'), 'utf8'));
const FUNCTION_URL = 'https://abc123.lambda-url.us-west-2.on.aws';
const API_URL = 'https://example.execute-api.us-west-2.amazonaws.com/api';
const credentials = async () => ({
  accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'example-secret', sessionToken: 'example-session',
});
let outDir;
let createRemoteFaqRagHttpClient;
let createRemoteFaqRagAnswerHttpClient;
let runFaqShellTiming;

before(async () => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faq-function-url-test-'));
  await build({
    entryPoints: [clientPath],
    bundle: true, format: 'esm', platform: 'node', outfile: path.join(outDir, 'client.mjs'),
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    plugins: [{
      name: 'invocation-timing-export',
      setup(builder) {
        // Use the actual signer and the client's own AsyncLocalStorage timing instance.
        builder.onLoad({ filter: /remote[\\/]http-client\.ts$/ }, (args) => ({
          contents: fs.readFileSync(args.path, 'utf8') + '\nexport { runFaqShellTiming } from ' + JSON.stringify(timingPath) + ';',
          loader: 'ts',
        }));
      },
    }],
  });
  ({ createRemoteFaqRagHttpClient, createRemoteFaqRagAnswerHttpClient, runFaqShellTiming } =
    await import(pathToFileURL(path.join(outDir, 'client.mjs')).href));
});

after(() => {
  if (outDir === undefined) return;
  assert.equal(path.dirname(path.resolve(outDir)), path.resolve(os.tmpdir()));
  fs.rmSync(outDir, { recursive: true, force: true });
});

function options(baseUrl, fetch) {
  return {
    env: { FAQ_REMOTE_RAG_BASE_URL: baseUrl, AWS_REGION: 'us-west-2' },
    credentialsProvider: credentials,
    now: () => splitGolden.clock.initialEpochMs,
    sleep: async () => assert.fail('these operations must not retry'),
    fetch,
  };
}

function operationFixture(operation) {
  if (operation === 'answer') {
    const success = answerGolden.responses.find((item) => item.statusCode === 200);
    return { request: JSON.parse(answerGolden.request), response: JSON.parse(success.body) };
  }
  return splitGolden.cases.success[operation];
}

function clientFor(operation, clientOptions) {
  return operation === 'answer'
    ? createRemoteFaqRagAnswerHttpClient(clientOptions)
    : createRemoteFaqRagHttpClient(clientOptions);
}

for (const [baseUrl, service] of [[FUNCTION_URL, 'lambda'], [API_URL, 'execute-api']]) {
  for (const operation of ['retrieve', 'generate', 'answer']) {
    test(`${service} signs ${operation} with the actual payload hash, host and session headers`, async () => {
      const fixture = operationFixture(operation);
      let calls = 0;
      const client = clientFor(operation, options(`${baseUrl}/`, async (url, init) => {
        calls += 1;
        assert.equal(String(url), `${baseUrl}/v1/${operation}`);
        assert.equal(init.method, 'POST');
        assert.equal(init.redirect, 'manual');
        assert.deepEqual(JSON.parse(init.body), fixture.request);
        const headers = new Headers(init.headers);
        const authorization = headers.get('authorization');
        assert.match(authorization, new RegExp(`^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/\\d{8}/us-west-2/${service}/aws4_request,`));
        assert.equal(headers.get('host'), new URL(baseUrl).host);
        assert.equal(headers.get('content-type'), 'application/json');
        assert.equal(headers.get('x-amz-content-sha256'), createHash('sha256').update(init.body).digest('hex'));
        assert.match(headers.get('x-amz-date'), /^\d{8}T\d{6}Z$/);
        assert.equal(headers.get('x-amz-security-token'), 'example-session');
        const signedHeaders = /SignedHeaders=([^,]+)/.exec(authorization)?.[1].split(';');
        for (const name of ['host', 'content-type', 'x-amz-content-sha256', 'x-amz-date', 'x-amz-security-token']) {
          assert.ok(signedHeaders?.includes(name), `${name} must be signed`);
        }
        return new Response(JSON.stringify(fixture.response), { status: 200 });
      }));
      assert.deepEqual(await client[operation](fixture.request), fixture.response);
      assert.equal(calls, 1);
    });
  }
}

test('only a complete standard Function URL hostname selects lambda signing', async () => {
  const nonFunctionHosts = [
    'abc123.lambda-url.us-east-1.on.aws.example.com',
    'prefix.abc123.lambda-url.us-east-1.on.aws',
    'abc-123.lambda-url.us-east-1.on.aws',
    'lambda-url.us-east-1.on.aws',
    'abc123.lambda-url.us-east-1.on.aws.',
    'custom.example.com',
  ];
  for (const hostname of nonFunctionHosts) {
    for (const operation of ['retrieve', 'answer']) {
      const fixture = operationFixture(operation);
      let calls = 0;
      const client = clientFor(operation, options(`https://${hostname}`, async (_url, init) => {
        calls += 1;
        assert.match(new Headers(init.headers).get('authorization'), /\/us-west-2\/execute-api\/aws4_request/);
        return new Response(JSON.stringify(fixture.response), { status: 200 });
      }));
      assert.deepEqual(await client[operation](fixture.request), fixture.response);
      assert.equal(calls, 1);
    }
  }
});

test('both clients reject a Function URL or API Gateway region mismatch before credentials or HTTP', () => {
  for (const createClient of [createRemoteFaqRagHttpClient, createRemoteFaqRagAnswerHttpClient]) {
    for (const baseUrl of [
      'https://abc123.lambda-url.us-east-1.on.aws',
      'https://example.execute-api.us-east-1.amazonaws.com/api',
    ]) {
      assert.throws(() => createClient({
        ...options(baseUrl, async () => assert.fail('must fail before HTTP')),
        credentialsProvider: async () => assert.fail('must fail before credentials'),
      }), /Invalid remote FAQ RAG configuration: FAQ_REMOTE_RAG_BASE_URL host region \(us-east-1\) must match AWS_REGION \(us-west-2\)/);
    }
  }
});

test('API Gateway and Function URL 403 bodies preserve failure classification, status and request ID', async () => {
  const bodies = [
    JSON.stringify({ message: 'Forbidden' }),
    JSON.stringify({ Message: 'Forbidden' }),
    JSON.stringify({ Message: null }),
    'Forbidden',
    '',
  ];
  for (const baseUrl of [API_URL, FUNCTION_URL]) {
    for (const operation of ['retrieve', 'generate', 'answer']) {
      for (const body of bodies) {
        const metrics = [];
        const errors = [];
        const observed = [];
        let calls = 0;
        const client = clientFor(operation, options(baseUrl, async () => {
          calls += 1;
          return new Response(body, { status: 403, headers: { 'x-amzn-requestid': 'synthetic-denied-request' } });
        }));
        const originalLog = console.log;
        const originalError = console.error;
        let result;
        try {
          console.log = (entry) => metrics.push(JSON.parse(entry));
          console.error = (...entries) => errors.push(entries.map(String).join(' '));
          result = await runFaqShellTiming({ requestId: 'synthetic-shell-request', coldStart: false }, () =>
            client[operation](operationFixture(operation).request, { onHttpResponse: (entry) => observed.push(entry) }));
        } finally {
          console.log = originalLog;
          console.error = originalError;
        }
        assert.deepEqual(result, {
          contractVersion: operation === 'answer' ? 'remote-one-shot-v1' : 'remote-v1',
          ok: false,
          error: { code: operation === 'generate' ? 'generation_failed' : 'retrieval_failed', retryable: true },
        });
        assert.equal(calls, 1, 'authentication failures must never retry');
        assert.deepEqual(observed, [{ operation, status: 403, requestId: 'synthetic-denied-request' }]);
        assert.equal(metrics.length, 1);
        assert.deepEqual(metrics[0].remote_attempts.map(({ operation, attempt, outcome }) => ({ operation, attempt, outcome })), [
          { operation, attempt: 1, outcome: 'failure' },
        ]);
        assert.match(errors.join('\n'), /status=403/);
        assert.doesNotMatch(errors.join('\n'), /Forbidden|synthetic-denied-request/);
      }
    }
  }
});
