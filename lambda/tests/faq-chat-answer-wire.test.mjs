#!/usr/bin/env node
/** Synthetic, public-safe one-shot DTO bytes and strict boundary tests. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faq-answer-wire-'));
await build({
  entryPoints: { contract: path.join(HERE, '../functions/faq-chat/adapters/remote/answer-contract.ts') },
  bundle: true, format: 'esm', platform: 'node', outdir: outDir,
  outExtension: { '.js': '.mjs' },
});
const {
  FAQ_RAG_ANSWER_CONTRACT_VERSION, REMOTE_ONE_SHOT_ANSWER_ERROR_CODES,
  RemoteOneShotContractValidationError,
  parseRemoteOneShotAnswerRequest: parseRequest, parseRemoteOneShotAnswerResponse: parseResponse,
} = await import(pathToFileURL(path.join(outDir, 'contract.mjs')).href);
const golden = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/faq-chat-remote-one-shot-v1.golden.json'), 'utf8'));
const request = () => JSON.parse(golden.request);
const success = () => JSON.parse(golden.responses[0].body);
const invalid = (parse, value) => assert.throws(() => parse(value), RemoteOneShotContractValidationError);

after(() => {
  assert.equal(path.dirname(path.resolve(outDir)), path.resolve(os.tmpdir()));
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('synthetic request and all response envelopes preserve frozen UTF-8 bytes', () => {
  assert.equal(FAQ_RAG_ANSWER_CONTRACT_VERSION, 'remote-one-shot-v1');
  assert.equal(JSON.stringify(parseRequest(request())), golden.request);
  const expectedStatus = {
    no_match: 404, invalid_contract: 400, quota_exceeded: 429, kill_switch: 503,
    deadline_exceeded: 504, retrieval_failed: 502, generation_failed: 502,
  };
  assert.deepEqual(REMOTE_ONE_SHOT_ANSWER_ERROR_CODES, Object.keys(expectedStatus));
  for (const entry of golden.responses) {
    const parsed = parseResponse(JSON.parse(entry.body));
    assert.deepEqual(Buffer.from(JSON.stringify(parsed)), Buffer.from(entry.body));
    assert.equal(entry.statusCode, parsed.ok ? 200 : expectedStatus[parsed.error.code]);
  }
});

test('request permits only optional hints and rejects unknown or undefined fields at every level', () => {
  const noHints = request();
  delete noHints.hints;
  assert.equal(Object.hasOwn(parseRequest(noHints), 'hints'), false);
  for (const field of Object.keys(request()).filter((key) => key !== 'hints')) {
    const missing = request(); delete missing[field]; invalid(parseRequest, missing);
    invalid(parseRequest, { ...request(), [field]: undefined });
  }
  for (const field of [
    'question', 'tenantId', 'sessionToken', 'kbBlock', 'model', 'prompt', 'score', 'telemetry',
  ]) invalid(parseRequest, { ...request(), [field]: undefined });
  for (const hints of [undefined, null, {}, { lexicalTerms: [] },
    { lexicalTerms: [], semanticQueries: [], extra: undefined },
    { lexicalTerms: undefined, semanticQueries: [] }]) invalid(parseRequest, { ...request(), hints });
  invalid(parseRequest, { ...request(), messages: [{ role: 'user', content: request().currentQuestion, extra: undefined }] });
  invalid(parseRequest, { ...request(), [Symbol('private')]: true });
  invalid(parseRequest, Object.assign(Object.create({ inherited: true }), request()));
  for (const value of [undefined, null, [], 'not-json', true]) invalid(parseRequest, value);
});

test('request shares split code point, message suffix, hints and safe integer bounds', () => {
  for (const contractVersion of ['remote-v1', 'remote-v2', 'remote-answer-v1', '', undefined]) {
    invalid(parseRequest, { ...request(), contractVersion });
  }
  for (const currentQuestion of ['', ' ', 'x'.repeat(4001)]) {
    invalid(parseRequest, { ...request(), currentQuestion, messages: [{ role: 'user', content: currentQuestion }] });
  }
  const unicodeQuestion = '😀'.repeat(4000);
  assert.equal(parseRequest({ ...request(), currentQuestion: unicodeQuestion,
    messages: [{ role: 'user', content: unicodeQuestion }] }).currentQuestion, unicodeQuestion);
  for (const idempotencyKey of ['', ' ', 'x'.repeat(257), 42]) invalid(parseRequest, { ...request(), idempotencyKey });
  for (const remainingMs of [0, -1, 0.5, 60001, NaN, Infinity, '1000']) invalid(parseRequest, { ...request(), remainingMs });
  for (const messages of [[], [{ role: 'assistant', content: request().currentQuestion }],
    [{ role: 'user', content: 'different question' }], [request().messages[0], request().messages[0]],
    [{ role: 'user', content: `${'x'.repeat(8000)}${request().currentQuestion}` }]]) {
    invalid(parseRequest, { ...request(), messages });
  }
  const withHistory = { ...request(), messages: [{ role: 'user', content: `Earlier turn\n${request().currentQuestion}` }] };
  assert.deepEqual(parseRequest(withHistory), withHistory);
  for (const hints of [
    { lexicalTerms: ['x'.repeat(17)], semanticQueries: [] },
    { lexicalTerms: Array(9).fill('x'), semanticQueries: [] },
    { lexicalTerms: [' '], semanticQueries: [] },
    { lexicalTerms: [], semanticQueries: ['x'.repeat(65)] },
    { lexicalTerms: [], semanticQueries: Array(3).fill('x') },
  ]) invalid(parseRequest, { ...request(), hints });
});

test('response rejects transport ambiguity, token errors and inconsistent retry metadata', () => {
  for (const entry of golden.responses) {
    const parsed = JSON.parse(entry.body);
    invalid(parseResponse, { ...parsed, contractVersion: 'remote-v1' });
    invalid(parseResponse, { ...parsed, telemetry: undefined });
    if (!parsed.ok) {
      invalid(parseResponse, { ...parsed, error: { ...parsed.error, retryable: !parsed.error.retryable } });
      invalid(parseResponse, { ...parsed, error: { ...parsed.error, provider: undefined } });
      if (parsed.error.code === 'quota_exceeded') {
        for (const retryAfterMs of [undefined, 0, -1, 1.5, 86400001, '1000']) {
          invalid(parseResponse, { ...parsed, error: { ...parsed.error, retryAfterMs } });
        }
      } else invalid(parseResponse, { ...parsed, error: { ...parsed.error, retryAfterMs: undefined } });
    }
  }
  for (const code of ['expired_token', 'remote_transport_unsupported', 'unknown']) {
    invalid(parseResponse, { contractVersion: FAQ_RAG_ANSWER_CONTRACT_VERSION, ok: false, error: { code, retryable: true } });
  }
  invalid(parseResponse, { message: 'Not Found' });
  invalid(parseResponse, { ...success(), ok: 1 });
});

test('response preserves existing source, answer and refusal guards', () => {
  for (const response of [
    { ...success().response, answer: 'See https://example.com/private' },
    { ...success().response, answerable: false },
    { ...success().response, sources: [] },
    { ...success().response, sources: Array(6).fill(success().response.sources[0]) },
    { ...success().response, sources: [success().response.sources[0], success().response.sources[0]] },
    { ...success().response, sources: [{ ...success().response.sources[0], url: 'http://localhost/admin' }] },
    { ...success().response, sources: [{ ...success().response.sources[0], score: undefined }] },
    { ...success().response, sources: [{ ...success().response.sources[0], url: undefined }] },
    { ...success().response, scopeFallback: true },
    { ...success().response, telemetry: undefined },
    { answer: 'Try again.', answerable: false, sources: [], responseType: 'refuse', retryable: true },
    { answer: 'Try again.', answerable: false, sources: [], responseType: 'refuse', scopeFallback: true, failureKind: 'envelope_invalid', retryable: true },
  ]) invalid(parseResponse, { ...success(), response });
});

test('validation errors never retain invalid payload, key or private fields', () => {
  const canary = 'SYNTHETIC_SECRET_CANARY';
  for (const [parse, value] of [[parseRequest, { ...request(), currentQuestion: canary }],
    [parseResponse, { ...success(), response: { ...success().response, secret: canary } }]]) {
    try { parse(value); assert.fail('expected rejection'); } catch (error) {
      assert.ok(error instanceof RemoteOneShotContractValidationError);
      assert.equal(error.code, 'invalid_contract');
      assert.equal(Object.hasOwn(error, 'cause'), false);
      assert.equal(Reflect.ownKeys(error).map((key) => String(error[key])).join('|').includes(canary), false);
      assert.match(error.message, /remote-one-shot-v1/);
    }
  }
});
