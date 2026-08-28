#!/usr/bin/env node
/**
 * FAQチャット回帰評価ランナー
 *
 * regression-set.jsonl の各質問を n 回ずつ評価し、期待ラベルで採点する。
 * transport は api / recorded / mock の3モードから選べる（既定 api）。
 * 出力の非決定性（同一質問でも kb_answer⇔refuse が反転しうる）があるため、
 * n=1 の合計点ではなく **有効試行の多数決 + 反転率** で判定する。n>=3 を推奨。
 *
 * さらに episodes-set.jsonl（必須）の **会話エピソード（複数ターン）** も実行する。
 * エピソードは n 本の会話軌跡として実行し（ターン単位の多数決はしない）、
 * 1軌跡 = 全 critical ターンが期待routeに一致で成功、エピソード = 成功が過半数で合格。
 * 履歴は本番契約と同じく **user発話のみ** を蓄積する（本体の sanitizeMessages は
 * assistant発話を偽装注入対策で無視するため、assistantを送っても評価にならない）。
 * 期待routeに未対応の型（現在は clarify）を含むエピソードは pending としてスキップ
 * （ルートレジストリの supported を有効化すると実行対象になる）。
 *
 * 位置づけ: responseType の安定性と過剰回答の回帰ゲート。
 * 回答本文の正しさ・出典エントリの妥当性は採点しない（README「既知の限界」参照）。
 *
 * 使い方:
 *   node run-eval.mjs --api https://xxxx.execute-api.us-west-2.amazonaws.com/dev [オプション]
 *   node run-eval.mjs --mode mock [オプション]
 *
 * オプション:
 *   --mode <mode>      api / recorded / mock（既定 api）
 *   --api <url>        api モードの API Gateway ベースURL（必須。環境変数 FAQ_EVAL_API_URL でも可）
 *   --record <file>    応答を recorded モード用 JSONL へ追記（api / mock。先頭に header 行）
 *   --recording <file> recorded モードで再生する JSONL（必須）
 *   --set <file>       単発質問 JSONL（mock 既定 sample-set、それ以外は regression-set）
 *   --episodes <file>  エピソード JSONL（mock 既定 sample-episodes、それ以外は episodes-set）
 *   --kb <file>        mock モードの StubFaqEntry JSON（既定 sample-kb.json）
 *   --runs <n>         1問あたりの有効試行数（既定 3。3未満は警告つきで許可＝デバッグ用）
 *   --out <file>       結果JSONの出力先（既定 results/eval-<UTC時刻>.json）
 *   --baseline <file>  過去の結果JSONと比較（多数決の変化・passes悪化・新規反転・過剰回答）
 *   --ids <a,b,...>    指定IDだけ実行（デバッグ用。存在しないIDはエラー）
 *   --concurrency <n>  並列質問数（既定 2・最大 4。devの予約同時実行を圧迫しないため）
 *
 * 終了コード（CI契約）:
 *   0 = 評価が正常に完了し、安全性ゲート（refuse の多数決）通過
 *   1 = 正常に評価できたが、refuse 期待の質問で過剰回答が多数決で定着（安全性ゲート落ち）
 *   2 = 評価基盤エラー（引数不正 / フィクスチャ不正 / baseline の scoringVersion 不一致・行欠損 /
 *       意味的応答を過半数確保できない質問がある＝通信失敗またはリトライ後も残る技術失敗 /
 *       blocking エピソードで評価可能な軌跡を過半数確保できない）
 *
 * 採点規則（実測は classifyActual の派生クラスで判定。scoring.mjs 参照）:
 *   answer  : kb_answer が必須（refuse/scope_fallback は取りこぼし）
 *   partial : 同上が望ましい（拒否は機会損失。ただし不正確な断定より安全）
 *   clarify : 有効応答ならどちらでも合格（聞き返し/解釈併記の回答が理想）
 *   refuse  : 素の refuse が必須（scope_fallback は不合格=拒否goldの保護、kb_answer は過剰回答の疑い → 要目視）
 * scope_fallback : refuse + scopeFallback:true（案内型非回答）が必須（安全性ゲートは refuse のみ）
 *   ※ HTTP失敗・非JSON・未知のresponseTypeは「無効試行」で、どのラベルの合格にも数えない
 *   ※ failureKind 付きの refuse（切断・封筒不正・時間切れ等の技術失敗）はリトライで救済を試み、
 *     残った分は投票に参加しない（model_refusal だけは意味的拒否として投票する）
 *
 * エピソードの終了コードへの影響:
 *   blocking: true のエピソードが多数決で不合格 → exit 1（安全性ゲートと同列の失敗）
 *   blocking: true のエピソードが評価不能（技術失敗・通信失敗で評価可能軌跡が過半数未満）→ exit 2
 *   blocking: false（既定）は情報表示のみで exit に影響しない（評価不能でも警告+JSON記録のみ）
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ACTUAL_CLASSES, classifyActual, isTechnicalTrial, passOf, VALID_RESPONSE_TYPES } from './scoring.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// v2: 技術失敗（切断・時間切れ等）を意味的拒否から分離（単発質問の投票規則）
// v3: refuse / scope_fallback の4象限厳格化（refuse gold は flagged refuse で不合格）+
// pilot-023 の gold 付け替え。v2以前の baseline とは投票規則が異なるため比較不可
const SCORING_VERSION = 3;
const EPISODE_SCHEMA_VERSION = 1; // エピソード（会話ラリー）評価の形式版数
// 採点の純粋ロジック（分類・4象限判定）は scoring.mjs に分離
// （lambda/tests/faq-chat-eval-scoring.test.mjs で決定的に固定 / codexレビュー承認条件）
// scope_fallback は単発ラベルとしても使える（refuse とは厳密区別・安全性ゲートは refuse のみ）
const LABELS = ['answer', 'partial', 'clarify', 'refuse', 'scope_fallback'];
// エピソードの期待routeレジストリ（単一の正）。応答契約の拡張（clarify/scope_fallback =
// 将来フェーズ）が入ったら、ここの supported/actual を更新し、あわせて
// VALID_RESPONSE_TYPES にも新しい responseType を追加すること（同期点はこの2箇所。
// 混同行列の列 ACTUAL_CLASSES は VALID_RESPONSE_TYPES から派生する）
const ROUTES = {
  answer: { actual: 'kb_answer', supported: true },
  refuse: { actual: 'refuse', supported: true },
  chat: { actual: 'chat', supported: true },
  clarify: { actual: null, supported: false },
  // 発動済み。actual は classifyActual の派生クラス（refuse + scopeFallback:true）
  scope_fallback: { actual: 'scope_fallback', supported: true },
};
const FETCH_TIMEOUT_MS = 60_000; // 実測でp95は20s前後。ハングだけを切る
const MAX_ATTEMPTS_PER_TRIAL = 3; // 無効試行1回につき最大2回まで取り直す
const MODES = new Set(['api', 'recorded', 'mock']);

const fail = (msg) => {
  console.error(`エラー: ${msg}`);
  process.exit(2);
};

// 未捕捉例外は「評価基盤エラー(2)」へ寄せる。
// Node既定のexit 1が終了コード契約の「安全性ゲート落ち」と誤読されるのを防ぐ
process.on('uncaughtException', (e) => fail(`未捕捉例外: ${e?.stack || e}`));
process.on('unhandledRejection', (e) => fail(`未処理のPromise拒否: ${e?.stack || e}`));

// ---- 引数 ----
const args = process.argv.slice(2);
const KNOWN_FLAGS = new Set([
  '--mode',
  '--api',
  '--record',
  '--recording',
  '--set',
  '--episodes',
  '--kb',
  '--runs',
  '--out',
  '--baseline',
  '--ids',
  '--concurrency',
]);
{
  const seenFlags = new Set();
  for (let i = 0; i < args.length; i++) {
    // タイポ（--run, --id 等）を黙って既定値で走らせない。130リクエスト後に気づく事故を防ぐ
    if (!KNOWN_FLAGS.has(args[i])) fail(`未知の引数: ${args[i]}（有効: ${[...KNOWN_FLAGS].join(' ')}）`);
    if (seenFlags.has(args[i])) fail(`引数が重複しています: ${args[i]}`);
    seenFlags.add(args[i]);
    // 値の打ち忘れ（--runs だけで終わる / 次のトークンがフラグ）も既定値に落とさない
    if (args[i + 1] === undefined || KNOWN_FLAGS.has(args[i + 1])) fail(`${args[i]} の値がありません`);
    i++; // 値を消費
  }
}
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};
const mode = argOf('--mode', 'api');
if (!MODES.has(mode)) fail(`--mode は api / recorded / mock のいずれか（指定値: ${mode}）`);
const hasExplicitApi = args.includes('--api');
const explicitApi = argOf('--api', '');
if (mode !== 'api' && hasExplicitApi) fail(`--mode ${mode} では --api を指定できません`);
const apiBase =
  mode === 'api'
    ? (hasExplicitApi ? explicitApi : process.env.FAQ_EVAL_API_URL || '').replace(/\/+$/, '')
    : null;
if (mode === 'api' && !apiBase)
  fail('--api <url> か環境変数 FAQ_EVAL_API_URL が必要です');
const recordFile = argOf('--record', null);
const recordingFile = argOf('--recording', null);
const kbArg = argOf('--kb', null);
// --record は api（実応答の録画）と mock（fixture の機械再生成）で使える。recorded の再録は無意味なので不可
if (args.includes('--record') && mode === 'recorded') fail('--record は recorded モードでは指定できません');
if (args.includes('--recording') && mode !== 'recorded')
  fail('--recording は recorded モードでのみ指定できます');
if (mode === 'recorded' && !recordingFile)
  fail('--mode recorded では --recording <file> が必要です');
if (args.includes('--kb') && mode !== 'mock') fail('--kb は mock モードでのみ指定できます');
const runsRaw = argOf('--runs', '3');
const runs = Number(runsRaw);
if (!Number.isInteger(runs) || runs < 1) fail(`--runs は1以上の整数（指定値: ${runsRaw}）`);
if (runs < 3) console.warn(`警告: --runs ${runs} は非決定性に対して弱い（推奨 3以上・奇数）`);
else if (runs % 2 === 0) console.warn(`警告: --runs ${runs} は偶数のため同数割れが起こりうる（奇数を推奨）`);
const concurrencyRaw = argOf('--concurrency', '2');
const concurrency = Number(concurrencyRaw);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
  fail(`--concurrency は1〜4の整数（指定値: ${concurrencyRaw}）`);
const outFile = argOf(
  '--out',
  path.join(HERE, 'results', `eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
);
const baselineFile = argOf('--baseline', null);
// baselineはAPI呼び出し前に読んで検証する（130リクエスト消費後に不正で落ちる事故を防ぐ）
let baseline = null;
if (baselineFile) {
  try {
    baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    fail(`--baseline を読めません: ${e.message}`);
  }
  if (typeof baseline !== 'object' || baseline === null || !Array.isArray(baseline.results))
    fail(`--baseline の形式が不正です（results 配列を含むJSONオブジェクトが必要）: ${baselineFile}`);
  // 採点方式が違うベースラインとの比較は投票母集団が異なり無効（codexレビュー指摘）。
  // 43問×n を消費した後に落ちると実行を丸ごと捨てることになるため、必ずここ（API呼び出し前）で検証する
  if (baseline.scoringVersion !== SCORING_VERSION)
    fail(
      `--baseline の scoringVersion が不一致（baseline=${baseline.scoringVersion ?? '欠落'} 現在=${SCORING_VERSION}）。` +
        '投票母集団が異なるため比較できません。現在の採点方式でベースラインを取り直してください'
    );
  // mode が違うベースライン（例: mock のスタブ固定応答 vs api 実行）は母集団が別物で、
  // 偽の degraded / 偽の改善として読まれる。scoringVersion と同じ厳格さで止める（レビュー指摘）
  {
    const baselineMode = baseline.mode ?? 'api';
    if (baselineMode !== mode)
      fail(
        `--baseline の mode が不一致（baseline=${baselineMode} 現在=${mode}）。` +
          '異なる transport の結果は比較できません。同じ mode でベースラインを取り直してください'
      );
  }
  for (const r of baseline.results) {
    // semanticCount だけでなく比較に使う全フィールドを検査（passes 欠落だと bRatio が NaN になり
    // 弱化判定が黙って無効化される同型の fail-open が残る / codexレビュー指摘）
    if (
      typeof r?.id !== 'string' ||
      typeof r?.semanticCount !== 'number' ||
      typeof r?.passes !== 'number' ||
      typeof r?.majorityPass !== 'boolean'
    )
      fail(`--baseline の結果行が不正です（id/semanticCount/passes/majorityPass 欠落: ${r?.id ?? '?'}）。ベースラインを取り直してください`);
  }
}

// ---- フィクスチャ読込・検証 ----
const resolveInputPath = (value, defaultName) =>
  value ? path.resolve(value) : path.join(HERE, defaultName);
const fixturePath = resolveInputPath(
  argOf('--set', null),
  mode === 'mock' ? 'sample-set.jsonl' : 'regression-set.jsonl'
);
let fixtureRaw;
try {
  fixtureRaw = fs.readFileSync(fixturePath, 'utf8').replace(/^﻿/, '');
} catch (e) {
  fail(`質問セットを読めません (${fixturePath}): ${e.message}`);
}
// 改行コードを正規化してからハッシュする（Windows の CRLF checkout と CI の LF で値が変わらないように）
const hashFixture = (raw) => crypto.createHash('sha256').update(raw.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);
const fixtureHash = hashFixture(fixtureRaw);
let allCases;
try {
  allCases = fixtureRaw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
} catch (e) {
  fail(`質問セットのJSONが壊れています (${fixturePath}): ${e.message}`);
}
{
  const seen = new Set();
  for (const [i, c] of allCases.entries()) {
    const at = `${i + 1}行目 (id=${c?.id ?? '?'})`;
    if (typeof c?.id !== 'string' || !c.id) fail(`フィクスチャ不正: ${at} id が空`);
    if (seen.has(c.id)) fail(`フィクスチャ不正: id 重複 ${c.id}`);
    seen.add(c.id);
    if (!LABELS.includes(c.expected)) fail(`フィクスチャ不正: ${at} expected="${c.expected}"`);
    if (typeof c.question !== 'string' || !c.question.trim()) fail(`フィクスチャ不正: ${at} question が空`);
    if (c.expected_entries !== undefined && (!Array.isArray(c.expected_entries) || c.expected_entries.some((x) => typeof x !== 'string')))
      fail(`フィクスチャ不正: ${at} expected_entries は文字列配列`);
  }
}
// ---- エピソード（会話ラリー）読込・検証 ----
const episodesPath = resolveInputPath(
  argOf('--episodes', null),
  mode === 'mock' ? 'sample-episodes.jsonl' : 'episodes-set.jsonl'
);
let episodesRaw;
try {
  episodesRaw = fs.readFileSync(episodesPath, 'utf8').replace(/^﻿/, '');
} catch (e) {
  fail(`エピソードセットを読めません（必須ファイル）(${episodesPath}): ${e.message}`);
}
const episodeFixtureHash = hashFixture(episodesRaw);
let allEpisodes;
try {
  allEpisodes = episodesRaw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
} catch (e) {
  fail(`エピソードセットのJSONが壊れています (${episodesPath}): ${e.message}`);
}
{
  const seen = new Set(allCases.map((c) => c.id));
  for (const [i, ep] of allEpisodes.entries()) {
    const at = `${i + 1}行目 (id=${ep?.id ?? '?'})`;
    if (typeof ep?.id !== 'string' || !ep.id.trim()) fail(`エピソード不正: ${at} id が空`);
    if (seen.has(ep.id)) fail(`エピソード不正: id 重複（単発質問と共有の名前空間）: ${ep.id}`);
    seen.add(ep.id);
    if (!Array.isArray(ep.turns) || ep.turns.length === 0) fail(`エピソード不正: ${at} turns が空`);
    if (ep.tags !== undefined && (!Array.isArray(ep.tags) || ep.tags.some((t) => typeof t !== 'string')))
      fail(`エピソード不正: ${at} tags は文字列配列`);
    if (ep.blocking !== undefined && typeof ep.blocking !== 'boolean') fail(`エピソード不正: ${at} blocking は boolean`);
    let hasPendingRoute = false;
    for (const [ti, turn] of ep.turns.entries()) {
      const tat = `${at} turn ${ti + 1}`;
      if (typeof turn?.user !== 'string' || !turn.user.trim()) fail(`エピソード不正: ${tat} user が空`);
      const route = turn?.expected?.route;
      if (typeof route !== 'string' || !Object.hasOwn(ROUTES, route))
        fail(`エピソード不正: ${tat} expected.route="${route}"（有効: ${Object.keys(ROUTES).join('/')}）`);
      if (!ROUTES[route].supported) hasPendingRoute = true;
      if (turn.expected.critical !== undefined && typeof turn.expected.critical !== 'boolean')
        fail(`エピソード不正: ${tat} expected.critical は boolean`);
      if (
        turn.expected.answerIncludesAny !== undefined &&
        (!Array.isArray(turn.expected.answerIncludesAny) ||
          turn.expected.answerIncludesAny.length === 0 ||
          turn.expected.answerIncludesAny.some((s) => typeof s !== 'string' || !s))
      )
        fail(`エピソード不正: ${tat} expected.answerIncludesAny は非空文字列の配列`);
    }
    // pending は実行されず blocking ゲートに乗らないため、組み合わせは矛盾（codexレビュー指摘）
    if (hasPendingRoute && ep.blocking === true)
      fail(`エピソード不正: ${at} 未対応routeを含むエピソードに blocking:true は指定できない`);
  }
}

let cases = allCases;
let selectedEpisodes = allEpisodes;
if (argOf('--ids', '')) {
  const want = argOf('--ids', '').split(',').filter(Boolean);
  const have = new Set([...allCases.map((c) => c.id), ...allEpisodes.map((e) => e.id)]);
  const missing = want.filter((id) => !have.has(id));
  if (missing.length) fail(`--ids に存在しないID: ${missing.join(', ')}`);
  const wantSet = new Set(want);
  cases = allCases.filter((c) => wantSet.has(c.id));
  selectedEpisodes = allEpisodes.filter((e) => wantSet.has(e.id));
}
// ID選択の後で active/pending に分割（pending IDだけを指定したときに理由が見えるように）
const pendingEpisodes = selectedEpisodes.filter((ep) => ep.turns.some((t) => !ROUTES[t.expected.route].supported));
const episodes = selectedEpisodes.filter((ep) => !pendingEpisodes.includes(ep));
if (cases.length === 0 && episodes.length === 0) {
  if (pendingEpisodes.length)
    fail(`指定されたIDは全て pending（未対応route待ち）です: ${pendingEpisodes.map((e) => e.id).join(', ')}`);
  fail('対象の質問が0件です');
}

// ---- transport 用入力・出力のプリフライト ----
const resolvedRecordFile = recordFile ? path.resolve(recordFile) : null;
if (resolvedRecordFile) {
  try {
    fs.mkdirSync(path.dirname(resolvedRecordFile), { recursive: true });
  } catch (e) {
    fail(`--record の出力先を準備できません (${resolvedRecordFile}): ${e.message}`);
  }
  // 「先頭行が header」を不変条件にする: 非空ファイルへの追記は拒否し、header はここで 1 回だけ書く
  // （呼び出し 0 件でも header だけのファイルになる / レビュー指摘）
  let existing = '';
  try {
    existing = fs.readFileSync(resolvedRecordFile, 'utf8');
  } catch {
    existing = '';
  }
  if (existing.trim().length > 0) {
    // 前回が header を書いた直後に中断した残骸（header 1 行のみ）は上書きを許す（レビュー指摘）
    const lines = existing.split('\n').filter((line) => line.trim());
    let headerOnly = false;
    if (lines.length === 1) {
      try {
        headerOnly = JSON.parse(lines[0])?.header === true;
      } catch {
        headerOnly = false;
      }
    }
    if (!headerOnly)
      fail(`--record の出力先が空ではありません (${resolvedRecordFile})。録画は実行ごとに新しいファイルへ書いてください`);
  }
  const header = { header: true, mode, fixtureHash, episodeFixtureHash, recordedAt: new Date().toISOString() };
  try {
    fs.writeFileSync(resolvedRecordFile, `${JSON.stringify(header)}\n`, 'utf8');
  } catch (e) {
    fail(`recording header を ${resolvedRecordFile} に書けません: ${e.message}`);
  }
}

const resolvedRecordingFile = recordingFile ? path.resolve(recordingFile) : null;
// 再生キーは (id, trial, turn)。turn = その呼び出しで送った messages の長さ（エピソードのターン進行）。
// 同一キーの複数行は「同じターンのリトライ」としてファイル順に消費する。以前の (id, trial) キーでは
// リトライが次ターンの録画行を食い、以降のターンがズレたまま採点されえた（レビュー指摘）
const recordingQueues = new Map();
let recordingHeader = null;
const recordingKey = (id, trial, turn) => `${id}\u0000${trial}\u0000${turn}`;
if (mode === 'recorded') {
  let raw;
  try {
    raw = fs.readFileSync(resolvedRecordingFile, 'utf8').replace(/^﻿/, '');
  } catch (e) {
    fail(`--recording を読めません (${resolvedRecordingFile}): ${e.message}`);
  }
  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (e) {
      fail(`--recording のJSONが壊れています (${index + 1}行目): ${e.message}`);
    }
    if (row?.header === true) {
      if (recordingHeader) fail(`--recording の形式が不正です (${index + 1}行目): header 行が複数`);
      recordingHeader = row;
      continue;
    }
    if (typeof row?.id !== 'string' || !row.id.trim())
      fail(`--recording の形式が不正です (${index + 1}行目): id が空`);
    if (!Number.isInteger(row?.trial) || row.trial < 1)
      fail(`--recording の形式が不正です (${index + 1}行目): trial は1以上の整数`);
    if (!Array.isArray(row?.messages))
      fail(`--recording の形式が不正です (${index + 1}行目): messages は配列`);
    if (
      typeof row?.response !== 'object' ||
      row.response === null ||
      !Number.isInteger(row.response.status) ||
      row.response.status < 0
    )
      fail(`--recording の形式が不正です (${index + 1}行目): response.status が不正`);
    // 旧形式（turn 欠落）は messages の長さをターンとみなす
    const turn = Number.isInteger(row.turn) && row.turn >= 1 ? row.turn : row.messages.length;
    const key = recordingKey(row.id, row.trial, turn);
    const queue = recordingQueues.get(key) || [];
    queue.push(row);
    recordingQueues.set(key, queue);
  }
}
// 録画がどのセットで取られたかを照合する。--set を書き換えたのに ID が同じなら旧応答で黙って通る
// fail-open を塞ぐ（レビュー指摘）。header の無い旧録画は警告のみ
if (mode === 'recorded') {
  if (!recordingHeader) {
    console.warn('警告: --recording に header 行がありません（fixtureHash を照合できません。--record で取り直しを推奨）');
  } else {
    // 録画元の mode（api 実応答 / mock スタブ）も比較対象。recorded 同士でも録画元が違えば
    // 「スタブ固定応答 vs 実応答」の偽 degraded になるため、baseline.recordingMode と突き合わせる
    if (baseline) {
      // scoringVersion / mode と同じ厳格さ: baseline 側に recordingMode が無い（本機能以前の録画再生）場合も
      // 録画元を照合できないので不一致として止める（片側 null の無警告スキップは fail-open / レビュー指摘）
      const baselineRecordingMode = baseline.recordingMode ?? null;
      const currentRecordingMode = recordingHeader.mode ?? null;
      if (baselineRecordingMode !== currentRecordingMode)
        fail(
          `--baseline の recordingMode が不一致（baseline=${baselineRecordingMode ?? '欠落'} 現在=${currentRecordingMode ?? '欠落'}）。` +
            '録画元の transport が異なる（または照合できない）結果は比較できません。同じ録画元でベースラインを取り直してください'
        );
    }
    if (recordingHeader.fixtureHash && recordingHeader.fixtureHash !== fixtureHash)
      fail(
        `--recording の fixtureHash が不一致（recording=${recordingHeader.fixtureHash} 現在=${fixtureHash}）。` +
          '質問セットが録画時と異なります。同じセットで --record し直してください'
      );
    if (recordingHeader.episodeFixtureHash && recordingHeader.episodeFixtureHash !== episodeFixtureHash)
      fail(
        `--recording の episodeFixtureHash が不一致（recording=${recordingHeader.episodeFixtureHash} 現在=${episodeFixtureHash}）。` +
          'エピソードセットが録画時と異なります。同じセットで --record し直してください'
      );
  }
}

const kbPath =
  mode === 'mock' ? resolveInputPath(kbArg, 'sample-kb.json') : null;
let mockEntries = null;
if (mode === 'mock') {
  try {
    mockEntries = JSON.parse(fs.readFileSync(kbPath, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    fail(`mock KB を読めません (${kbPath}): ${e.message}`);
  }
  if (!Array.isArray(mockEntries)) fail(`mock KB は StubFaqEntry のJSON配列が必要です: ${kbPath}`);
  const seenEntryIds = new Set();
  for (const [index, entry] of mockEntries.entries()) {
    const at = `${index + 1}件目 (id=${entry?.id ?? '?'})`;
    if (typeof entry?.id !== 'string' || !entry.id.trim()) fail(`mock KB 不正: ${at} id が空`);
    if (seenEntryIds.has(entry.id)) fail(`mock KB 不正: id 重複 ${entry.id}`);
    seenEntryIds.add(entry.id);
    if (typeof entry.topic !== 'string' || !entry.topic.trim()) fail(`mock KB 不正: ${at} topic が空`);
    if (typeof entry.content !== 'string' || !entry.content.trim()) fail(`mock KB 不正: ${at} content が空`);
    if (
      entry.canonicalUrl !== undefined &&
      (typeof entry.canonicalUrl !== 'string' || !entry.canonicalUrl.trim())
    )
      fail(`mock KB 不正: ${at} canonicalUrl は非空文字列`);
  }
}

// ---- 実行 ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** HTTP / handler の生レスポンスを既存の採点用 trial へ正規化する。 */
function normalizeResponse({ status, body, elapsedMs, retryAfterSec = 0, transportError = null }) {
  if (transportError) {
    return {
      status,
      elapsed_ms: elapsedMs,
      responseType: null,
      answer: null,
      sources: [],
      failureKind: null,
      invalid: true,
      retryAfterSec,
      invalidReason: transportError,
    };
  }
  const responseType = body?.responseType ?? null;
  const answer = typeof body?.answer === 'string' ? body.answer : null;
  const ok = status >= 200 && status < 300;
  const invalid =
    !ok ||
    !VALID_RESPONSE_TYPES.has(responseType) ||
    (responseType === 'kb_answer' && !answer?.trim());
  return {
    status,
    elapsed_ms: elapsedMs,
    responseType,
    answer,
    sources: Array.isArray(body?.sources) ? body.sources.map((s) => s?.topic).filter(Boolean) : [],
    // 技術失敗の機械可読分類（handler.ts が refuse に付与。意味的拒否には付かない）
    failureKind: typeof body?.failureKind === 'string' ? body.failureKind : null,
    // 範囲内だが資料不足の案内型（refuse + 直交フラグ）
    scopeFallback: body?.scopeFallback === true,
    invalid,
    retryAfterSec,
    ...(invalid ? { invalidReason: !ok ? `http_${status}` : 'bad_shape' } : {}),
  };
}

