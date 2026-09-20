import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let temporary;
let runtime;
let decorated = 0;
const previousGlobal = globalThis.awslambda;
const previousOrigin = process.env.FAQ_CORS_ORIGIN;
const context = { awsRequestId: 'lambda-request', getRemainingTimeInMillis: () => 30_000 };

before(async () => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'faq-rest-stream-'));
  process.env.FAQ_CORS_ORIGIN = 'https://faq.example.invalid';
  globalThis.awslambda = {
    streamifyResponse(callback) { decorated += 1; return callback; },
    HttpResponseStream: {
      from(stream, metadata) {
        if (stream.failPrelude) throw new Error('prelude failed');
        stream.metadata.push(metadata);
        return stream;
      },
    },
  };
  const outfile = path.join(temporary, 'bootstrap.mjs');
  await build({
    stdin: {
      contents: [
        `export * from ${JSON.stringify(path.join(root, 'functions/faq-chat/bootstrap.ts'))};`,
        `export { jsonResponse, TECHNICAL_FALLBACK_ENVELOPE } from ${JSON.stringify(path.join(root, 'functions/faq-chat/handler.ts'))};`,
        `export { toFaqHttpApiEvent } from ${JSON.stringify(path.join(root, 'functions/faq-chat/rest-event.ts'))};`,
        'export { control } from "test-composition";',
      ].join('\n'),
      loader: 'ts', resolveDir: root,
    },
    plugins: [{
      name: 'stub-only-composition',
      setup(builder) {
        builder.onResolve({ filter: /^test-composition$|^\.\/composition\.js$/ }, () => ({
          path: 'test-composition', namespace: 'fixture',
        }));
        builder.onResolve({ filter: /^\.\/handler\.js$/ }, (args) =>
          args.importer.endsWith('bootstrap.ts') ? { path: 'test-handler', namespace: 'fixture' } : undefined);
        builder.onLoad({ filter: /^test-composition$/, namespace: 'fixture' }, () => ({
          contents: `
            import { createStubFaqPorts } from ${JSON.stringify(path.join(root, 'functions/faq-chat/adapters/stub.ts'))};
            export const control = { ports: null, override: null };
            export function createFaqComposition() {
              control.ports = createStubFaqPorts({ settings: { enabled: true } });
              return { ports: control.ports };
            }`,
          resolveDir: root, loader: 'ts',
        }));
        builder.onLoad({ filter: /^test-handler$/, namespace: 'fixture' }, () => ({
          contents: `
            import { createFaqHandler as actual } from ${JSON.stringify(path.join(root, 'functions/faq-chat/handler.ts'))};
            export { jsonResponse, TECHNICAL_FALLBACK_ENVELOPE } from ${JSON.stringify(path.join(root, 'functions/faq-chat/handler.ts'))};
            import { control } from 'test-composition';
            export function createFaqHandler(...args) {
              const handler = actual(...args);
              return (event, context) => control.override ? control.override(event, context) : handler(event, context);
            }`,
          resolveDir: root, loader: 'ts',
        }));
      },
    }],
    outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent',
  });
  runtime = await import(pathToFileURL(outfile).href);
});

after(() => {
  if (previousGlobal === undefined) delete globalThis.awslambda;
  else globalThis.awslambda = previousGlobal;
  if (previousOrigin === undefined) delete process.env.FAQ_CORS_ORIGIN;
  else process.env.FAQ_CORS_ORIGIN = previousOrigin;
  if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
});

function restEvent(overrides = {}) {
  return {
    httpMethod: 'POST', path: '/faq-chat', resource: '/faq-chat',
    pathParameters: null, headers: { 'Content-Type': 'application/json' }, multiValueHeaders: null,
    body: JSON.stringify({ messages: [{ role: 'user', content: 'こんにちは' }] }), isBase64Encoded: false,
    requestContext: {
      requestId: 'rest-request', path: '/public/faq-chat', stage: 'public', identity: { sourceIp: '192.0.2.1' },
    },
    ...overrides,
  };
}

function sink(overrides = {}) {
  return {
    metadata: [], chunks: [], ends: 0,
    write(chunk) { this.chunks.push(chunk); },
    end() { this.ends += 1; },
    ...overrides,
  };
}

async function capture(callback) {
  const logs = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const level of Object.keys(saved)) console[level] = (...args) => logs.push(args);
  try {
    const result = await callback();
    return { result, logs, metrics: logs.flatMap(([line]) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    }) };
  } finally { Object.assign(console, saved); }
}

test('runtime decorates the stream export and preserves existing status, headers and completed JSON', async () => {
  assert.equal(decorated, 1);
  for (const event of [restEvent(), restEvent({ httpMethod: 'OPTIONS', body: null }),
    restEvent({ body: '{' }), restEvent({ path: '/agents/sample/faq-chat',
      resource: '/agents/{agentId}/faq-chat', pathParameters: { agentId: 'sample' },
      requestContext: { ...restEvent().requestContext, path: '/public/agents/sample/faq-chat' } })]) {
    const buffered = await capture(() => runtime.handler(runtime.toFaqHttpApiEvent(event), context));
    const output = sink();
    const streamed = await capture(() => runtime.streamHandler(event, output, context));
    assert.deepEqual(output.metadata, [{ statusCode: buffered.result.statusCode, headers: buffered.result.headers }]);
    assert.deepEqual(output.chunks, [buffered.result.body ?? '']);
    assert.equal(output.ends, 1);
    assert.equal(buffered.metrics.find(({ metric }) => metric === 'faq_shell_timing').entrypoint, 'http-api');
    assert.equal(streamed.metrics.find(({ metric }) => metric === 'faq_shell_timing').entrypoint, 'rest-stream');
    for (const metric of streamed.metrics.filter(({ metric }) => metric === 'faq_chat')) {
      assert.equal(Object.hasOwn(metric, 'entrypoint'), false);
    }
  }
  const afterStream = await capture(() => runtime.handler(runtime.toFaqHttpApiEvent(restEvent()), context));
  assert.equal(afterStream.metrics.find(({ metric }) => metric === 'faq_shell_timing').entrypoint, 'http-api');
});

