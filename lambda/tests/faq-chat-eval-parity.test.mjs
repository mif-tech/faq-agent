#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAMBDA_ROOT = path.resolve(HERE, '..');
const EVAL_ROOT = path.join(LAMBDA_ROOT, 'eval', 'faq-chat');
const COMPARATOR = path.join(EVAL_ROOT, 'compare-parity.mjs');
const SAMPLE_SET = path.join(EVAL_ROOT, 'sample-set.jsonl');
const SAMPLE_EPISODES = path.join(EVAL_ROOT, 'sample-episodes.jsonl');
const tempParent = path.resolve(os.tmpdir());
const tempDir = fs.mkdtempSync(path.join(tempParent, 'faq-eval-parity-test-'));

function readFixture(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, '');
  return {
    hash: crypto
      .createHash('sha256')
      .update(raw.replace(/\r\n/g, '\n'))
      .digest('hex')
      .slice(0, 16),
    rows: raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
}

const PUBLIC_QUESTIONS = readFixture(SAMPLE_SET);
const PUBLIC_EPISODES = readFixture(SAMPLE_EPISODES);
const QUESTION_ONE = PUBLIC_QUESTIONS.rows[0].id;
const QUESTION_TWO = PUBLIC_QUESTIONS.rows[1].id;
const EPISODE_ONE = PUBLIC_EPISODES.rows[0].id;

