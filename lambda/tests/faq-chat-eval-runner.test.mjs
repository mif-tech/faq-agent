#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAMBDA_ROOT = path.resolve(HERE, '..');
const RUNNER = path.join(LAMBDA_ROOT, 'eval', 'faq-chat', 'run-eval.mjs');
const SAMPLE_SET = path.join(LAMBDA_ROOT, 'eval', 'faq-chat', 'sample-set.jsonl');
const SAMPLE_EPISODES = path.join(
  LAMBDA_ROOT,
  'eval',
  'faq-chat',
  'sample-episodes.jsonl'
);
const RECORDING = path.join(HERE, 'fixtures', 'faq-eval-recording.jsonl');

const tempRoot = path.resolve(os.tmpdir());
const tempDir = fs.mkdtempSync(path.join(tempRoot, 'faq-eval-runner-test-'));

after(() => {
  assert.equal(
    path.dirname(path.resolve(tempDir)),
    tempRoot,
    'refusing to remove an unexpected test directory'
  );
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function childEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'FAQ_EVAL_API_URL') delete env[key];
  }
  return env;
}

function runEval(args) {
  return spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: LAMBDA_ROOT,
    env: childEnvironment(),
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 20 * 1024 * 1024,
  });
}

function diagnostics(result) {
  const tail = (value) => String(value ?? '').slice(-4_000);
  return [
    `status=${result.status} signal=${result.signal}`,
    result.error ? `error=${result.error.stack || result.error}` : '',
    `stdout (tail):\n${tail(result.stdout)}`,
    `stderr (tail):\n${tail(result.stderr)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function readResult(file) {
  assert.equal(fs.existsSync(file), true, `runner did not write ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function aggregateProjection(result) {
  return {
    runs: result.runs,
    fixtureHash: result.fixtureHash,
    scoringVersion: result.scoringVersion,
    summary: result.summary,
    confusion: result.confusion,
    counts: {
      flipRate: result.flipRate,
      errorRate: result.errorRate,
      technicalRate: result.technicalRate,
      technicalCallRate: result.technicalCallRate,
      technicalTrials: result.technicalTrials,
      technicalAttemptsTotal: result.technicalAttemptsTotal,
      totalCalls: result.totalCalls,
      invalidTrials: result.invalidTrials,
      totalTrials: result.totalTrials,
      overAnswerIds: result.overAnswerIds,
      unevaluableIds: result.unevaluableIds,
      pendingEpisodeIds: result.pendingEpisodeIds,
    },
    resultAggregates: result.results.map(({ question: _question, trials: _trials, ...row }) => row),
    episodeSchemaVersion: result.episodeSchemaVersion,
    episodeFixtureHash: result.episodeFixtureHash,
    episodeMetrics: result.episodeMetrics,
    episodeAggregates: result.episodes.map(({ trajectories: _trajectories, ...episode }) => episode),
  };
}

test('mock and recorded modes complete the full sample evaluation with identical aggregates', () => {
  const mockOut = path.join(tempDir, 'mock.json');
  const mockRun = runEval(['--mode', 'mock', '--runs', '1', '--out', mockOut]);

  assert.equal(mockRun.status, 0, diagnostics(mockRun));
  const mockResult = readResult(mockOut);
  assert.equal(mockResult.mode, 'mock');
  assert.equal(mockResult.results.length, 10);
  assert.equal(mockResult.totalTrials, 10);
  assert.equal(mockResult.episodes.length, 2);

  assert.equal(fs.existsSync(RECORDING), true, 'recording fixture is missing');
  const recordedOut = path.join(tempDir, 'recorded.json');
  const recordedRun = runEval([
    '--mode',
    'recorded',
    '--recording',
    RECORDING,
    '--set',
    SAMPLE_SET,
    '--episodes',
    SAMPLE_EPISODES,
    '--runs',
    '1',
    '--out',
    recordedOut,
  ]);

  assert.equal(recordedRun.status, 0, diagnostics(recordedRun));
  const recordedResult = readResult(recordedOut);
  assert.equal(recordedResult.mode, 'recorded');
  assert.equal(recordedResult.results.length, 10);
  assert.equal(recordedResult.episodes.length, 2);
  assert.deepEqual(aggregateProjection(recordedResult), aggregateProjection(mockResult));
});

test('mock mode rejects --api before writing an output file', () => {
  const outFile = path.join(tempDir, 'invalid-mock-api.json');
  const result = runEval([
    '--mode',
    'mock',
    '--api',
    'http://x',
    '--runs',
    '1',
    '--out',
    outFile,
  ]);

  assert.equal(result.status, 2, diagnostics(result));
  assert.match(`${result.stdout}\n${result.stderr}`, /--api/u);
  assert.equal(fs.existsSync(outFile), false);
});

// ---- PR#123 レビュー対応: baseline の mode 不一致 / 録画と fixture の照合 / turn 単位の再生 ----

test('--baseline は mode 不一致（mock ベースライン vs recorded 実行）で exit 2', () => {
  const mockOut = path.join(tempDir, 'baseline-mock.json');
  const mockRun = runEval(['--mode', 'mock', '--runs', '1', '--out', mockOut]);
  assert.equal(mockRun.status, 0, diagnostics(mockRun));

  const outFile = path.join(tempDir, 'baseline-mismatch.json');
  const result = runEval([
    '--mode', 'recorded', '--recording', RECORDING, '--set', SAMPLE_SET, '--episodes', SAMPLE_EPISODES,
    '--runs', '1', '--baseline', mockOut, '--out', outFile,
  ]);
  assert.equal(result.status, 2, diagnostics(result));
  assert.match(`${result.stdout}\n${result.stderr}`, /mode が不一致/u);
  assert.equal(fs.existsSync(outFile), false);
});

test('recorded は録画 header の fixtureHash が現在のセットと一致しなければ exit 2', () => {
  // 録画時と異なる質問セットで再生すると止まる。既定セット（regression-set）は canonical 限定で
  // 公開ツリーに存在しないため、ここでは sample-set を改変した一時セットを明示的に渡す
  const alteredSet = path.join(tempDir, 'altered-set.jsonl');
  const rows = fs.readFileSync(SAMPLE_SET, 'utf8').split('\n').filter(Boolean);
  const first = JSON.parse(rows[0]);
  first.question = `${first.question}（改変）`;
  fs.writeFileSync(alteredSet, [JSON.stringify(first), ...rows.slice(1)].join('\n') + '\n', 'utf8');

  const outFile = path.join(tempDir, 'fixture-mismatch.json');
  const result = runEval([
    '--mode', 'recorded', '--recording', RECORDING, '--set', alteredSet,
    '--episodes', SAMPLE_EPISODES, '--runs', '1', '--out', outFile,
  ]);
  assert.equal(result.status, 2, diagnostics(result));
  assert.match(`${result.stdout}\n${result.stderr}`, /fixtureHash が不一致/u);
  assert.equal(fs.existsSync(outFile), false);
});

test('recorded は (id, trial, turn) で再生し、欠落ターンはリトライせず無効試行になる', () => {
  // fixture からエピソード 1 本の 2 ターン目以降を落とす → 1 ターン目は再生され、2 ターン目は recording_missing
  const rows = fs.readFileSync(RECORDING, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const episodeId = rows.find((r) => !r.header && r.turn >= 2)?.id;
  assert.ok(episodeId, 'fixture must contain a multi-turn episode');
  const pruned = rows.filter((r) => r.header || r.id !== episodeId || r.turn === 1);
  const prunedFile = path.join(tempDir, 'pruned-recording.jsonl');
  fs.writeFileSync(prunedFile, `${pruned.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');

  const outFile = path.join(tempDir, 'pruned.json');
  const started = Date.now();
  const result = runEval([
    '--mode', 'recorded', '--recording', prunedFile, '--set', SAMPLE_SET, '--episodes', SAMPLE_EPISODES,
    '--runs', '1', '--out', outFile,
  ]);
  const elapsed = Date.now() - started;
  const output = readResult(outFile);
  const episode = output.episodes.find((e) => e.id === episodeId);
  assert.ok(episode, diagnostics(result));
  const turns = episode.trajectories[0].turns;
  assert.equal(turns[0].actual !== 'invalid', true, '1 ターン目は録画から再生される');
  assert.equal(turns[1].actual, 'invalid', '2 ターン目は録画欠落で無効試行');
  assert.equal(turns[1].attemptsUsed, 1, 'recording_missing はリトライしない');
  // オフライン transport ではペーシング/バックオフが効かない（800ms × ターン × 試行が乗らない）
  assert.ok(elapsed < 60_000, `offline replay should not pace: ${elapsed}ms`);
});

// ---- PR#129 レビュー対応 ----

test('recorded の出力は録画元 mode を recordingMode として持ち、--record は非空ファイルを拒否する', () => {
  const outFile = path.join(tempDir, 'recording-mode.json');
  const result = runEval([
    '--mode', 'recorded', '--recording', RECORDING, '--set', SAMPLE_SET, '--episodes', SAMPLE_EPISODES,
    '--runs', '1', '--out', outFile,
  ]);
  assert.equal(result.status, 0, diagnostics(result));
  assert.equal(readResult(outFile).recordingMode, 'mock');

  // 非空ファイルへの --record は「先頭行が header」の不変条件を壊すので拒否
  const existing = path.join(tempDir, 'existing-recording.jsonl');
  fs.writeFileSync(existing, '{"not":"empty"}\n');
  const refused = runEval(['--mode', 'mock', '--runs', '1', '--record', existing, '--out', path.join(tempDir, 'x.json')]);
  assert.equal(refused.status, 2, diagnostics(refused));
  assert.match(`${refused.stdout}\n${refused.stderr}`, /空ではありません/u);
});

test('mock transport は Lambda context（時間予算 30s）を handler に渡す', () => {
  // 引数名の衝突で {id, trial} が context として渡ると model_timeout_ms が null になる（PR#129 レビュー指摘）
  const outFile = path.join(tempDir, 'mock-context.json');
  const result = runEval(['--mode', 'mock', '--runs', '1', '--ids', 'sample-q-001-hours', '--out', outFile]);
  assert.equal(result.status, 0, diagnostics(result));
  const metricLines = `${result.stdout}`.split('\n').filter((l) => l.includes('"metric":"faq_chat"'));
  assert.ok(metricLines.length > 0, 'handler metric log must be captured');
  const metric = JSON.parse(metricLines.at(-1).slice(metricLines.at(-1).indexOf('{')));
  assert.equal(typeof metric.model_timeout_ms, 'number');
  assert.ok(metric.model_timeout_ms > 0 && metric.model_timeout_ms <= 20_000);
});

test('--record は header 1 行だけの残骸なら上書きでき、baseline に recordingMode が無ければ recorded 比較は exit 2', () => {
  const leftover = path.join(tempDir, 'leftover-recording.jsonl');
  fs.writeFileSync(leftover, '{"header":true,"mode":"mock","fixtureHash":"x","episodeFixtureHash":"y"}\n');
  const rerun = runEval(['--mode', 'mock', '--runs', '1', '--ids', 'sample-q-001-hours', '--record', leftover, '--out', path.join(tempDir, 'leftover.json')]);
  assert.equal(rerun.status, 0, diagnostics(rerun));
  const lines = fs.readFileSync(leftover, 'utf8').split('\n').filter(Boolean);
  assert.equal(JSON.parse(lines[0]).header, true);
  assert.ok(lines.length >= 2, 'rows are appended after the fresh header');

  const legacyBaseline = path.join(tempDir, 'legacy-baseline.json');
  const recordedOut = path.join(tempDir, 'recorded-for-baseline.json');
  const first = runEval(['--mode', 'recorded', '--recording', RECORDING, '--set', SAMPLE_SET, '--episodes', SAMPLE_EPISODES, '--runs', '1', '--out', recordedOut]);
  assert.equal(first.status, 0, diagnostics(first));
  const legacy = readResult(recordedOut);
  delete legacy.recordingMode;
  fs.writeFileSync(legacyBaseline, JSON.stringify(legacy));
  const compared = runEval(['--mode', 'recorded', '--recording', RECORDING, '--set', SAMPLE_SET, '--episodes', SAMPLE_EPISODES, '--runs', '1', '--baseline', legacyBaseline, '--out', path.join(tempDir, 'compared.json')]);
  assert.equal(compared.status, 2, diagnostics(compared));
  assert.match(`${compared.stdout}\n${compared.stderr}`, /recordingMode が不一致/u);
});
