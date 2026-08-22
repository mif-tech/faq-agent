#!/usr/bin/env node
/**
 * faq-chat の公開リポジトリ向け stub adapter 契約テスト / issue #120 run2
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAQ_ROOT = path.join(HERE, '..', 'functions', 'faq-chat');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faq-stub-adapter-test-'));
process.on('exit', () => fs.rmSync(outDir, { recursive: true, force: true }));
const outfile = path.join(outDir, 'stub.mjs');

await build({
  entryPoints: [path.join(FAQ_ROOT, 'adapters', 'stub.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile,
  logLevel: 'warning',
});

const { createStubFaqPorts } = await import(pathToFileURL(outfile).href);

const TELEMETRY_KEYS = [
  'attenuatedLaneSelectedEntryCount',
  'attenuatedOnlySelectedEntryCount',
  'budgetSkippedCount',
  'candidateCount',
  'chunkCount',
  'corpusRevision',
  'embeddedChunkRatio',
  'indexTruncated',
  'lexRankMode',
  'planLexicalDroppedTermCount',
  'planLexicalRawTermCount',
  'planLexicalSelectedEntryCount',
  'planOnlySelectedEntryCount',
  'planOverlapSelectedEntryCount',
  'planSemanticEmbeddedQueryCount',
  'planSemanticQueryCount',
  'planSemanticSelectedEntryCount',
  'planUsed',
  'queryPlanRevision',
  'retrievalRevision',
  'retrievalTrace',
  'retrieverAlgorithmRevision',
  'selectedChunkLabels',
  'selectedTopics',
  'selectionRevision',
  'semanticLaneSelectedEntryCount',
  'semanticOnlySelectedCount',
  'semanticUsed',
  'totalChunkCount',
  'totalEntryCount',
].sort();

const SAMPLE_ENTRIES = [
  {
    id: 'entry-hours',
    topic: '営業時間',
    canonicalUrl: 'https://example.com/hours',
    content: '営業時間は午前9時から午後5時までです。',
  },
  {
    id: 'entry-price',
    topic: '料金',
    canonicalUrl: 'https://example.com/price',
    content: '基本料金は500円です。',
  },
  {
    id: 'entry-location',
    topic: '所在地',
    content: '店舗は駅前にあります。',
  },
];

function generationRequest(onStopReason) {
  return {
    system: 'system prompt',
    messages: [{ role: 'user', content: '営業時間を教えてください' }],
    model: 'test-model',
    maxTokens: 321,
    timeoutMs: 4_567,
    temperature: 0,
    jsonSchema: { type: 'object', required: ['responseType'] },
    onStopReason,
  };
}

test('normal retrieval は部分一致の上位N件と30項目の telemetry を返す', async () => {
  const ports = createStubFaqPorts({
    entries: SAMPLE_ENTRIES,
    retrieval: 'normal',
    topN: 2,
  });
  const hints = { lexicalTerms: ['営業時間'], semanticQueries: ['料金'] };

  const result = await ports.retrieval.retrieve({
    question: '営業時間 料金',
    hints,
  });

  assert.equal(result.entryCount, 2);
  assert.deepEqual(result.entryIdByRef, new Map([
    ['K1', 'entry-hours'],
    ['K2', 'entry-price'],
  ]));
  assert.deepEqual(result.entryById, new Map([
    ['entry-hours', { topic: '営業時間', canonicalUrl: 'https://example.com/hours' }],
    ['entry-price', { topic: '料金', canonicalUrl: 'https://example.com/price' }],
  ]));
  assert.equal(
    result.block,
    '<knowledge_base>\n' +
      '[K1] 営業時間\n営業時間は午前9時から午後5時までです。\n\n' +
      '[K2] 料金\n基本料金は500円です。\n' +
      '</knowledge_base>'
  );
  assert.deepEqual(Object.keys(result.telemetry).sort(), TELEMETRY_KEYS);
  assert.equal(result.telemetry.corpusRevision, 'stub-corpus-v1');
  assert.equal(result.telemetry.totalEntryCount, 3);
  assert.equal(result.telemetry.candidateCount, 2);
  assert.equal(result.telemetry.chunkCount, 2);
  assert.deepEqual(result.telemetry.selectedTopics, ['営業時間', '料金']);
  assert.deepEqual(result.telemetry.retrievalTrace.metricCandidates, [
    { t: '営業時間', p: '1/1', l: 'l', lex: 1, sem: null, rrf: null, r: null },
    { t: '料金', p: '1/1', l: 'l', lex: 2, sem: null, rrf: null, r: null },
  ]);
  assert.deepEqual(ports.retrieval.calls, [{ question: '営業時間 料金', hints }]);
});

test('empty と slow_empty は全フィールドを持つ空結果を返し、throw は reject する', async () => {
  for (const retrieval of ['empty', 'slow_empty']) {
    const ports = createStubFaqPorts({
      entries: SAMPLE_ENTRIES,
      retrieval,
      retrievalDelayMs: 1,
    });
    const result = await ports.retrieval.retrieve({ question: '営業時間' });

    assert.equal(result.entryCount, 0);
    assert.equal(result.block, '<knowledge_base></knowledge_base>');
    assert.deepEqual(result.entryIdByRef, new Map());
    assert.deepEqual(result.entryById, new Map());
    assert.deepEqual(Object.keys(result.telemetry).sort(), TELEMETRY_KEYS);
    assert.equal(result.telemetry.totalEntryCount, SAMPLE_ENTRIES.length);
  }

  const throwing = createStubFaqPorts({ retrieval: 'throw' });
  await assert.rejects(
    throwing.retrieval.retrieve({ question: '営業時間' }),
    /Stub FAQ retrieval failure/
  );
});

test('generation の envelope/null/max_tokens/invalid_json/slow_null は契約どおりに動く', async (t) => {
  await t.test('envelope は固定JSON・固定token数を返して end_turn を通知する', async () => {
    const envelope = JSON.stringify({
      responseType: 'answer',
      answer: '固定回答',
      clarifyingQuestion: '',
      sourceRefs: ['K1'],
    });
    const reasons = [];
    const request = generationRequest((reason) => reasons.push(reason));
    const ports = createStubFaqPorts({ answerGeneration: 'envelope', envelope });

    const result = await ports.answerGeneration.generate(request);

    assert.deepEqual(result, {
      text: envelope,
      inputTokens: 11,
      outputTokens: 7,
      stopReason: 'end_turn',
    });
    assert.deepEqual(reasons, ['end_turn']);
    assert.equal(ports.defaultModel, 'stub-model');
    assert.equal(ports.answerGeneration.calls.length, 1);
    assert.equal(ports.answerGeneration.calls[0].system, request.system);
    assert.deepEqual(ports.answerGeneration.calls[0].messages, request.messages);
    assert.notStrictEqual(ports.answerGeneration.calls[0].messages, request.messages);
    assert.equal(ports.answerGeneration.calls[0].model, request.model);
    assert.strictEqual(ports.answerGeneration.calls[0].jsonSchema, request.jsonSchema);
  });

  await t.test('null は callback を呼ばず null を返す', async () => {
    const reasons = [];
    const ports = createStubFaqPorts({ answerGeneration: 'null' });

    assert.equal(
      await ports.answerGeneration.generate(generationRequest((reason) => reasons.push(reason))),
      null
    );
    assert.deepEqual(reasons, []);
    assert.equal(ports.answerGeneration.calls.length, 1);
  });

  await t.test('max_tokens は callback を呼んで null を返す', async () => {
    const reasons = [];
    const ports = createStubFaqPorts({ answerGeneration: 'max_tokens' });

    assert.equal(
      await ports.answerGeneration.generate(generationRequest((reason) => reasons.push(reason))),
      null
    );
    assert.deepEqual(reasons, ['max_tokens']);
  });

  await t.test('invalid_json は end_turn の不正 text を返す', async () => {
    const reasons = [];
    const ports = createStubFaqPorts({ answerGeneration: 'invalid_json' });

    const result = await ports.answerGeneration.generate(
      generationRequest((reason) => reasons.push(reason))
    );

    assert.equal(result.text, 'this is not a FAQ envelope');
    assert.equal(result.stopReason, 'end_turn');
    assert.deepEqual(reasons, ['end_turn']);
  });

  await t.test('slow_null は指定時間後に callback なしで null を返す', async () => {
    const reasons = [];
    const ports = createStubFaqPorts({
      answerGeneration: 'slow_null',
      answerGenerationDelayMs: 1,
    });

    assert.equal(
      await ports.answerGeneration.generate(generationRequest((reason) => reasons.push(reason))),
      null
    );
    assert.deepEqual(reasons, []);
  });
});

test('smalltalkGeneration は専用 calls に記録し、answerGeneration と混同しない', async () => {
  const reasons = [];
  const ports = createStubFaqPorts({ smalltalkGeneration: 'max_tokens' });

  assert.equal(
    await ports.smalltalkGeneration.complete(generationRequest((reason) => reasons.push(reason))),
    null
  );
  assert.deepEqual(reasons, ['max_tokens']);
  assert.equal(ports.smalltalkGeneration.calls.length, 1);
  assert.equal(ports.answerGeneration.calls.length, 0);
});

test('storage はSettingsの有無を返し、Q&Aログを呼出元の配列へ記録する', async () => {
  const settings = {
    enabled: true,
    fallbackMessage: '固定応答',
    maxHistoryMessages: 4,
  };
  const qaLogs = [];
  const ports = createStubFaqPorts({ settings, qaLogs });

  const loaded = await ports.storage.loadSettings();
  assert.deepEqual(loaded, settings);
  assert.notStrictEqual(loaded, settings);

  const record = {
    dateBucket: '2026-08-21',
    ts: '2026-08-21T00:00:00.000Z#12345678',
    question: '質問',
    answer: '回答',
    responseType: 'kb_answer',
    route: 'kb_answer',
    scopeFallback: false,
    failureKind: null,
    guardDetail: null,
    sources: ['出典'],
    model: 'stub-model',
    totalMs: 10,
    ttl: 1_800_000_000,
  };
  await ports.storage.putQaLog(record);

  assert.strictEqual(ports.storage.qaLogs, qaLogs);
  assert.deepEqual(qaLogs, [record]);
  assert.notStrictEqual(qaLogs[0], record);
  assert.notStrictEqual(qaLogs[0].sources, record.sources);

  const missing = createStubFaqPorts({ settings: null });
  assert.equal(await missing.storage.loadSettings(), null);
});

// ---- PR#125 レビュー対応: オブジェクト形シナリオと fallback 模擬の stub 契約 ----

test('オブジェクト形シナリオは production の stop_reason 契約を写す', async (t) => {
  const request = (overrides = {}) => ({
    system: 's',
    messages: [{ role: 'user', content: 'q' }],
    model: 'm',
    maxTokens: 10,
    ...overrides,
  });

  await t.test('{stopReason: end_turn, text: ""} は通知後に null（本文空）', async () => {
    const reasons = [];
    const ports = createStubFaqPorts({ answerGeneration: { stopReason: 'end_turn', text: '' } });
    const result = await ports.answerGeneration.generate(request({ onStopReason: (r) => reasons.push(r) }));
    assert.equal(result, null);
    assert.deepEqual(reasons, ['end_turn']);
  });

  await t.test('{stopReason: null} は onStopReason を呼ばず null（API 障害相当）', async () => {
    const reasons = [];
    const ports = createStubFaqPorts({ answerGeneration: { stopReason: null } });
    const result = await ports.answerGeneration.generate(request({ onStopReason: (r) => reasons.push(r) }));
    assert.equal(result, null);
    assert.deepEqual(reasons, []);
  });

  await t.test('{stopReason: refusal} は通知後に null', async () => {
    const reasons = [];
    const ports = createStubFaqPorts({ answerGeneration: { stopReason: 'refusal' } });
    const result = await ports.answerGeneration.generate(request({ onStopReason: (r) => reasons.push(r) }));
    assert.equal(result, null);
    assert.deepEqual(reasons, ['refusal']);
  });

  await t.test('simulateStructuredOutputFallback は jsonSchema 付きの呼出でだけ発火し、callback の例外は握り潰す', async () => {
    let fired = 0;
    const ports = createStubFaqPorts({ answerGeneration: 'envelope', simulateStructuredOutputFallback: true });
    await ports.answerGeneration.generate(request({ onStructuredOutputFallback: () => { fired += 1; } }));
    assert.equal(fired, 0);
    const result = await ports.answerGeneration.generate(
      request({
        jsonSchema: { type: 'object' },
        onStructuredOutputFallback: () => {
          fired += 1;
          throw new Error('observer failure must not leak');
        },
      })
    );
    assert.equal(fired, 1);
    assert.equal(result?.stopReason, 'end_turn');
  });
});
