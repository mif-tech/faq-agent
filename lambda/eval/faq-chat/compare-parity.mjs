#!/usr/bin/env node
/**
 * 公開 FAQ eval の responseType parity comparator。
 *
 * 入力には run-eval.mjs の `--out` 結果 JSON を使う。これは fixture hash、
 * scoringVersion、runs と、retry 後の logical trial / trajectory を同じ成果物に持つため。
 * `--record` JSONL は再生用の raw attempt（retry を含む）で、scoringVersion / runs と
 * episode の集約結果を持たないため parity の入力には使わない。
 * 両結果は同梱の公開 sample fixture（10問 + 2 episodes / 4 turns、runs=3）にも束縛し、
 * 同じ --ids subset 同士や、両側で同じ後続turnが欠落した結果を pass させない。
 *
 * 追加パッケージなしの Node.js スクリプトとして、結果本文を一切表示せずに比較する。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 質問側の多数決も scoring.mjs の classifyActual（scope_fallback を独立クラスとして扱う）で
// 取る。transport の responseType 生値で比較すると refuse と refuse+scopeFallback の差が
// 潰れ、episode 側（classifyActual 派生の route）と非対称になる（PR#147 レビュー指摘1。
// scoring.mjs の passOf 併記の警告と同根）。isTechnicalTrial も同一実装を import し、
// 判定が片側だけ変わって gate がサイレントに緩む重複を排除する（同指摘3）
import { classifyActual, isTechnicalTrial } from './scoring.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const SIDES = ['baseline', 'candidate'];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_RUNS = 3;
const PUBLIC_QUESTION_COUNT = 10;
const PUBLIC_EPISODE_COUNT = 2;
const PUBLIC_EPISODE_TURN_COUNT = 4;

function usage() {
  return 'Usage: node eval/faq-chat/compare-parity.mjs --baseline <result.json> --candidate <result.json>';
}

function parseArgs(args) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return { help: true };

  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option !== '--baseline' && option !== '--candidate') return null;
    if (Object.hasOwn(parsed, option)) return null;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) return null;
    parsed[option] = value;
    index += 1;
  }
  if (!parsed['--baseline'] || !parsed['--candidate']) return null;
  return { baseline: parsed['--baseline'], candidate: parsed['--candidate'] };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function addFailure(failures, id, kind) {
  failures.set(`${id}\u0000${kind}`, { id, kind });
}

// exit 1 = parity 退行（gate 本来のシグナル）。exit 2 = 評価基盤エラー（入力不在・fixture 不正・
// 引数不正。run-eval.mjs の exit code 契約に合わせる。PR#147 レビュー指摘2:
// パス打ち間違いと「remote が乖離した」を CI 上で同一シグナルにしない）
function reportFailures(failures, exitCode = 1) {
  const rows = [...failures.values()].sort(
    (left, right) => left.id.localeCompare(right.id, 'en') || left.kind.localeCompare(right.kind, 'en')
  );
  console.error(`parity: fail failures=${rows.length}`);
  for (const row of rows) console.error(`${row.id}\t${row.kind}`);
  process.exitCode = exitCode;
}

function readResult(side, file, failures) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''));
    if (!isRecord(value)) throw new TypeError('result must be an object');
    return value;
  } catch {
    addFailure(failures, side, 'invalid_input');
    return null;
  }
}

function readJsonlFixture(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, '');
  const rows = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { raw, rows };
}

function fixtureHash(raw) {
  return crypto
    .createHash('sha256')
    .update(raw.replace(/\r\n/g, '\n'))
    .digest('hex')
    .slice(0, 16);
}

function loadPublicFixtureContract() {
  const questions = readJsonlFixture(path.join(HERE, 'sample-set.jsonl'));
  const episodes = readJsonlFixture(path.join(HERE, 'sample-episodes.jsonl'));
  const questionIds = new Set();
  const episodeTurns = new Map();

  for (const row of questions.rows) {
    if (
      !isRecord(row) ||
      typeof row.id !== 'string' ||
      !SAFE_ID.test(row.id) ||
      questionIds.has(row.id)
    ) {
      throw new TypeError('invalid public question fixture');
    }
    questionIds.add(row.id);
  }
  for (const row of episodes.rows) {
    if (
      !isRecord(row) ||
      typeof row.id !== 'string' ||
      !SAFE_ID.test(row.id) ||
      episodeTurns.has(row.id) ||
      !Array.isArray(row.turns) ||
      row.turns.length === 0
    ) {
      throw new TypeError('invalid public episode fixture');
    }
    episodeTurns.set(row.id, row.turns.length);
  }

  const turnCount = [...episodeTurns.values()].reduce((total, count) => total + count, 0);
  if (
    questionIds.size !== PUBLIC_QUESTION_COUNT ||
    episodeTurns.size !== PUBLIC_EPISODE_COUNT ||
    turnCount !== PUBLIC_EPISODE_TURN_COUNT
  ) {
    throw new TypeError('unexpected public fixture size');
  }

  return {
    fixtureHash: fixtureHash(questions.raw),
    episodeFixtureHash: fixtureHash(episodes.raw),
    questionIds,
    episodeTurns,
    turnCount,
  };
}

function validateMetadata(baseline, candidate, contract, failures) {
  for (const side of SIDES) {
    const result = side === 'baseline' ? baseline : candidate;
    if (result.mode !== 'api') addFailure(failures, side, 'invalid_mode');
  }

  const fields = [
    {
      key: 'fixtureHash',
      kind: 'set_fixture_hash',
      valid: (value) => typeof value === 'string' && value.length > 0,
      expected: contract.fixtureHash,
    },
    {
      key: 'episodeFixtureHash',
      kind: 'episode_fixture_hash',
      valid: (value) => typeof value === 'string' && value.length > 0,
      expected: contract.episodeFixtureHash,
    },
    {
      key: 'scoringVersion',
      kind: 'scoring_version',
      valid: Number.isInteger,
    },
    {
      key: 'runs',
      kind: 'runs',
      valid: (value) => Number.isInteger(value) && value > 0,
      expected: PUBLIC_RUNS,
    },
  ];

  for (const field of fields) {
    const validity = Object.fromEntries(
      SIDES.map((side) => {
        const value = side === 'baseline' ? baseline[field.key] : candidate[field.key];
        const valid = field.valid(value);
        if (!valid) addFailure(failures, side, `invalid_${field.kind}`);
        return [side, valid];
      })
    );
    if (
      validity.baseline &&
      validity.candidate &&
      baseline[field.key] !== candidate[field.key]
    ) {
      addFailure(failures, 'global', `${field.kind}_mismatch`);
    }
    for (const side of SIDES) {
      const result = side === 'baseline' ? baseline : candidate;
      if (
        validity[side] &&
        field.expected !== undefined &&
        result[field.key] !== field.expected
      ) {
        addFailure(failures, side, `unexpected_${field.kind}`);
      }
    }
  }
}

function indexRows(rows, side, collectionKind, failures) {
  if (!Array.isArray(rows)) {
    addFailure(failures, side, `invalid_${collectionKind}_collection`);
    return new Map();
  }

  const indexed = new Map();
  for (const row of rows) {
    if (!isRecord(row) || typeof row.id !== 'string' || !SAFE_ID.test(row.id)) {
      addFailure(failures, side, `invalid_${collectionKind}_id`);
      continue;
    }
    if (indexed.has(row.id)) {
      addFailure(failures, row.id, `${side}_duplicate_${collectionKind}`);
      continue;
    }
    indexed.set(row.id, row);
  }
  return indexed;
}

function addContractDifferences(expectedIds, rows, side, kind, failures) {
  for (const id of expectedIds.keys()) {
    if (!rows.has(id)) addFailure(failures, id, `${side}_missing_${kind}`);
  }
  for (const id of rows.keys()) {
    if (!expectedIds.has(id)) addFailure(failures, id, `${side}_extra_${kind}`);
  }
}

function addTurnContractDifferences(episodeId, expectedCount, turns, side, failures) {
  for (let turn = 1; turn <= expectedCount; turn += 1) {
    if (!turns.has(turn)) {
      addFailure(failures, `${episodeId}#turn-${turn}`, `${side}_missing_episode_turn`);
    }
  }
  for (const turn of turns) {
    if (turn > expectedCount) {
      addFailure(failures, `${episodeId}#turn-${turn}`, `${side}_extra_episode_turn`);
    }
  }
}

function strictMajority(values, runs) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].find(([, count]) => count * 2 > runs)?.[0] ?? null;
}

function questionMajority(row, side, runs, failures) {
  let valid = true;
  if (row.n !== runs) {
    addFailure(failures, row.id, `${side}_question_run_count`);
    valid = false;
  }
  if (!Array.isArray(row.trials) || row.trials.length !== runs) {
    addFailure(failures, row.id, `${side}_question_trial_count`);
    return null;
  }

  const responseTypes = [];
  for (const trial of row.trials) {
    if (!isRecord(trial) || trial.invalid !== false) {
      addFailure(failures, row.id, `${side}_invalid_trial`);
      valid = false;
      continue;
    }
    if (isTechnicalTrial(trial)) {
      addFailure(failures, row.id, `${side}_technical_trial`);
      valid = false;
      continue;
    }
    if (typeof trial.responseType !== 'string' || trial.responseType.length === 0) {
      addFailure(failures, row.id, `${side}_invalid_trial`);
      valid = false;
      continue;
    }
    // scope_fallback を refuse と区別する派生クラスで多数決を取る（episode 側と対称）
    responseTypes.push(classifyActual(trial));
  }
  if (!valid) return null;

  const majority = strictMajority(responseTypes, runs);
  if (majority === null) addFailure(failures, row.id, `${side}_no_response_type_majority`);
  return majority;
}

function episodeTurnMajorities(row, side, runs, failures) {
  if (row.n !== runs) {
    addFailure(failures, row.id, `${side}_episode_run_count`);
  }
  if (!Array.isArray(row.trajectories) || row.trajectories.length !== runs) {
    addFailure(failures, row.id, `${side}_trajectory_count`);
    return { turns: new Set(), majorities: new Map() };
  }

  const votesByTurn = new Map();
  const observedTurns = new Set();
  const invalidTurns = new Set();
  for (const trajectory of row.trajectories) {
    if (!isRecord(trajectory) || !Array.isArray(trajectory.turns)) {
      addFailure(failures, row.id, `${side}_invalid_trajectory`);
      continue;
    }

    const seenTurns = new Set();
    for (const turn of trajectory.turns) {
      if (!isRecord(turn) || !Number.isInteger(turn.turn) || turn.turn < 1) {
        addFailure(failures, row.id, `${side}_invalid_turn`);
        continue;
      }
      const turnId = `${row.id}#turn-${turn.turn}`;
      observedTurns.add(turn.turn);
      if (seenTurns.has(turn.turn)) {
        addFailure(failures, turnId, `${side}_duplicate_turn`);
        invalidTurns.add(turn.turn);
        continue;
      }
      seenTurns.add(turn.turn);

      if (turn.actual === 'technical') {
        addFailure(failures, turnId, `${side}_technical_trial`);
        invalidTurns.add(turn.turn);
        continue;
      }
      if (
        turn.actual === 'invalid' ||
        typeof turn.actual !== 'string' ||
        turn.actual.length === 0
      ) {
        addFailure(failures, turnId, `${side}_invalid_trial`);
        invalidTurns.add(turn.turn);
        continue;
      }

      const votes = votesByTurn.get(turn.turn) ?? [];
      votes.push(turn.actual);
      votesByTurn.set(turn.turn, votes);
    }
  }

  if (observedTurns.size === 0) {
    addFailure(failures, row.id, `${side}_no_episode_turns`);
    return { turns: observedTurns, majorities: new Map() };
  }

  const maximumTurn = Math.max(...observedTurns);
  for (let turn = 1; turn <= maximumTurn; turn += 1) {
    if (!observedTurns.has(turn)) {
      addFailure(failures, `${row.id}#turn-${turn}`, `${side}_missing_turn`);
    }
  }

  const majorities = new Map();
  for (const turn of observedTurns) {
    if (invalidTurns.has(turn)) continue;
    const votes = votesByTurn.get(turn) ?? [];
    const turnId = `${row.id}#turn-${turn}`;
    const majority = strictMajority(votes, runs);
    if (majority === null) {
      addFailure(failures, turnId, `${side}_no_route_majority`);
      continue;
    }
    majorities.set(turn, majority);
  }
  return { turns: observedTurns, majorities };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed?.help) {
    console.log(usage());
    return;
  }
  if (!parsed) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  const failures = new Map();
  // 同一ファイルを両側に渡す運用ミスは自明 pass になるため基盤エラーとして拒否する
  // （PR#147 レビュー指摘3。realpath で symlink 経路の同一指定も塞ぐ。別々のコピーを
  // 渡すケースは原理的に検出できない。comparator は「別構成の実行結果である」ことまでは
  // 検証できない）
  let baselineRealPath;
  let candidateRealPath;
  try {
    baselineRealPath = fs.realpathSync(parsed.baseline);
    candidateRealPath = fs.realpathSync(parsed.candidate);
  } catch {
    // 不在パスは従来どおり readResult の invalid_input 経路で報告する
    baselineRealPath = path.resolve(parsed.baseline);
    candidateRealPath = path.resolve(parsed.candidate);
  }
  if (baselineRealPath === candidateRealPath) {
    addFailure(failures, 'global', 'identical_input_paths');
    reportFailures(failures, 2);
    return;
  }
  let contract;
  try {
    contract = loadPublicFixtureContract();
  } catch {
    addFailure(failures, 'global', 'invalid_public_fixture');
    reportFailures(failures, 2);
    return;
  }

  const baseline = readResult('baseline', parsed.baseline, failures);
  const candidate = readResult('candidate', parsed.candidate, failures);
  if (!baseline || !candidate) {
    reportFailures(failures, 2);
    return;
  }

  validateMetadata(baseline, candidate, contract, failures);
  if (failures.size > 0) {
    // メタデータ不一致（fixture hash / runs / mode / scoringVersion）は「--ids subset で
    // 回した」「--runs 3 を付け忘れた」「mock 結果を渡した」等の実行手順ミスであり、
    // parity 退行のシグナルではないため基盤エラー扱い（PR#147 レビュー第2ラウンド指摘1）
    reportFailures(failures, 2);
    return;
  }

  const runs = baseline.runs;
  const baselineQuestions = indexRows(baseline.results, 'baseline', 'question', failures);
  const candidateQuestions = indexRows(candidate.results, 'candidate', 'question', failures);
  addContractDifferences(contract.questionIds, baselineQuestions, 'baseline', 'question', failures);
  addContractDifferences(contract.questionIds, candidateQuestions, 'candidate', 'question', failures);

  const baselineQuestionMajorities = new Map(
    [...baselineQuestions].map(([id, row]) => [
      id,
      questionMajority(row, 'baseline', runs, failures),
    ])
  );
  const candidateQuestionMajorities = new Map(
    [...candidateQuestions].map(([id, row]) => [
      id,
      questionMajority(row, 'candidate', runs, failures),
    ])
  );
  for (const id of contract.questionIds) {
    const baselineMajority = baselineQuestionMajorities.get(id);
    const candidateMajority = candidateQuestionMajorities.get(id);
    if (
      baselineMajority != null &&
      candidateMajority != null &&
      baselineMajority !== candidateMajority
    ) {
      addFailure(failures, id, 'response_type_mismatch');
    }
  }

  const baselineEpisodes = indexRows(baseline.episodes, 'baseline', 'episode', failures);
  const candidateEpisodes = indexRows(candidate.episodes, 'candidate', 'episode', failures);
  addContractDifferences(contract.episodeTurns, baselineEpisodes, 'baseline', 'episode', failures);
  addContractDifferences(contract.episodeTurns, candidateEpisodes, 'candidate', 'episode', failures);

  const baselineEpisodeTurns = new Map();
  for (const [id, row] of baselineEpisodes) {
    const turns = episodeTurnMajorities(row, 'baseline', runs, failures);
    baselineEpisodeTurns.set(id, turns);
    const expectedCount = contract.episodeTurns.get(id);
    if (expectedCount !== undefined) {
      addTurnContractDifferences(id, expectedCount, turns.turns, 'baseline', failures);
    }
  }
  const candidateEpisodeTurns = new Map();
  for (const [id, row] of candidateEpisodes) {
    const turns = episodeTurnMajorities(row, 'candidate', runs, failures);
    candidateEpisodeTurns.set(id, turns);
    const expectedCount = contract.episodeTurns.get(id);
    if (expectedCount !== undefined) {
      addTurnContractDifferences(id, expectedCount, turns.turns, 'candidate', failures);
    }
  }

  for (const [id, expectedCount] of contract.episodeTurns) {
    const baselineTurns = baselineEpisodeTurns.get(id);
    const candidateTurns = candidateEpisodeTurns.get(id);
    if (!baselineTurns || !candidateTurns) continue;
    for (let turn = 1; turn <= expectedCount; turn += 1) {
      const baselineMajority = baselineTurns.majorities.get(turn);
      const candidateMajority = candidateTurns.majorities.get(turn);
      if (
        baselineMajority !== undefined &&
        candidateMajority !== undefined &&
        baselineMajority !== candidateMajority
      ) {
        addFailure(failures, `${id}#turn-${turn}`, 'route_mismatch');
      }
    }
  }

  if (failures.size > 0) {
    reportFailures(failures);
    return;
  }

  const counts = [
    `questions=${contract.questionIds.size}`,
    `episodes=${contract.episodeTurns.size}`,
    `episode_turns=${contract.turnCount}`,
  ];
  console.log(`parity: pass ${counts.join(' ')}`);
}

main();
