#!/usr/bin/env node
/** Public-only contract tests for the lite DynamoDB adapter boundary. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAMBDA_ROOT = path.resolve(HERE, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'faq-lite-adapters-test-'));

after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

async function bundle(entryPoint, outfile, setup) {
  await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outfile,
    logLevel: 'silent',
    plugins: [{ name: 'lite-dynamodb-contract-stub', setup }],
  });
  return import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);
}

test('public production adapter keeps Settings and conditional Q&A storage contracts', async () => {
  const state = {
    getCalls: [],
    putCalls: [],
    settingRow: { key: 'faq_chat', value: { enabled: true, fallbackMessage: 'fallback' } },
  };
  globalThis.__faqLiteStorageState = state;

  const module = await bundle(
    path.join(LAMBDA_ROOT, 'functions', 'faq-chat', 'adapters', 'production.ts'),
    path.join(tempRoot, 'production.mjs'),
    (esbuild) => {
      esbuild.onResolve({ filter: /free[\\/]index\.js$/ }, () => ({
        path: 'free-index',
        namespace: 'lite-test',
      }));
      esbuild.onResolve({ filter: /free[\\/]dynamodb-entries\.js$/ }, () => ({
        path: 'free-kb',
        namespace: 'lite-test',
      }));
      esbuild.onResolve({ filter: /infra[\\/]lite-dynamodb\.js$/ }, () => ({
        path: 'lite-dynamodb',
        namespace: 'lite-test',
      }));
      esbuild.onLoad({ filter: /^free-index$/, namespace: 'lite-test' }, () => ({
        contents: `export function createFreeFaqPorts() {
          return { retrieval: {}, answerGeneration: {}, smalltalkGeneration: {},
            answerPrompt: {}, defaultModel: 'free-test' };
        }`,
        loader: 'js',
      }));
      esbuild.onLoad({ filter: /^free-kb$/, namespace: 'lite-test' }, () => ({
        contents: 'export const dynamoDbFaqKbSource = {};',
        loader: 'js',
      }));
      esbuild.onLoad({ filter: /^lite-dynamodb$/, namespace: 'lite-test' }, () => ({
        contents: `
          export const LiteTableNames = {
            Settings: 'dev-Settings', KnowledgeEntries: 'dev-KnowledgeEntries',
            FaqQaLogs: 'dev-FaqQaLogs'
          };
          export async function getItem(table, key) {
            globalThis.__faqLiteStorageState.getCalls.push({ table, key });
            return globalThis.__faqLiteStorageState.settingRow;
          }
          export async function putItem(table, item, options) {
            globalThis.__faqLiteStorageState.putCalls.push({ table, item, options });
          }
        `,
        loader: 'js',
      }));
    }
  );

  const adapters = module.createProductionFaqAdapters();
  assert.deepEqual(await adapters.storage.loadSettings(), state.settingRow.value);
  assert.deepEqual(state.getCalls, [
    { table: 'dev-Settings', key: { key: 'faq_chat' } },
  ]);

  const record = {
    dateBucket: '2026-08-21',
    ts: '2026-08-21T00:00:00.000Z#abcd1234',
    question: 'question',
    answer: 'answer',
    responseType: 'answer',
    route: 'answer',
    scopeFallback: false,
    failureKind: null,
    guardDetail: null,
    sources: ['source'],
    model: null,
    totalMs: 10,
    ttl: 1_800_000_000,
  };
  await adapters.storage.putQaLog(record);
  assert.deepEqual(state.putCalls, [
    {
      table: 'dev-FaqQaLogs',
      item: record,
      options: {
        conditionExpression: 'attribute_not_exists(#ts)',
        expressionAttributeNames: { '#ts': 'ts' },
      },
    },
  ]);
});

test('public KB source filters active public default-agent rows twice', async () => {
  const state = {
    calls: [],
    rows: [
      { entryId: 'a', topic: 'A', answer: 'Answer A', status: 'active', visibility: 'public' },
      { entryId: 'b', topic: 'B', answer: 'Answer B', status: 'active', visibility: 'public', agentId: 'default', canonicalUrl: 'https://example.jp/b' },
      { entryId: 'inactive', topic: 'X', answer: 'X', status: 'inactive', visibility: 'public' },
      { entryId: 'private', topic: 'X', answer: 'X', status: 'active', visibility: 'internal' },
      { entryId: 'other-agent', topic: 'X', answer: 'X', status: 'active', visibility: 'public', agentId: 'other' },
      { entryId: 'invalid', topic: 'X', status: 'active', visibility: 'public' },
    ],
  };
  globalThis.__faqLiteKbState = state;

  const module = await bundle(
    path.join(
      LAMBDA_ROOT,
      'functions',
      'faq-chat',
      'adapters',
      'free',
      'dynamodb-entries.ts'
    ),
    path.join(tempRoot, 'dynamodb-entries.mjs'),
    (esbuild) => {
      esbuild.onResolve({ filter: /infra[\\/]lite-dynamodb\.js$/ }, () => ({
        path: 'lite-dynamodb',
        namespace: 'lite-test',
      }));
      esbuild.onLoad({ filter: /^lite-dynamodb$/, namespace: 'lite-test' }, () => ({
        contents: `
          export const LiteTableNames = { KnowledgeEntries: 'dev-KnowledgeEntries' };
          export async function scanAll(table, options) {
            globalThis.__faqLiteKbState.calls.push({ table, options });
            return globalThis.__faqLiteKbState.rows;
          }
        `,
        loader: 'js',
      }));
    }
  );

  assert.deepEqual(await module.loadPublicKnowledgeEntries(), [
    { id: 'a', topic: 'A', content: 'Answer A' },
    { id: 'b', topic: 'B', content: 'Answer B', canonicalUrl: 'https://example.jp/b' },
  ]);
  assert.deepEqual(state.calls, [
    {
      table: 'dev-KnowledgeEntries',
      options: {
        filterExpression:
          '#status = :active AND #visibility = :public AND ' +
          '(attribute_not_exists(#agentId) OR #agentId = :defaultAgentId)',
        expressionAttributeNames: {
          '#status': 'status',
          '#visibility': 'visibility',
          '#agentId': 'agentId',
        },
        expressionAttributeValues: {
          ':active': 'active',
          ':public': 'public',
          ':defaultAgentId': 'default',
        },
      },
    },
  ]);
});
