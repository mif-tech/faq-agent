#!/usr/bin/env node
/** Free FAQ character bigram retrieval contract tests / . */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAMBDA_ROOT = path.join(HERE, '..');
const FREE_ROOT = path.join(LAMBDA_ROOT, 'functions', 'faq-chat', 'adapters', 'free');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faq-free-retrieval-test-'));
const outfile = path.join(outDir, 'simple-retrieval.mjs');

process.on('exit', () => fs.rmSync(outDir, { recursive: true, force: true }));

await build({
  entryPoints: [path.join(FREE_ROOT, 'simple-retrieval.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile,
  logLevel: 'silent',
});

const { createSimpleRetrievalPort } = await import(pathToFileURL(outfile).href);
const SAMPLE_KB = JSON.parse(
  fs.readFileSync(path.join(LAMBDA_ROOT, 'eval', 'faq-chat', 'sample-kb.json'), 'utf8')
);

function jsonRows(block) {
  const lines = block.split('\n');
  assert.equal(lines[0], '<knowledge_base>');
  assert.equal(lines.at(-1), '</knowledge_base>');
  return lines.slice(1, -1).filter(Boolean).map((line) => JSON.parse(line));
}

test('日本語 bigram 検索は sample KB の営業時間を先頭へ置き、簡素 block と出典索引を返す', async () => {
  const port = createSimpleRetrievalPort({
    loadEntries: async () => SAMPLE_KB,
    topK: 3,
  });

  const result = await port.retrieve({
    question: '営業時間は何時から何時までですか',
    hints: { lexicalTerms: ['無視される語'], semanticQueries: ['無視される意味検索'] },
  });
  const rows = jsonRows(result.block);

  assert.ok(result.entryCount >= 1);
  assert.equal(result.entryIdByRef.get('K1'), 'sample-kb-hours');
  assert.deepEqual(result.entryById.get('sample-kb-hours'), {
    topic: '営業時間',
    canonicalUrl: 'https://example.com/hours',
  });
  assert.deepEqual(rows[0], {
    ref: 'K1',
    topic: '営業時間',
    content:
      'サンプル株式会社の営業時間は平日の午前9時から午後6時までです。土曜日、日曜日、祝日は休業します。',
  });
  assert.doesNotMatch(result.block, /<knowledge_base_index>/);
  assert.match(result.telemetry.corpusRevision, /^[0-9a-f]{16}$/);
  assert.equal(result.telemetry.retrieverAlgorithmRevision, 'free-bigram-v1');
  assert.equal(result.telemetry.lexRankMode, 'lexical');
  assert.equal(result.telemetry.semanticUsed, false);
  assert.equal(result.telemetry.planUsed, false);
  assert.equal(result.telemetry.queryPlanRevision, null);
  assert.equal(result.telemetry.totalEntryCount, SAMPLE_KB.length);
  assert.equal(result.telemetry.selectedTopics[0], '営業時間');
});

test('自然な丁寧表現を含む無関係な質問もスコア0として候補を返さない', async () => {
  const port = createSimpleRetrievalPort({ loadEntries: async () => SAMPLE_KB });

  const [first, second] = await Promise.all([
    port.retrieve({ question: '量子暗号について教えてください' }),
    port.retrieve({ question: '宇宙旅行について知りたいです' }),
  ]);

  for (const result of [first, second]) {
    assert.equal(result.entryCount, 0);
    assert.deepEqual(result.entryIdByRef, new Map());
    assert.deepEqual(result.entryById, new Map());
    assert.deepEqual(jsonRows(result.block), []);
    assert.equal(result.telemetry.candidateCount, 0);
  }
});

test('NFKC・小文字化とASCII単語tokenで1文字の英数字も検索できる', async () => {
  const port = createSimpleRetrievalPort({
    loadEntries: async () => [
      { id: 'entry-plan-x', topic: 'Plan X', content: 'Plan X is available.' },
      { id: 'entry-plan-y', topic: 'Plan Y', content: 'Plan Y is available.' },
    ],
  });

  const result = await port.retrieve({ question: 'ｘ' });

  assert.equal(result.entryIdByRef.get('K1'), 'entry-plan-x');
  assert.equal(result.entryCount, 1);
});

test('JSON 行の content は maxCharsPerEntry で切り詰める', async () => {
  const port = createSimpleRetrievalPort({
    loadEntries: async () => [
      { id: 'entry-short', topic: '短縮確認', content: '1234567890' },
    ],
    maxCharsPerEntry: 5,
  });

  const result = await port.retrieve({ question: '短縮確認' });

  assert.deepEqual(jsonRows(result.block), [
    { ref: 'K1', topic: '短縮確認', content: '12345' },
  ]);
});

test('corpusRevision は全エントリの内容に依存する', async () => {
  const changed = SAMPLE_KB.map((entry, index) =>
    index === SAMPLE_KB.length - 1
      ? { ...entry, content: `${entry.content} 改訂` }
      : { ...entry }
  );
  const originalPort = createSimpleRetrievalPort({ loadEntries: async () => SAMPLE_KB });
  const changedPort = createSimpleRetrievalPort({ loadEntries: async () => changed });

  const [original, revised] = await Promise.all([
    originalPort.retrieve({ question: '営業時間' }),
    changedPort.retrieve({ question: '営業時間' }),
  ]);

  assert.notEqual(original.telemetry.corpusRevision, revised.telemetry.corpusRevision);
});

test('ロード済み corpus は cacheTtlMs 内で再利用する', async () => {
  let loadCount = 0;
  const port = createSimpleRetrievalPort({
    loadEntries: async () => {
      loadCount += 1;
      return SAMPLE_KB;
    },
    cacheTtlMs: 60_000,
  });

  await port.retrieve({ question: '営業時間' });
  await port.retrieve({ question: '返品' });

  assert.equal(loadCount, 1);
});

test('corpus cacheはkbAgentIdごとに分離し、default loaderだけ引数を省略する', async () => {
  const loadCalls = [];
  const port = createSimpleRetrievalPort({
    loadEntries: async (...args) => {
      loadCalls.push(args);
      const kbAgentId = args[0];
      return [
        {
          id: kbAgentId ?? 'default-entry',
          topic: '営業時間',
          content: `${kbAgentId ?? 'default'} の営業時間です。`,
        },
      ];
    },
    cacheTtlMs: 60_000,
  });

  const defaultFirst = await port.retrieve({ question: '営業時間' });
  const salesFirst = await port.retrieve({ question: '営業時間', kbAgentId: 'sales' });
  const supportFirst = await port.retrieve({ question: '営業時間', kbAgentId: 'support' });
  const salesCached = await port.retrieve({ question: '営業時間', kbAgentId: 'sales' });
  const defaultCached = await port.retrieve({ question: '営業時間' });

  assert.equal(defaultFirst.entryIdByRef.get('K1'), 'default-entry');
  assert.equal(defaultCached.entryIdByRef.get('K1'), 'default-entry');
  assert.equal(salesFirst.entryIdByRef.get('K1'), 'sales');
  assert.equal(salesCached.entryIdByRef.get('K1'), 'sales');
  assert.equal(supportFirst.entryIdByRef.get('K1'), 'support');
  assert.deepEqual(loadCalls, [[], ['sales'], ['support']]);
});

test('corpus cacheはLRU上限を守り、直近で参照したagentを保持する', async () => {
  const loadCalls = [];
  const port = createSimpleRetrievalPort({
    loadEntries: async (...args) => {
      loadCalls.push(args);
      const kbAgentId = args[0];
      return [
        {
          id: kbAgentId ?? 'default-entry',
          topic: '営業時間',
          content: `${kbAgentId ?? 'default'} の営業時間です。`,
        },
      ];
    },
    cacheTtlMs: 60_000,
    cacheMaxEntries: 2,
  });

  await port.retrieve({ question: '営業時間' });
  await port.retrieve({ question: '営業時間', kbAgentId: 'sales' });
  await port.retrieve({ question: '営業時間' });
  await port.retrieve({ question: '営業時間', kbAgentId: 'support' });
  await port.retrieve({ question: '営業時間' });
  await port.retrieve({ question: '営業時間', kbAgentId: 'sales' });

  assert.deepEqual(loadCalls, [[], ['sales'], ['support'], ['sales']]);
});

// ---- レビュー対応: メトリクス用トレースの上限と topic 無害化（production と同規則） ----

test('metricCandidates は上位20件に截断され、topic は制御文字/"<"除去＋30コードポイントに截断される', async () => {
  const longTopic = 'あ'.repeat(40) + '<script>';
  const entries = Array.from({ length: 30 }, (_, i) => ({
    id: `e${i}`,
    topic: i === 0 ? longTopic : `営業時間 ${i}`,
    content: `営業時間の案内 ${i}`,
  }));
  const port = createSimpleRetrievalPort({ loadEntries: async () => entries, topK: 3 });
  const result = await port.retrieve({ question: '営業時間を教えてください' });

  assert.ok(result.telemetry.retrievalTrace.metricCandidates.length <= 20);
  for (const candidate of result.telemetry.retrievalTrace.metricCandidates) {
    assert.ok(Array.from(candidate.t).length <= 30, `topic too long: ${candidate.t}`);
    assert.doesNotMatch(candidate.t, /[<]/);
  }
  for (const topic of result.telemetry.selectedTopics) {
    assert.ok(Array.from(topic).length <= 30);
  }
  for (const label of result.telemetry.selectedChunkLabels) {
    assert.ok(Array.from(label.replace(/#1\/1$/, '')).length <= 30);
  }
});

test('topK が trace 上限を超えても選択済みエントリはすべて metricCandidates に載る', async () => {
  const entries = Array.from({ length: 30 }, (_, i) => ({
    id: `e${i}`,
    topic: `営業時間 ${i}`,
    content: `営業時間の案内 ${i}`,
  }));
  const port = createSimpleRetrievalPort({ loadEntries: async () => entries, topK: 25 });
  const result = await port.retrieve({ question: '営業時間を教えてください' });
  const trace = result.telemetry.retrievalTrace.metricCandidates;
  assert.equal(result.entryCount, 25);
  assert.ok(trace.length >= 25);
  assert.equal(trace.slice(0, 25).every((c) => c.r === null), true, 'selected rows must not be marked entry_cap');
});