test('stream transport preserves busy 429 Retry-After and unavailable 503 responses', async () => {
  try {
    for (const statusCode of [429, 503]) {
      const response = { statusCode, headers: { 'Access-Control-Allow-Origin': 'https://faq.example.invalid',
        'Content-Type': 'application/json', 'Retry-After': '5' }, body: '{"error":"busy","retryable":true}' };
      runtime.control.override = async () => response;
      const output = sink();
      await runtime.streamHandler(restEvent(), output, context);
      assert.deepEqual(output.metadata, [{ statusCode, headers: response.headers }]);
      assert.deepEqual(output.chunks, [response.body]);
      assert.equal(output.ends, 1);
    }
  } finally { runtime.control.override = null; }
});

test('handler exceptions produce a fixed 500 technical fallback without leaking diagnostic data', async () => {
  const secret = 'private-request-canary';
  const expectedBody = '{"answer":"申し訳ありません。一時的に回答を生成できませんでした。お手数ですが、もう一度お試しください。","answerable":false,"sources":[],"responseType":"refuse","failureKind":"envelope_invalid","retryable":true}';
  assert.equal(Object.isFrozen(runtime.TECHNICAL_FALLBACK_ENVELOPE), true);
  assert.equal(Object.isFrozen(runtime.TECHNICAL_FALLBACK_ENVELOPE.sources), true);
  assert.throws(() => { runtime.TECHNICAL_FALLBACK_ENVELOPE.answer = secret; }, TypeError);
  assert.throws(() => { runtime.TECHNICAL_FALLBACK_ENVELOPE.sources.push({ topic: secret }); }, TypeError);
  runtime.control.override = async () => { throw new Error(secret); };
  try {
    const output = sink();
    const { logs } = await capture(() => runtime.streamHandler(restEvent(), output, context));
    assert.equal(output.metadata[0].statusCode, 500);
    assert.deepEqual(output.metadata[0].headers, runtime.jsonResponse(500, {}).headers);
    assert.deepEqual(output.chunks, [expectedBody]);
    const response = JSON.parse(output.chunks[0]);
    assert.deepEqual(response, runtime.TECHNICAL_FALLBACK_ENVELOPE);
    assert.doesNotMatch(JSON.stringify({ output, logs }), new RegExp(secret));
    assert.equal(output.ends, 1);
  } finally { runtime.control.override = null; }
});

test('invalid metadata returns 400 without reading the body or invoking the handler', async () => {
  let called = false;
  runtime.control.override = async () => { called = true; throw new Error('must not invoke'); };
  try {
    const event = restEvent({ httpMethod: undefined });
    Object.defineProperty(event, 'body', { get() { throw new Error('must not read'); } });
    const output = sink();
    await runtime.streamHandler(event, output, context);
    assert.equal(output.metadata[0].statusCode, 400);
    assert.deepEqual(output.metadata[0].headers, runtime.jsonResponse(400, {}).headers);
    assert.deepEqual(JSON.parse(output.chunks[0]), { error: 'Invalid request' });
    assert.equal(output.ends, 1);
    assert.equal(called, false);
  } finally { runtime.control.override = null; }
});

test('base64 requests and responses are explicitly rejected, never treated as text JSON', async () => {
  const requestOutput = sink();
  await runtime.streamHandler(restEvent({ isBase64Encoded: true, body: 'e30=' }), requestOutput, context);
  assert.equal(requestOutput.metadata[0].statusCode, 400);
  assert.equal(requestOutput.ends, 1);
  runtime.control.override = async () => ({ statusCode: 200, isBase64Encoded: true, body: 'e30=' });
  try {
    const output = sink();
    await runtime.streamHandler(restEvent(), output, context);
    assert.equal(output.metadata[0].statusCode, 500);
    assert.equal(JSON.parse(output.chunks[0]).retryable, true);
    assert.equal(output.ends, 1);
  } finally { runtime.control.override = null; }
});

test('prelude and write failures still close the stream without attempting a second response', async () => {
  for (const options of [{ failPrelude: true }, { write() { throw new Error('write failed'); } }]) {
    const output = sink(options);
    await capture(() => assert.rejects(runtime.streamHandler(restEvent(), output, context), /failed/));
    assert.ok(output.metadata.length <= 1);
    assert.equal(output.ends, 1);
  }
});

test('buffered bootstrap can load and run without the AWS streaming global', async () => {
  const saved = globalThis.awslambda;
  delete globalThis.awslambda;
  try {
    const buffered = await import(`${pathToFileURL(path.join(temporary, 'bootstrap.mjs')).href}?buffered`);
    const { result } = await capture(() => buffered.handler(runtime.toFaqHttpApiEvent(restEvent({ httpMethod: 'OPTIONS' })), context));
    assert.equal(result.statusCode, 204);
  } finally { globalThis.awslambda = saved; }
});