after(() => {
  assert.equal(path.dirname(path.resolve(tempDir)), tempParent);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function trial(responseType, overrides = {}) {
  return {
    responseType,
    invalid: false,
    failureKind: null,
    answer: 'SENSITIVE_ANSWER_BODY',
    ...overrides,
  };
}

function question(id, responseTypes) {
  return {
    id,
    question: `SENSITIVE_QUESTION_BODY_${id}`,
    n: responseTypes.length,
    trials: responseTypes.map((responseType) => trial(responseType)),
  };
}

function episode(id, trajectoryRoutes) {
  return {
    id,
    n: trajectoryRoutes.length,
    trajectories: trajectoryRoutes.map((routes) => ({
      state: 'success',
      turns: routes.map((actual, index) => ({
        turn: index + 1,
        user: `SENSITIVE_EPISODE_USER_BODY_${id}_${index + 1}`,
        actual,
        answer: `SENSITIVE_EPISODE_ANSWER_BODY_${id}_${index + 1}`,
      })),
    })),
  };
}

function syntheticResult() {
  const routeActual = {
    answer: 'kb_answer',
    refuse: 'refuse',
    chat: 'chat',
    scope_fallback: 'scope_fallback',
  };
  return {
    mode: 'api',
    runs: 3,
    fixtureHash: PUBLIC_QUESTIONS.hash,
    episodeFixtureHash: PUBLIC_EPISODES.hash,
    scoringVersion: 3,
    results: PUBLIC_QUESTIONS.rows.map((row) => {
      const responseType = row.expected === 'refuse' ? 'refuse' : 'kb_answer';
      return question(row.id, [responseType, responseType, responseType]);
    }),
    episodes: PUBLIC_EPISODES.rows.map((row) => {
      const routes = row.turns.map((turn) => routeActual[turn.expected.route]);
      return episode(row.id, [routes, routes, routes]);
    }),
  };
}

function diagnostics(result) {
  return [
    `status=${result.status} signal=${result.signal}`,
    result.error ? `error=${result.error.stack || result.error}` : '',
    `stdout:\n${String(result.stdout ?? '')}`,
    `stderr:\n${String(result.stderr ?? '')}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function runComparator(baseline, candidate) {
  const caseDir = fs.mkdtempSync(path.join(tempDir, 'case-'));
  const baselineFile = path.join(caseDir, 'baseline.json');
  const candidateFile = path.join(caseDir, 'candidate.json');
  fs.writeFileSync(baselineFile, JSON.stringify(baseline));
  fs.writeFileSync(candidateFile, JSON.stringify(candidate));
  return spawnSync(
    process.execPath,
    [COMPARATOR, '--baseline', baselineFile, '--candidate', candidateFile],
    {
      cwd: LAMBDA_ROOT,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    }
  );
}

function outputOf(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

function failurePattern(id, kind) {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`${escapedId}\\s+${kind}`, 'u');
}

test('strict majority parity passes despite trial-level variation', () => {
  const baseline = syntheticResult();
  const candidate = structuredClone(baseline);
  candidate.results[0].trials = [trial('kb_answer'), trial('chat'), trial('kb_answer')];
  candidate.episodes[0].trajectories[2].turns[0].actual = 'refuse';

  const result = runComparator(baseline, candidate);

  assert.equal(result.status, 0, diagnostics(result));
  assert.match(result.stdout, /parity: pass questions=10 episodes=2 episode_turns=4/u);
});

test('responseType majority mismatch fails with the question ID and kind', () => {
  const baseline = syntheticResult();
  const candidate = structuredClone(baseline);
  candidate.results[0].trials = [trial('refuse'), trial('refuse'), trial('kb_answer')];

  const result = runComparator(baseline, candidate);

  assert.equal(result.status, 1, diagnostics(result));
  assert.match(outputOf(result), failurePattern(QUESTION_ONE, 'response_type_mismatch'));
});

test('scope_fallback refusals do not collapse into plain refuse on the question side', () => {
  // 質問側の多数決も classifyActual 派生クラスで取る（レビュー指摘）。
  // production=素の refuse vs remote=refuse+scopeFallback は案内型非回答への挙動差であり
  // parity fail にする（episode 側・scoring.mjs の passOf 4象限と対称）
  const baseline = syntheticResult();
  const candidate = structuredClone(baseline);
  const refuseIndex = baseline.results.findIndex(
    (row) => row.trials[0].responseType === 'refuse'
  );
  assert.notEqual(refuseIndex, -1, 'fixture must contain a refuse-majority question');
  candidate.results[refuseIndex].trials = [
    trial('refuse', { scopeFallback: true }),
    trial('refuse', { scopeFallback: true }),
    trial('refuse', { scopeFallback: true }),
  ];

  const result = runComparator(baseline, candidate);

  assert.equal(result.status, 1, diagnostics(result));
  assert.match(
    outputOf(result),
    failurePattern(baseline.results[refuseIndex].id, 'response_type_mismatch')
  );
});

test('infrastructure failures exit 2 instead of masquerading as parity regressions', () => {
  // exit 1 = parity 退行 / exit 2 = 評価基盤エラー（run-eval.mjs の契約に整合。
  // レビュー指摘・3: パス打ち間違い・同一ファイル二重指定は gate シグナルにしない）
  const baseline = syntheticResult();
  const caseDir = fs.mkdtempSync(path.join(tempDir, 'case-'));
  const baselineFile = path.join(caseDir, 'baseline.json');
  fs.writeFileSync(baselineFile, JSON.stringify(baseline));

  const missing = spawnSync(
    process.execPath,
    [COMPARATOR, '--baseline', baselineFile, '--candidate', path.join(caseDir, 'absent.json')],
    { cwd: LAMBDA_ROOT, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 }
  );
  assert.equal(missing.status, 2, diagnostics(missing));
  assert.match(outputOf(missing), /candidate\s+invalid_input/u);

  const identical = spawnSync(
    process.execPath,
    [COMPARATOR, '--baseline', baselineFile, '--candidate', baselineFile],
    { cwd: LAMBDA_ROOT, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 }
  );
  assert.equal(identical.status, 2, diagnostics(identical));
  assert.match(outputOf(identical), /global\s+identical_input_paths/u);
});

test('episode turn route majority mismatch fails with the episode turn ID and kind', () => {
  const baseline = syntheticResult();
  const candidate = structuredClone(baseline);
  for (const trajectory of candidate.episodes[0].trajectories) {
    trajectory.turns[1].actual = 'chat';
  }

  const result = runComparator(baseline, candidate);

  assert.equal(result.status, 1, diagnostics(result));
  assert.match(outputOf(result), failurePattern(`${EPISODE_ONE}#turn-2`, 'route_mismatch'));
});

test('fixture hashes, scoring version, and runs must match before result comparison', async (t) => {
  const cases = [
    ['fixtureHash', 'changed-set-hash', 'set_fixture_hash_mismatch'],
    ['episodeFixtureHash', 'changed-episode-hash', 'episode_fixture_hash_mismatch'],
    ['scoringVersion', 4, 'scoring_version_mismatch'],
    ['runs', 5, 'runs_mismatch'],
  ];

  for (const [field, value, kind] of cases) {
    await t.test(field, () => {
      const baseline = syntheticResult();
      const candidate = structuredClone(baseline);
      candidate[field] = value;

      const result = runComparator(baseline, candidate);

      // メタデータ不一致は実行手順ミス = 基盤エラー(exit 2)。parity退行(exit 1)と区別する
      assert.equal(result.status, 2, diagnostics(result));
      assert.match(outputOf(result), new RegExp(`global\\s+${kind}`, 'u'));
    });
  }
});

test('both inputs must come from api mode', () => {
  const baseline = syntheticResult();
  const candidate = structuredClone(baseline);
  candidate.mode = 'mock';

  const result = runComparator(baseline, candidate);

  assert.equal(result.status, 2, diagnostics(result));
  assert.match(outputOf(result), /candidate\s+invalid_mode/u);
});

test('matching foreign fixture hashes do not bypass the public fixture contract', () => {
  const baseline = syntheticResult();
  const candidate = structuredClone(baseline);
  baseline.fixtureHash = 'foreign-set-hash';
  candidate.fixtureHash = 'foreign-set-hash';

  const result = runComparator(baseline, candidate);

  assert.equal(result.status, 2, diagnostics(result));
  assert.match(outputOf(result), /baseline\s+unexpected_set_fixture_hash/u);
  assert.match(outputOf(result), /candidate\s+unexpected_set_fixture_hash/u);
});

test('the public parity gate rejects matching one-shot results', () => {
  const baseline = syntheticResult();
  const candidate = structuredClone(baseline);
  baseline.runs = 1;
  candidate.runs = 1;

  const result = runComparator(baseline, candidate);

  assert.equal(result.status, 2, diagnostics(result));
  assert.match(outputOf(result), /baseline\s+unexpected_runs/u);
  assert.match(outputOf(result), /candidate\s+unexpected_runs/u);
});

test('a strict responseType majority is required on both sides', () => {
  const baseline = syntheticResult();
  const candidate = structuredClone(baseline);
  candidate.results[0].trials = [trial('kb_answer'), trial('refuse'), trial('chat')];

  const result = runComparator(baseline, candidate);

  assert.equal(result.status, 1, diagnostics(result));
  assert.match(
    outputOf(result),
    failurePattern(QUESTION_ONE, 'candidate_no_response_type_majority')
  );
});

test('a strict route majority is required for every episode turn', () => {
  const baseline = syntheticResult();
  const candidate = structuredClone(baseline);
  candidate.episodes[0].trajectories[0].turns[0].actual = 'kb_answer';
  candidate.episodes[0].trajectories[1].turns[0].actual = 'refuse';
  candidate.episodes[0].trajectories[2].turns[0].actual = 'chat';

  const result = runComparator(baseline, candidate);

  assert.equal(result.status, 1, diagnostics(result));
  assert.match(
    outputOf(result),
    failurePattern(`${EPISODE_ONE}#turn-1`, 'candidate_no_route_majority')
  );
});

test('missing and extra questions fail the exact ID-set comparison', () => {
  const baseline = syntheticResult();
  const candidate = structuredClone(baseline);
  candidate.results = candidate.results.filter((row) => row.id !== QUESTION_TWO);
  candidate.results.push(question('sample-q-extra', ['chat', 'chat', 'refuse']));

  const result = runComparator(baseline, candidate);
  const output = outputOf(result);

  assert.equal(result.status, 1, diagnostics(result));
  assert.match(output, failurePattern(QUESTION_TWO, 'candidate_missing_question'));
  assert.match(output, failurePattern('sample-q-extra', 'candidate_extra_question'));
});

test('matching subsets still fail the complete public fixture contract', () => {
  const baseline = syntheticResult();
  baseline.results = baseline.results.slice(0, 1);
  baseline.episodes = baseline.episodes.slice(0, 1);
  const candidate = structuredClone(baseline);

  const result = runComparator(baseline, candidate);
  const output = outputOf(result);

  assert.equal(result.status, 1, diagnostics(result));
  assert.match(output, failurePattern(QUESTION_TWO, 'baseline_missing_question'));
  assert.match(output, failurePattern(QUESTION_TWO, 'candidate_missing_question'));
  assert.match(
    output,
    failurePattern(PUBLIC_EPISODES.rows[1].id, 'baseline_missing_episode')
  );
});

test('a trailing episode turn omitted by both sides fails the public turn contract', () => {
  const baseline = syntheticResult();
  const candidate = structuredClone(baseline);
  for (const result of [baseline, candidate]) {
    for (const trajectory of result.episodes[0].trajectories) trajectory.turns.pop();
  }

  const result = runComparator(baseline, candidate);
  const output = outputOf(result);

  assert.equal(result.status, 1, diagnostics(result));
  assert.match(
    output,
    failurePattern(`${EPISODE_ONE}#turn-2`, 'baseline_missing_episode_turn')
  );
  assert.match(
    output,
    failurePattern(`${EPISODE_ONE}#turn-2`, 'candidate_missing_episode_turn')
  );
});

test('technical and invalid trials fail instead of joining a majority', () => {
  const baseline = syntheticResult();
  const candidate = structuredClone(baseline);
  candidate.results[0].trials[0] = trial('refuse', { failureKind: 'model_timeout' });
  candidate.results[1].trials[0] = trial(null, { invalid: true });
  candidate.episodes[0].trajectories[0].turns[0].actual = 'technical';

  const result = runComparator(baseline, candidate);
  const output = outputOf(result);

  assert.equal(result.status, 1, diagnostics(result));
  assert.match(output, failurePattern(QUESTION_ONE, 'candidate_technical_trial'));
  assert.match(output, failurePattern(QUESTION_TWO, 'candidate_invalid_trial'));
  assert.match(
    output,
    failurePattern(`${EPISODE_ONE}#turn-1`, 'candidate_technical_trial')
  );
});

test('failure output never includes question, user, or answer bodies', () => {
  const baseline = syntheticResult();
  const candidate = structuredClone(baseline);
  candidate.results[0].trials = [trial('refuse'), trial('refuse'), trial('kb_answer')];

  const result = runComparator(baseline, candidate);
  const output = outputOf(result);

  assert.equal(result.status, 1, diagnostics(result));
  assert.doesNotMatch(output, /SENSITIVE_QUESTION_BODY/u);
  assert.doesNotMatch(output, /SENSITIVE_ANSWER_BODY/u);
  assert.doesNotMatch(output, /SENSITIVE_EPISODE_USER_BODY/u);
  assert.doesNotMatch(output, /SENSITIVE_EPISODE_ANSWER_BODY/u);
});
