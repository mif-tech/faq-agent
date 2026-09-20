import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const lambdaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let temporary;
let toFaqHttpApiEvent;

before(async () => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'faq-rest-event-'));
  const outfile = path.join(temporary, 'rest-event.mjs');
  await build({
    entryPoints: [path.join(lambdaRoot, 'functions/faq-chat/rest-event.ts')],
    outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent',
  });
  ({ toFaqHttpApiEvent } = await import(pathToFileURL(outfile).href));
});

after(() => {
  if (temporary === undefined) return;
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  fs.rmSync(temporary, { recursive: true, force: true });
});

function restEvent(overrides = {}) {
  return {
    httpMethod: 'POST',
    path: '/faq-chat',
    resource: '/faq-chat',
    headers: { 'Content-Type': 'application/json' },
    multiValueHeaders: null,
    pathParameters: null,
    requestContext: {
      accountId: '123456789012', apiId: 'example', stage: 'api', requestId: 'request-1',
      path: '/api/faq-chat',
      domainName: 'example.execute-api.us-west-2.amazonaws.com', domainPrefix: 'example',
      protocol: 'HTTP/1.1', requestTime: '19/Sep/2026:00:00:00 +0000', requestTimeEpoch: 1789776000000,
      identity: { sourceIp: '192.0.2.10', userAgent: 'test-client' },
    },
    body: '{"messages":[{"role":"user","content":"こんにちは"}]}',
    isBase64Encoded: false,
    ...overrides,
  };
}

test('REST metadata and body become the HTTP API v2 FAQ contract without mutating input', () => {
  const event = restEvent();
  const snapshot = structuredClone(event);
  const converted = toFaqHttpApiEvent(event);
  assert.equal(converted.version, '2.0');
  assert.equal(converted.rawPath, '/faq-chat');
  assert.equal(converted.rawQueryString, '');
  assert.equal(converted.routeKey, 'POST /faq-chat');
  assert.equal(converted.requestContext.routeKey, converted.routeKey);
  assert.deepEqual(converted.requestContext.http, {
    method: 'POST', path: '/faq-chat', protocol: 'HTTP/1.1', sourceIp: '192.0.2.10', userAgent: 'test-client',
  });
  assert.equal(converted.requestContext.requestId, 'request-1');
  assert.equal(converted.requestContext.stage, 'api');
  assert.equal(converted.requestContext.timeEpoch, event.requestContext.requestTimeEpoch);
  assert.equal(converted.requestContext.time, event.requestContext.requestTime);
  assert.equal(converted.body, event.body);
  assert.equal(converted.isBase64Encoded, false);
  assert.deepEqual(event, snapshot);
});

test('headers use lowercase keys and comma-joined multiValueHeaders without duplicate single values', () => {
  const converted = toFaqHttpApiEvent(restEvent({
    headers: { 'Content-Type': 'application/json', 'X-Trace': 'last', 'USER-AGENT': 'client', 'X-Duplicate': 'a', 'x-duplicate': 'b' },
    multiValueHeaders: { 'x-TRACE': ['first', 'last'], 'X-Multi': ['one'], 'x-multi': ['two'] },
  }));
  assert.deepEqual(converted.headers, {
    'content-type': 'application/json', 'x-trace': 'first,last', 'user-agent': 'client',
    'x-duplicate': 'a,b', 'x-multi': 'one,two',
  });
});

test('named agent path parameters and stage-free resource preserve routing', () => {
  const converted = toFaqHttpApiEvent(restEvent({
    path: '/agents/help/faq-chat', resource: '/agents/{agentId}/faq-chat',
    pathParameters: { agentId: 'help' },
    requestContext: { ...restEvent().requestContext, path: '/api/agents/help/faq-chat' },
  }));
  assert.deepEqual(converted.pathParameters, { agentId: 'help' });
  assert.equal(converted.rawPath, '/agents/help/faq-chat');
  assert.equal(converted.routeKey, 'POST /agents/{agentId}/faq-chat');
});

test('stage stripping requires an exact complete segment and happens only once', () => {
  for (const [input, expected] of [
    ['/faq-chat', '/faq-chat'], ['/api/faq-chat', '/faq-chat'], ['/apix/faq-chat', '/apix/faq-chat'],
    ['/api', '/'], ['/api/api/faq-chat', '/api/faq-chat'], ['/other/api/faq-chat', '/other/api/faq-chat'],
  ]) {
    const converted = toFaqHttpApiEvent(restEvent({ path: input, resource: input }));
    assert.equal(converted.rawPath, expected);
    assert.equal(converted.requestContext.http.path, expected);
    assert.equal(converted.routeKey, `POST ${expected}`);
  }
});

test('base64 body and flag are preserved for the entrypoint to reject explicitly', () => {
  const body = Buffer.from(restEvent().body).toString('base64');
  const converted = toFaqHttpApiEvent(restEvent({ body, isBase64Encoded: true }));
  assert.equal(converted.body, body);
  assert.equal(converted.isBase64Encoded, true);
});

test('OPTIONS permits null or absent body, headers and path parameters', () => {
  for (const body of [null, undefined]) {
    const converted = toFaqHttpApiEvent(restEvent({ httpMethod: 'OPTIONS', body, headers: null }));
    assert.equal(converted.routeKey, 'OPTIONS /faq-chat');
    assert.equal(converted.body, undefined);
    assert.deepEqual(converted.headers, {});
    assert.equal(converted.pathParameters, undefined);
  }
});

test('required routing metadata is validated before reading any body', () => {
  const mutations = [
    (event) => { delete event.httpMethod; },
    (event) => { event.httpMethod = 10; },
    (event) => { event.httpMethod = 'post'; },
    (event) => { delete event.path; },
    (event) => { event.path = 'faq-chat'; },
    (event) => { delete event.resource; },
    (event) => { event.resource = ''; },
    (event) => { delete event.requestContext; },
    (event) => { event.requestContext = []; },
    (event) => { delete event.requestContext.identity; },
    (event) => { delete event.requestContext.identity.sourceIp; },
    (event) => { event.requestContext.identity.sourceIp = ' '; },
    (event) => { delete event.requestContext.requestId; },
    (event) => { event.requestContext.requestId = 123; },
    (event) => { delete event.requestContext.stage; },
    (event) => { event.requestContext.stage = ''; },
    (event) => { delete event.isBase64Encoded; },
    (event) => { event.isBase64Encoded = 'false'; },
    (event) => { event.headers = { secret: 1 }; },
    (event) => { event.multiValueHeaders = { secret: 'not-an-array' }; },
    (event) => { event.multiValueHeaders = { secret: [1] }; },
    (event) => { event.pathParameters = { agentId: 1 }; },
    (event) => { event.resource = '/agents/{agentId}/faq-chat'; },
  ];
  for (const mutate of mutations) {
    const event = restEvent();
    let bodyReads = 0;
    Object.defineProperty(event, 'body', { get() { bodyReads += 1; throw new Error('private-body-canary'); } });
    mutate(event);
    assert.throws(() => toFaqHttpApiEvent(event), { message: 'Invalid REST API event' });
    assert.equal(bodyReads, 0, mutate.toString());
  }
});

test('malformed event roots and non-string bodies fail with a fixed safe error', () => {
  for (const event of [null, undefined, 123, 'secret', [], {}, restEvent({ body: { secret: true } })]) {
    assert.throws(() => toFaqHttpApiEvent(event), { message: 'Invalid REST API event' });
  }
});