function redactedRecordingMessages(id, messages) {
  return messages.map((message, index) => ({
    role: message?.role,
    content: `[id:${id};message:${index + 1}]`,
  }));
}

function appendRecording(context, messages, response) {
  if (!resolvedRecordFile) return;
  const row = {
    id: context.id,
    trial: context.trial,
    turn: messages.length,
    messages: redactedRecordingMessages(context.id, messages),
    response,
  };
  try {
    fs.appendFileSync(resolvedRecordFile, `${JSON.stringify(row)}\n`, 'utf8');
  } catch (e) {
    fail(`recording を ${resolvedRecordFile} に追記できません: ${e.message}`);
  }
}

/** api transport。既存の fetch 契約を保ち、指定時だけ生レスポンスを追記する。 */
async function callApiOnce(messages, context) {
  const started = Date.now();
  try {
    const res = await fetch(`${apiBase}/faq-chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const retryAfterRaw = res.headers.get('retry-after');
    let retryAfterSec = Number(retryAfterRaw) || 0;
    if (!retryAfterSec && retryAfterRaw) {
      // Retry-After は HTTP-date 形式もありうる
      const at = Date.parse(retryAfterRaw);
      if (!Number.isNaN(at)) retryAfterSec = Math.max(0, Math.ceil((at - Date.now()) / 1000));
    }
    const body = await res.json().catch(() => null);
    appendRecording(context, messages, {
      status: res.status,
      body,
      ...(retryAfterSec ? { retryAfterSec } : {}),
    });
    return normalizeResponse({
      status: res.status,
      body,
      elapsedMs: Date.now() - started,
      retryAfterSec,
    });
  } catch (e) {
    const invalidReason =
      e?.name === 'TimeoutError' ? 'timeout' : `fetch_error: ${String(e?.message || e)}`;
    appendRecording(context, messages, { status: 0, body: null, error: invalidReason });
    return normalizeResponse({
      status: 0,
      body: null,
      elapsedMs: Date.now() - started,
      transportError: invalidReason,
    });
  }
}

/** recorded transport。(id, trial, turn) ごとにファイル順のFIFOで再生する（同一ターンのリトライ分のみ消費）。 */
async function callRecordedOnce(messages, context) {
  const turn = messages.length;
  const key = recordingKey(context.id, context.trial, turn);
  const row = recordingQueues.get(key)?.shift();
  if (!row) {
    return normalizeResponse({
      status: 0,
      body: null,
      elapsedMs: 0,
      transportError: `recording_missing: ${context.id} trial ${context.trial} turn ${turn}`,
    });
  }
  return normalizeResponse({
    status: row.response.status,
    body: row.response.body,
    elapsedMs: 0,
    retryAfterSec: Number(row.response.retryAfterSec) || 0,
    transportError:
      typeof row.response.error === 'string' && row.response.error
        ? row.response.error
        : null,
  });
}

/** handler.ts をテストと同じ依存モックで bundle し、in-process transport を作る。 */
async function createMockTransport(entries) {
  const tempRoot = path.resolve(os.tmpdir());
  const outDir = fs.mkdtempSync(path.join(tempRoot, 'faq-eval-mock-'));
  if (path.dirname(path.resolve(outDir)) !== tempRoot)
    fail(`mock の一時ディレクトリが想定外です: ${outDir}`);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    fs.rmSync(outDir, { recursive: true, force: true });
  };
  process.once('exit', cleanup);

  try {
    const { build } = await import('esbuild');
    const faqRoot = path.join(HERE, '..', '..', 'functions', 'faq-chat');
    const outfile = path.join(outDir, 'handler-eval-entry.mjs');
    const handlerPath = path.join(faqRoot, 'handler.ts').replaceAll('\\', '/');
    const stubPath = path.join(faqRoot, 'adapters', 'stub.ts').replaceAll('\\', '/');
    await build({
      stdin: {
        contents: [
          `import { createFaqHandler } from ${JSON.stringify(handlerPath)};`,
          'let activeHandler;',
          'export function __setFaqPortsForTest(ports) { activeHandler = createFaqHandler(ports); }',
          "export async function handler(event, context) { if (!activeHandler) throw new Error('FAQ eval handler is not configured'); return activeHandler(event, context); }",
          `export { createStubFaqPorts } from ${JSON.stringify(stubPath)};`,
        ].join('\n'),
        loader: 'ts',
        resolveDir: HERE,
        sourcefile: 'faq-chat-eval-mock-entry.ts',
      },
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      outfile,
      logLevel: 'silent',
      plugins: [
        {
          name: 'mock-faq-eval-handler-dependencies',
          setup(esbuild) {
            esbuild.onResolve(
              { filter: /dynamodb-entries\.js$/ },
              () => ({ path: 'dynamodb-entries', namespace: 'faq-eval-stub' })
            );
            esbuild.onResolve(
              { filter: /shared[\\/]kb-injection\.js$/ },
              () => ({ path: 'kb-injection', namespace: 'faq-eval-stub' })
            );
            esbuild.onResolve(
              { filter: /shared[\\/]llm-provider\.js$/ },
              () => ({ path: 'llm-provider', namespace: 'faq-eval-stub' })
            );
            esbuild.onResolve(
              { filter: /shared[\\/]repositories[\\/]knowledgeEntries\.js$/ },
              () => ({ path: 'knowledge-entries', namespace: 'faq-eval-stub' })
            );
            esbuild.onLoad(
              { filter: /^dynamodb-entries$/, namespace: 'faq-eval-stub' },
              () => ({
                contents: `
                  export const dynamoDbFaqKbSource = {
                    async loadPublicEntries() {
                      throw new Error('default free KB source must not be called');
                    },
                  };
                `,
                loader: 'js',
              })
            );
            esbuild.onLoad(
              { filter: /^kb-injection$/, namespace: 'faq-eval-stub' },
              () => ({
                contents:
                  'export async function buildQueryKbInjection() {' +
                  " throw new Error('production KB adapter must not be called'); }",
                loader: 'js',
              })
            );
            esbuild.onLoad(
              { filter: /^llm-provider$/, namespace: 'faq-eval-stub' },
              () => ({
                contents:
                  "export const DEFAULT_FAQ_MODEL = 'production-model-must-not-be-used';" +
                  ' export async function callClaudeFaq() {' +
                  " throw new Error('production LLM adapter must not be called'); }",
                loader: 'js',
              })
            );
            esbuild.onLoad(
              { filter: /^knowledge-entries$/, namespace: 'faq-eval-stub' },
              () => ({
                contents:
                  'export async function listAllActive() {' +
                  " throw new Error('default free KB loader must not be called'); }",
                loader: 'js',
              })
            );
          },
        },
      ],
    });
    const { handler, __setFaqPortsForTest, createStubFaqPorts } = await import(
      pathToFileURL(outfile).href
    );
    __setFaqPortsForTest(
      createStubFaqPorts({
        entries,
        settings: {
          enabled: true,
          fallbackMessage: 'サンプルKBに該当する情報がありません。',
        },
      })
    );
    // Lambda context スタブ（時間予算 30s）。呼び出し側の {id, trial} とは別物なので名前を分ける
    // （同名にすると引数が外側を隠し、handler の時間予算経路が mock で死ぬ / レビュー指摘）
    const lambdaContext = { getRemainingTimeInMillis: () => 30_000 };
    return async (messages, callContext) => {
      const started = Date.now();
      const response = await handler(
        {
          version: '2.0',
          routeKey: 'POST /faq-chat',
          rawPath: '/faq-chat',
          headers: { 'content-type': 'application/json' },
          requestContext: { http: { method: 'POST', path: '/faq-chat' } },
          body: JSON.stringify({ messages }),
          isBase64Encoded: false,
        },
        lambdaContext
      );
      const status = Number(response?.statusCode) || 0;
      let body = null;
      try {
        body = JSON.parse(response?.body ?? 'null');
      } catch {
        // API transport の非JSON応答と同様、bad_shape として正規化する
      }
      // mock でも --record できる（fixture の機械再生成用。api 録画と混ぜない）
      appendRecording(callContext, messages, { status, body });
      return normalizeResponse({
        status,
        body,
        elapsedMs: Date.now() - started,
      });
    };
  } catch (e) {
    cleanup();
    fail(`mock handler を準備できません: ${e?.stack || e}`);
  }
}

const callOnce =
  mode === 'api'
    ? callApiOnce
    : mode === 'recorded'
      ? callRecordedOnce
      : await createMockTransport(mockEntries);

/** 意味のある応答を1つ得る（無効・技術失敗は限定リトライ。429はRetry-After尊重）。
 *  技術失敗（failureKind付きrefuse）は本体が「もう一度お試しください」と案内するものなので
 *  実ユーザーと同じくリトライで救済を試み、遭遇回数は technicalAttempts として観測する
 *  （リトライしても偶発切断1回で質問全体が評価不能に落ちる過剰厳格を避ける / codexレビュー指摘） */
async function validTrial(messages, context) {
  let last = null;
  let technicalAttempts = 0;
  let attemptsUsed = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_TRIAL; attempt++) {
    last = await callOnce(messages, context);
    attemptsUsed++;
    const technical = !last.invalid && isTechnicalTrial(last);
    if (technical) technicalAttempts++;
    if (!last.invalid && !technical) break; // 意味のある応答を得た
    // 録画行の欠落は回復不能なのでリトライしない
    if (typeof last.invalidReason === 'string' && last.invalidReason.startsWith('recording_missing')) break;
    if (attempt < MAX_ATTEMPTS_PER_TRIAL && mode === 'api') {
      // ペーシング/バックオフは dev の予約同時実行を守るためのもの。オフライン transport では不要
      const backoff =
        last.status === 429 && last.retryAfterSec > 0
          ? last.retryAfterSec * 1000
          : 1000 * attempt + Math.random() * 500;
      await sleep(Math.min(backoff, 15_000));
    }
  }
  // 使い切っても無効/技術失敗ならその状態のまま記録（技術失敗は投票に参加しない）
  return { ...last, technicalAttempts, attemptsUsed };
}

// passOf / isTechnicalTrial / classifyActual は scoring.mjs からimport（4象限テストで固定）

async function evalCase(c) {
  const trials = [];
  for (let i = 0; i < runs; i++) {
    trials.push(
      await validTrial([{ role: 'user', content: c.question }], {
        id: c.id,
        trial: i + 1,
      })
    );
    if (i < runs - 1 && mode === 'api') await sleep(800);
  }
  const valid = trials.filter((t) => !t.invalid);
  // リトライで救済しきれず技術失敗のまま残った試行数（投票に参加しない）
  const technicalCount = valid.filter(isTechnicalTrial).length;
  // リトライ内も含めて技術失敗に遭遇した回数（観測用。救済成功分も含む）
  const technicalAttempts = trials.reduce((a, t) => a + (t.technicalAttempts || 0), 0);
  // この質問に費やした総API呼び出し回数（リトライ込み。呼び出しベースの率の分母）
  const callsUsed = trials.reduce((a, t) => a + (t.attemptsUsed || 1), 0);
  // 技術失敗は「意味のある応答」ではないので採点・反転判定の母集団から外す。
  // types は classifyActual の派生クラス（refuse と scope_fallback を区別。
  // 反転判定・過剰回答判定・passOf すべてこの粒度で行う）
  const semantic = valid.filter((t) => !isTechnicalTrial(t));
  const types = semantic.map((t) => classifyActual(t));
  const passes = semantic.filter((t) => passOf(c.expected, classifyActual(t))).length;
  // 意味のある試行が予定数の過半数に満たない場合は評価不能（採点しない）
  const evaluable = semantic.length * 2 > runs;
  const majorityPass = evaluable && passes * 2 > semantic.length;
  const flipped = new Set(types).size > 1; // 意味のある応答間の反転のみ
  const overAnswerCount =
    c.expected === 'refuse' || c.expected === 'scope_fallback'
      ? types.filter((t) => t === 'kb_answer').length
      : 0;
  return {
    id: c.id,
    expected: c.expected,
    question: c.question,
    types,
    passes,
    validCount: valid.length, // 通信・形式として有効な試行数（validCount + invalidCount === n を維持）
    semanticCount: semantic.length, // 採点に参加した試行数（valid − technical）
    technicalCount,
    technicalAttempts,
    callsUsed,
    invalidCount: trials.length - valid.length,
    n: trials.length,
    evaluable,
    majorityPass,
    flipped,
    overAnswerCount,
    trials,
  };
}

/** エピソード1本 = 会話軌跡を runs 回実行する。
 *  ターン単位の多数決はしない（途中ターンが揺れた軌跡は、その軌跡ごと成否が決まる）。
 *  critical ターンの不一致が出た時点で軌跡は失敗確定なので残りターンは実行しない
 *  （失敗後のターンは意図した文脈と異なり、実行しても解釈できないため）。
 *  履歴は本番契約どおり user 発話のみ蓄積する（本体が assistant を無視するため） */
async function runEpisode(ep) {
  const trajectories = [];
  for (let i = 0; i < runs; i++) {
    const msgs = [];
    const turns = [];
    // 軌跡の状態: success（全criticalターン合格）/ fail（意味的応答が期待と不一致）/
    // unevaluable（リトライ後も技術失敗・通信失敗が残り、意味的な成否を判定できない）。
    // 単発側の「技術失敗は投票に参加しない」と対称にし、偶発切断が blocking エピソードの
    // exit 1（品質退行シグナル）に化けないようにする（codexレビュー指摘）
    let state = 'success';
    for (const [ti, turn] of ep.turns.entries()) {
      msgs.push({ role: 'user', content: turn.user });
      const t = await validTrial([...msgs], { id: ep.id, trial: i + 1 });
      const actual = classifyActual(t);
      const critical = turn.expected.critical !== false;
      // route一致に加え、answerIncludesAny 指定時は本文の内容オラクル（いずれかの文字列を含む）
      // も要求する。route だけだと無関係な kb_answer でも合格してしまう（codexレビュー指摘）
      const routePass = actual === ROUTES[turn.expected.route].actual;
      const contentPass =
        !turn.expected.answerIncludesAny ||
        (typeof t.answer === 'string' && turn.expected.answerIncludesAny.some((s) => t.answer.includes(s)));
      const pass = routePass && contentPass;
      turns.push({
        turn: ti + 1,
        user: turn.user,
        expectedRoute: turn.expected.route,
        actual,
        pass,
        routePass,
        contentPass,
        critical,
        failureKind: t.failureKind ?? null,
        technicalAttempts: t.technicalAttempts || 0,
        attemptsUsed: t.attemptsUsed || 1,
        answer: t.answer,
      });
      if (actual === 'technical' || actual === 'invalid') {
        state = 'unevaluable';
        break;
      }
      if (critical && !pass) {
        state = 'fail';
        break;
      }
      if (mode === 'api') await sleep(800);
    }
    trajectories.push({ state, turns });
    if (i < runs - 1 && mode === 'api') await sleep(800);
  }
  const successes = trajectories.filter((x) => x.state === 'success').length;
  const evaluableTrajectories = trajectories.filter((x) => x.state !== 'unevaluable').length;
  const allTurns = trajectories.flatMap((x) => x.turns);
  return {
    id: ep.id,
    tags: ep.tags || [],
    blocking: ep.blocking === true,
    n: trajectories.length,
    successes,
    evaluableTrajectories,
    // 意味的に判定できた軌跡が過半数に満たなければエピソード自体が評価不能（exit 2側）
    evaluable: evaluableTrajectories * 2 > trajectories.length,
    majorityPass: evaluableTrajectories * 2 > trajectories.length && successes * 2 > evaluableTrajectories,
    callsUsed: allTurns.reduce((a, t) => a + t.attemptsUsed, 0),
    technicalAttempts: allTurns.reduce((a, t) => a + t.technicalAttempts, 0),
    trajectories,
  };
}

/** 単発・エピソード共通の並列プール */
async function runPool(items, fn) {
  const out = [];
  const queue = [...items];
  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      out.push(await fn(item));
    }
  });
  await Promise.all(workers);
  return out;
}

const transportDescription =
  mode === 'api'
    ? `API: ${apiBase}`
    : mode === 'recorded'
      ? `Mode: recorded (${resolvedRecordingFile})`
      : `Mode: mock (${kbPath})`;
console.log(
  `${transportDescription}  質問: ${cases.length}  エピソード: ${episodes.length}${pendingEpisodes.length ? `(+pending ${pendingEpisodes.length})` : ''}  各${runs}回  並列${concurrency}  fixture=${fixtureHash}  episodes=${episodeFixtureHash}`
);
let done = 0;
const results = await runPool(cases, async (c) => {
  const r = await evalCase(c);
  done++;
  const mark = !r.evaluable ? '?? ' : r.majorityPass ? 'OK ' : 'NG ';
  console.log(
    `${String(done).padStart(2)}/${cases.length} ${mark}${r.id} [${r.expected}] ${r.passes}/${r.semanticCount}` +
      `${r.technicalCount ? ` 技術失敗${r.technicalCount}` : ''}${r.invalidCount ? ` 無効${r.invalidCount}` : ''}${r.flipped ? ' 反転' : ''}` +
      `${r.overAnswerCount ? ` ★過剰回答疑い×${r.overAnswerCount}` : ''}${!r.evaluable ? ' 評価不能' : ''}`
  );
  return r;
});
results.sort((a, b) => a.id.localeCompare(b.id));

let episodeResults = [];
if (episodes.length) {
  console.log('\n===== エピソード（完全軌跡×n） =====');
  let epDone = 0;
  episodeResults = await runPool(episodes, async (ep) => {
    const r = await runEpisode(ep);
    epDone++;
    const mark = !r.evaluable ? '?? ' : r.majorityPass ? 'OK ' : 'NG ';
    console.log(
      `${String(epDone).padStart(2)}/${episodes.length} ${mark}${r.id} ${r.successes}/${r.evaluableTrajectories}` +
        `${r.evaluableTrajectories < r.n ? `（評価可能軌跡${r.evaluableTrajectories}/${r.n}）` : ''}` +
        `${r.tags.length ? ` [${r.tags.join(',')}]` : ''}${r.blocking ? ' (blocking)' : ''}${!r.evaluable ? ' 評価不能' : ''}`
    );
    return r;
  });
  episodeResults.sort((a, b) => a.id.localeCompare(b.id));
}
if (pendingEpisodes.length)
  console.log(`pending（未対応routeを含むためスキップ）: ${pendingEpisodes.map((e) => e.id).join(', ')}`);

// ---- 集計 ----
const summary = {};
for (const label of LABELS) {
  const rows = results.filter((r) => r.expected === label);
  summary[label] = {
    total: rows.length,
    majorityPass: rows.filter((r) => r.majorityPass).length,
    flipped: rows.filter((r) => r.flipped).length,
    unevaluable: rows.filter((r) => !r.evaluable).length,
  };
}
const totalTrials = results.reduce((a, r) => a + r.n, 0);
const invalidTrials = results.reduce((a, r) => a + r.invalidCount, 0);
const technicalTrials = results.reduce((a, r) => a + r.technicalCount, 0); // リトライ後も残存
const technicalAttemptsTotal = results.reduce((a, r) => a + r.technicalAttempts, 0); // 遭遇（救済分含む）
const totalCalls = results.reduce((a, r) => a + r.callsUsed, 0); // リトライ込みの総API呼び出し回数
const errorRate = totalTrials ? invalidTrials / totalTrials : 0;
const technicalRate = totalTrials ? technicalTrials / totalTrials : 0;
// 1呼び出しあたりの技術失敗率。リトライなし時代の実測（切断10.9%→1500化で3.8%）と同じ土俵。
// 分母は無効呼び出し（HTTP失敗・タイムアウト）も含む総呼び出し。無効側の規模は errorRate で見る
const technicalCallRate = totalCalls ? technicalAttemptsTotal / totalCalls : 0;
const flipRate = results.length ? results.filter((r) => r.flipped).length / results.length : 0;
const overAnswerIds = results.filter((r) => r.overAnswerCount > 0).map((r) => r.id);
const unevaluableIds = results.filter((r) => !r.evaluable).map((r) => r.id);

console.log('\n===== 集計（有効試行の多数決） =====');
for (const label of LABELS) {
  const s = summary[label];
  console.log(
    `${label.padEnd(14)} ${s.majorityPass}/${s.total}  反転あり ${s.flipped}件` +
      (s.unevaluable ? `  評価不能 ${s.unevaluable}件` : '')
  );
}
console.log(
  `反転率（意味的反転のみ）: ${(flipRate * 100).toFixed(1)}%` +
    `  技術失敗: ${technicalAttemptsTotal}/${totalCalls}呼び出し (${(technicalCallRate * 100).toFixed(1)}%) / リトライ後残存 ${technicalTrials}/${totalTrials}試行` +
    `  無効試行率: ${(errorRate * 100).toFixed(1)}% (${invalidTrials}/${totalTrials})`
);
// 技術失敗は直接のexitゲートではないが、高止まりは可用性問題なので警告する
// （残存が過半数に達した質問は「評価不能」として exit 2 に落ちる。下記参照）。
// しきい値は呼び出しベースで統一（分子・分母の単位を揃える / codexレビュー指摘）
if (technicalCallRate >= 0.1)
  console.warn(`警告: 技術失敗率が高い（${(technicalCallRate * 100).toFixed(1)}%/呼び出し）。切断・時間切れの調査を優先すべき`);
if (overAnswerIds.length) console.log(`★過剰回答疑い（refuse/scope_fallback期待でkb_answerが1回以上 → 要目視）: ${overAnswerIds.join(', ')}`);
if (unevaluableIds.length) console.log(`?? 評価不能（有効試行が過半数未満）: ${unevaluableIds.join(', ')}`);

// ---- 混同行列（期待ラベル × 実測分類）----
// ルーティング退行の検出用（codex設計）: 「answer期待→refuse化」「refuse期待→kb_answer化」等の
// 流出方向を、合計点に埋もれさせず行列で見る。raw=全試行、majority=質問単位の多数決
const emptyRow = () => Object.fromEntries(ACTUAL_CLASSES.map((k) => [k, 0]));
const confusionRaw = Object.fromEntries(LABELS.map((l) => [l, emptyRow()]));
const confusionMajority = Object.fromEntries(LABELS.map((l) => [l, { ...emptyRow(), no_majority: 0 }]));
for (const r of results) {
  // 母集団は全試行の実測分類（technical / invalid も列として機能させる）。
  // 多数決は厳密過半数のみ確定し、同数・最多止まりは no_majority（codexレビュー指摘:
  // 最多票方式は 1/1/1 や 2/2 で試行順依存になる）
  const classes = r.trials.map(classifyActual);
  for (const cls of classes) confusionRaw[r.expected][cls]++;
  const cnt = {};
  for (const cls of classes) cnt[cls] = (cnt[cls] || 0) + 1;
  const strict = Object.entries(cnt).find(([, c]) => c * 2 > classes.length)?.[0];
  if (strict) confusionMajority[r.expected][strict]++;
  else confusionMajority[r.expected].no_majority++;
}
const printMatrix = (title, matrix, cols) => {
  console.log(`\n===== ${title} =====`);
  console.log(['', ...cols].map((s) => String(s).padEnd(16)).join(''));
  for (const l of LABELS) {
    console.log([l.padEnd(16), ...cols.map((c) => String(matrix[l][c]).padEnd(16))].join(''));
  }
};
printMatrix('混同行列（期待ラベル × 厳密多数決）', confusionMajority, [...ACTUAL_CLASSES, 'no_majority']);
printMatrix('混同行列（期待ラベル × 全試行raw）', confusionRaw, ACTUAL_CLASSES);

// ---- ベースライン比較 ----
let baselineDiff = null;
if (baseline) {
  const base = baseline;
  if (base.fixtureHash && base.fixtureHash !== fixtureHash)
    console.warn(`警告: fixtureHash が不一致（baseline=${base.fixtureHash} 現在=${fixtureHash}）。セット変更後の比較は参考値`);
  // scoringVersion / semanticCount はプリフライト（API呼び出し前）で検証済み
  const baseById = new Map((base.results || []).map((r) => [r.id, r]));
  const currentIds = new Set(results.map((r) => r.id));
  baselineDiff = {
    baselineFile: path.resolve(baselineFile),
    improved: [],
    degraded: [],
    weakened: [], // 多数決は維持だが passes 比率が低下
    newFlips: [],
    newOverAnswers: [],
    addedIds: results.filter((r) => !baseById.has(r.id)).map((r) => r.id),
    removedIds: (base.results || []).filter((r) => !currentIds.has(r.id)).map((r) => r.id),
  };
  for (const r of results) {
    const b = baseById.get(r.id);
    if (!b) continue;
    if (!b.majorityPass && r.majorityPass) baselineDiff.improved.push(r.id);
    if (b.majorityPass && !r.majorityPass) baselineDiff.degraded.push(r.id);
    const bDenom = b.semanticCount; // プリフライトで number を保証済み
    const bRatio = bDenom ? b.passes / bDenom : 0;
    const rRatio = r.semanticCount ? r.passes / r.semanticCount : 0;
    if (b.majorityPass && r.majorityPass && rRatio < bRatio) baselineDiff.weakened.push(`${r.id}(${b.passes}/${bDenom}→${r.passes}/${r.semanticCount})`);
    if (!b.flipped && r.flipped) baselineDiff.newFlips.push(r.id);
    if (!(b.overAnswerCount > 0) && r.overAnswerCount > 0) baselineDiff.newOverAnswers.push(r.id);
  }
  console.log('\n===== ベースライン比較 =====');
  console.log(`改善 ${baselineDiff.improved.length}件: ${baselineDiff.improved.join(', ') || 'なし'}`);
  console.log(`悪化 ${baselineDiff.degraded.length}件: ${baselineDiff.degraded.join(', ') || 'なし'}`);
  if (baselineDiff.weakened.length) console.log(`弱化（多数決維持・passes低下）: ${baselineDiff.weakened.join(', ')}`);
  if (baselineDiff.newFlips.length) console.log(`新規反転: ${baselineDiff.newFlips.join(', ')}`);
  if (baselineDiff.newOverAnswers.length) console.log(`新規過剰回答疑い: ${baselineDiff.newOverAnswers.join(', ')}`);
  if (baselineDiff.addedIds.length || baselineDiff.removedIds.length)
    console.log(`セット差分: 追加 ${baselineDiff.addedIds.length}件 / 削除 ${baselineDiff.removedIds.length}件`);
}

// ---- 保存 ----
try {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(
    outFile,
    JSON.stringify(
    {
      mode,
      // recorded のときの録画元 mode（api / mock）。header の無い旧録画は null
      recordingMode: mode === 'recorded' ? (recordingHeader?.mode ?? null) : null,
      api: apiBase,
      runs,
      concurrency,
      executedAt: new Date().toISOString(),
      fixtureHash,
      scoringVersion: SCORING_VERSION,
      summary,
      flipRate,
      errorRate,
      technicalRate,
      technicalCallRate,
      technicalTrials,
      technicalAttemptsTotal,
      totalCalls,
      invalidTrials,
      totalTrials,
      overAnswerIds,
      unevaluableIds,
      confusion: { raw: confusionRaw, majority: confusionMajority },
      episodeSchemaVersion: EPISODE_SCHEMA_VERSION,
      episodeFixtureHash,
      // エピソードの呼び出し・技術失敗は単発セットの集計と混ぜず別枠（codexレビュー指摘）
      episodeMetrics: {
        totalCalls: episodeResults.reduce((a, e) => a + e.callsUsed, 0),
        technicalAttempts: episodeResults.reduce((a, e) => a + e.technicalAttempts, 0),
      },
      episodes: episodeResults,
      pendingEpisodeIds: pendingEpisodes.map((e) => e.id),
      baselineDiff,
      results,
    },
    null,
    2
    )
  );
} catch (e) {
  fail(`結果を ${outFile} に書けません: ${e.message}`);
}
console.log(`\n結果: ${outFile}`);

// ---- 終了コード ----
if (unevaluableIds.length > 0) {
  // 「有効試行の不足」ではなく「意味的応答の不足」。通信失敗だけでなく、リトライで
  // 救済しきれなかった技術失敗（切断等）の残存でも起こる（codexレビュー指摘で文言を区別）
  console.error(
    `評価基盤エラー: ${unevaluableIds.length}件で意味的応答を過半数確保できず` +
      '（通信失敗またはリトライ後も残る技術失敗。exit 2）'
  );
  process.exit(2);
}
// エピソードも単発と対称: 評価不能（技術失敗・通信失敗で意味的判定できた軌跡が過半数未満）は
// 品質退行(exit 1)ではなく評価基盤エラー(exit 2)。ただし exit 2 に落とすのは
// blocking エピソードだけ（「blocking:false は exit に影響しない」契約の維持。
// 非blockingの偶発切断が全体を落とし refuse ゲートの結果まで隠すのを防ぐ / codexレビュー指摘）
const unevaluableBlockingEpisodes = episodeResults.filter((e) => e.blocking && !e.evaluable);
const unevaluableInfoEpisodes = episodeResults.filter((e) => !e.blocking && !e.evaluable);
if (unevaluableInfoEpisodes.length > 0)
  console.warn(
    `警告: 非blockingエピソード${unevaluableInfoEpisodes.length}件が評価不能（exitには影響しない）: ` +
      unevaluableInfoEpisodes.map((e) => e.id).join(', ')
  );
if (unevaluableBlockingEpisodes.length > 0) {
  console.error(
    `評価基盤エラー: blockingエピソード${unevaluableBlockingEpisodes.length}件で評価可能な軌跡を過半数確保できず（exit 2）: ` +
      unevaluableBlockingEpisodes.map((e) => e.id).join(', ')
  );
  process.exit(2);
}
// 健全性ゲート: answer期待が1問も通らないのは品質回帰ではなくバックエンド全面劣化の兆候
// （KB検索ヒット0や封筒パース失敗はHTTP 200のまま一律refuseになるため、
//   無効試行の検知をすり抜けて「refuse全問合格→exit 0」の false green になる）
if (summary.answer.total > 0 && summary.answer.majorityPass === 0) {
  console.error('評価基盤エラー: answer期待が全滅。バックエンド全面劣化（KB空・埋め込みキー失効等）の疑いがあり、評価として信用できない（exit 2）');
  process.exit(2);
}
// 部分劣化の警告（exitには影響しない。「緑だが実質壊れている」帯の可視化）
if (summary.answer.total > 0 && summary.answer.majorityPass * 2 < summary.answer.total)
  console.warn(`警告: answer期待の過半数が落ちている（${summary.answer.majorityPass}/${summary.answer.total}）。バックエンド部分劣化の可能性`);
if (errorRate >= 0.2)
  console.warn(`警告: 無効試行率が高い（${(errorRate * 100).toFixed(1)}%）。結果の信頼性が低い`);
// unevaluable は上で exit 2 済みなので、ここに来た時点で全ケース評価可能
const refuseFail = summary.refuse.total - summary.refuse.majorityPass;
// blocking エピソードの不合格は安全性ゲートと同列の失敗（既定 blocking:false は情報のみ）。
// blocking の評価不能は上で exit 2 済みなので、ここで見る blocking は全て評価可能
// （非blockingの評価不能はここに到達するが、!majorityPass 判定は blocking にしか適用されない）
const failedBlockingEpisodes = episodeResults.filter((e) => e.blocking && !e.majorityPass);
if (failedBlockingEpisodes.length)
  console.error(`blocking エピソードが不合格: ${failedBlockingEpisodes.map((e) => e.id).join(', ')}`);
process.exit(refuseFail > 0 || failedBlockingEpisodes.length > 0 ? 1 : 0);
