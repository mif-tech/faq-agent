#!/usr/bin/env node
/**
 * faq-chat 封筒契約の決定的単体テスト（レビュー承認条件）
 *
 * envelope.ts（純粋モジュール）を esbuild でその場コンパイルして node:test で検証する。
 * ネットワーク・AWS・環境変数に依存しない。
 *
 * 実行: cd lambda && node tests/faq-chat-envelope.test.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'functions', 'faq-chat', 'envelope.ts');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faq-envelope-test-'));
const outFile = path.join(outDir, 'envelope.mjs');
const esbuild = path.join(HERE, '..', 'node_modules', '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild');
execFileSync(esbuild, [SRC, '--format=esm', '--platform=node', `--outfile=${outFile}`], {
  stdio: 'inherit',
  // Windows の .cmd 実行に必要（Node 22 の spawn セキュリティ制約）
  shell: process.platform === 'win32',
});
const { parseEnvelope, getFaqGuardDetail, containsUrl, maskContactPii, FAQ_ENVELOPE_JSON_SCHEMA, MODEL_ENVELOPE_RESPONSE_TYPES } =
  await import(pathToFileURL(outFile).href);

// ---- parseEnvelope: 形式の受理・拒否（表形式） ----
const PARSE_CASES = [
  // [名前, 入力, 期待（nullか、主要フィールドの部分一致）]
  ['v2 answer', '{"responseType":"answer","answer":"A","clarifyingQuestion":"","sourceRefs":["K1"]}',
    { responseType: 'answer', answer: 'A', sourceRefs: ['K1'], formatVersion: 'v2' }],
  ['v2 refuse', '{"responseType":"refuse","answer":"","clarifyingQuestion":"","sourceRefs":[]}',
    { responseType: 'refuse', formatVersion: 'v2' }],
  ['v2 clarify（未発動でもパースは通る=ガード側で拒否）',
    '{"responseType":"clarify","answer":"","clarifyingQuestion":"どのプランですか","sourceRefs":[]}',
    { responseType: 'clarify', clarifyingQuestion: 'どのプランですか', formatVersion: 'v2' }],
  ['v2 scope_fallback', '{"responseType":"scope_fallback","answer":"","clarifyingQuestion":"","sourceRefs":[]}',
    { responseType: 'scope_fallback', formatVersion: 'v2' }],
  ['v1 answerable=true → answer 写像', '{"answer":"A","answerable":true,"sourceRefs":["K2"]}',
    { responseType: 'answer', answer: 'A', formatVersion: 'v1' }],
  ['v1 answerable=false → refuse 写像', '{"answer":"","answerable":false,"sourceRefs":[]}',
    { responseType: 'refuse', formatVersion: 'v1' }],
  ['v1 旧sourceEntryIds受理', '{"answer":"A","answerable":true,"sourceEntryIds":["K3"]}',
    { responseType: 'answer', sourceRefs: ['K3'], formatVersion: 'v1' }],
  ['コードフェンス許容', '```json\n{"responseType":"answer","answer":"A","clarifyingQuestion":"","sourceRefs":["K1"]}\n```',
    { responseType: 'answer', formatVersion: 'v2' }],
  // 欠落フィールドの緩和（存在すれば型検証・無ければ安全な既定値 / codexレビュー指摘:
  // スキーマなしフォールバックでの欠落を技術失敗=再試行案内に誤分類しない）
  ['v2 clarifyingQuestion欠落 → 既定値""（answer型）', '{"responseType":"answer","answer":"A","sourceRefs":["K1"]}',
    { responseType: 'answer', clarifyingQuestion: '', formatVersion: 'v2' }],
  ['v2 refuse は sourceRefs 欠落を許容（意味的に完全な拒否を技術失敗にしない）',
    '{"responseType":"refuse","answer":"","clarifyingQuestion":""}',
    { responseType: 'refuse', sourceRefs: [], formatVersion: 'v2' }],
  ['v2 refuse は answer 欠落も許容（非answer型では常に空＝意味的に無負荷）',
    '{"responseType":"refuse"}',
    { responseType: 'refuse', answer: '', sourceRefs: [], formatVersion: 'v2' }],
  ['v2 scope_fallback も sourceRefs/answer 欠落を許容（refuseと同じく出典検証を通らない）',
    '{"responseType":"scope_fallback"}',
    { responseType: 'scope_fallback', answer: '', sourceRefs: [], formatVersion: 'v2' }],
  // 拒否系
  ['壊れたv2は旧形式にフォールバックしない（responseTypeキーがあれば厳格検証）',
    '{"responseType":null,"answer":"A","answerable":true,"sourceRefs":["K1"]}', null],
  ['v2 未知のresponseType', '{"responseType":"maybe","answer":"A","clarifyingQuestion":"","sourceRefs":[]}', null],
  ['v2 clarifyingQuestion非string（存在時は型検証）', '{"responseType":"answer","answer":"A","clarifyingQuestion":1,"sourceRefs":["K1"]}', null],
  ['v2 answer型の sourceRefs 欠落はパース失敗（封筒として壊れている）',
    '{"responseType":"answer","answer":"A","clarifyingQuestion":""}', null],
  ['v2 answer型の answer 欠落はパース失敗', '{"responseType":"answer","sourceRefs":["K1"]}', null],
  ['answerable非boolean（旧形式としても不正）', '{"answer":"A","answerable":"yes","sourceRefs":[]}', null],
  ['v1 sourceRefs欠落はパース失敗（旧形式は従来どおり必須）', '{"answer":"A","answerable":true}', null],
  ['answer非string', '{"responseType":"answer","answer":1,"clarifyingQuestion":"","sourceRefs":[]}', null],
  ['JSON以外のテキスト混入（部分抽出しない）', '回答です {"responseType":"answer","answer":"A","clarifyingQuestion":"","sourceRefs":[]}', null],
  ['非JSON', 'すみません、わかりません', null],
];
for (const [name, input, expected] of PARSE_CASES) {
  test(`parseEnvelope: ${name}`, () => {
    const got = parseEnvelope(input);
    if (expected === null) {
      assert.equal(got, null);
    } else {
      assert.notEqual(got, null);
      for (const [k, v] of Object.entries(expected)) assert.deepEqual(got[k], v, `field ${k}`);
    }
  });
}

// ---- getFaqGuardDetail: ガード順序（表形式） ----
const env = (over) => ({
  responseType: 'answer',
  answer: '回答本文',
  clarifyingQuestion: '',
  sourceRefs: ['K1'],
  formatVersion: 'v2',
  ...over,
});
const GUARD_CASES = [
  ['正常', env({}), 1, null],
  ['封筒なし', null, 1, 'envelope_parse_failed'],
  ['refuse → model_answerable_false（メトリクス名の継続）', env({ responseType: 'refuse', answer: '' }), 0, 'model_answerable_false'],
  ['refuse はクロスフィールド違反でも意味的拒否のまま', env({ responseType: 'refuse', answer: '残った本文' }), 1, 'model_answerable_false'],
  ['clarify → route_not_enabled（発動まで拒否）', env({ responseType: 'clarify' }), 1, 'route_not_enabled'],
  // scope_fallback（発動済み）: 全フィールド空の正常形だけ有効（null）。
  // answer等が非空なら「答えられる内容があるのに型だけfallback」＝技術失敗で再試行に回す
  ['scope_fallback 正常形（全フィールド空）→ null',
    env({ responseType: 'scope_fallback', answer: '', sourceRefs: [], clarifyingQuestion: '' }), 0, null],
  ['scope_fallback + 非空answer → scope_fallback_invalid（回答を黙って捨てない）',
    env({ responseType: 'scope_fallback', sourceRefs: [], clarifyingQuestion: '' }), 0, 'scope_fallback_invalid'],
  ['scope_fallback + 非空sourceRefs → scope_fallback_invalid',
    env({ responseType: 'scope_fallback', answer: '', clarifyingQuestion: '' }), 0, 'scope_fallback_invalid'],
  ['scope_fallback + 非空clarifyingQuestion → scope_fallback_invalid',
    env({ responseType: 'scope_fallback', answer: '', sourceRefs: [], clarifyingQuestion: '何の件ですか' }), 0, 'scope_fallback_invalid'],
  ['scope_fallback の空白のみフィールドは正常形（trim統一）',
    env({ responseType: 'scope_fallback', answer: '  ', sourceRefs: [], clarifyingQuestion: ' ' }), 0, null],
  ['clarify は empty_answer より先に判定（誤分類防止）', env({ responseType: 'clarify', answer: '' }), 0, 'route_not_enabled'],
  ['空回答', env({ answer: '   ' }), 1, 'empty_answer'],
  ['有効出典ゼロ', env({}), 0, 'no_valid_source'],
  ['URL混入', env({ answer: '詳細は https://example.com へ' }), 1, 'url_in_answer'],
  ['ガード順: 空回答は出典ゼロより先', env({ answer: '' }), 0, 'empty_answer'],
];
for (const [name, envelope, validSourceCount, expected] of GUARD_CASES) {
  test(`getFaqGuardDetail: ${name}`, () => {
    assert.equal(getFaqGuardDetail(envelope, validSourceCount), expected);
  });
}

// ---- スキーマ契約 ----
test('スキーマのenumは発動済みの型のみ（answer/refuse/scope_fallback。clarifyは将来フェーズまで未発動）', () => {
  assert.deepEqual(FAQ_ENVELOPE_JSON_SCHEMA.properties.responseType.enum, ['answer', 'refuse', 'scope_fallback']);
  assert.deepEqual([...MODEL_ENVELOPE_RESPONSE_TYPES], ['answer', 'refuse', 'scope_fallback']);
});
test('スキーマは全フィールド必須・additionalProperties禁止', () => {
  assert.deepEqual(FAQ_ENVELOPE_JSON_SCHEMA.required, ['responseType', 'answer', 'clarifyingQuestion', 'sourceRefs']);
  assert.equal(FAQ_ENVELOPE_JSON_SCHEMA.additionalProperties, false);
});

// ---- containsUrl ----
test('containsUrl', () => {
  assert.equal(containsUrl('https://x.com'), true);
  assert.equal(containsUrl('WWW.example.com'), true);
  assert.equal(containsUrl('URLなし本文'), false);
});

// ---- maskContactPii: Q&Aログ保存前の接触先PIIマスク（v1）----
// 180日保持されるPIIの唯一の防波堤。期待値は**出力文字列の完全一致**で固定する
// （PRレビュー指摘: 「変わったか+トークン有無」のboolean判定は '[電話番号]8' のような
// 部分マスク=桁残りをPASSさせる。実際に+81 {8,9}で起きた失敗モード）。
// 非マスク系の期待値は NFKC 正規化後の入力そのもの
const MASK_CASES = [
  // [名前, 入力, 期待出力]
  ['携帯ハイフン', '090-1234-5678', '[電話番号]'],
  ['全角数字+全角ハイフン', '０９０－１２３４－５６７８', '[電話番号]'],
  ['スペース区切り', '03 1234 5678', '[電話番号]'],
  ['括弧市外局番', '(03)1234-5678', '[電話番号]'],
  ['全角括弧', '（０３）１２３４－５６７８', '[電話番号]'],
  ['ドット区切り', '090.1234.5678', '[電話番号]'],
  ['スペース+ハイフン混合区切り', '090 - 1234 - 5678', '[電話番号]'],
  ['+81国際表記', '+81 90-1234-5678', '[電話番号]'],
  ['+81で先頭0残し（末尾桁残りの回帰固定）', '+81 090-1234-5678', '[電話番号]'],
  ['連続11桁', '09012345678', '[電話番号]'],
  ['連続10桁', '0312345678', '[電話番号]'],
  ['フリーダイヤル', '0120-123-456', '[電話番号]'],
  ['文中の電話番号', '連絡先は090ー1234ー5678です', '連絡先は[電話番号]です'],
  ['メールアドレス', 'test@example.com', '[メール]'],
  ['文中のメール', '詳細はinfo@example.jpまで', '詳細は[メール]まで'],
  // 誤マスクしない系（桁数検証・構造検証で残す）
  ['郵便番号（7桁2群）', '〒060-0042', '〒060-0042'],
  ['価格カンマ区切り', '料金は10,000円です', '料金は10,000円です'],
  ['価格ドル', 'FLEX U25は$199です', 'FLEX U25は$199です'],
  ['日付', '2024-01-15', '2024-01-15'],
  ['営業時間', '営業時間は10:00-18:00です', '営業時間は10:00-18:00です'],
  ['頭金0円', '頭金0円です', '頭金0円です'],
  ['連続7桁（郵便番号ハイフンなし）', '0600042', '0600042'],
  // / を区切りに含めない割り切り（URLパスの数値列を[電話番号]に化けさせない設計判断）
  ['URLパスの数値列は化けない', 'https://ex.com/0120/123/456', 'https://ex.com/0120/123/456'],
  ['スラッシュ区切り電話は素通り（許容済みの限界）', '090/1234/5678', '090/1234/5678'],
  ['数値だけの複数行は結合しない', '0120\n1234\n5678', '0120\n1234\n5678'],
];
for (const [name, input, expected] of MASK_CASES) {
  test(`maskContactPii: ${name}`, () => {
    const out = maskContactPii(input);
    assert.equal(out, expected);
    // 共通ガード: マスク対象ケースに7桁以上の数字列（=電話番号の桁）が残っていないこと。
    // 完全一致に加えて置く理由は、将来ケースを足す人が期待値の書き間違いで
    // 部分マスクを緑にしてしまうのを防ぐため（非マスク系は期待値自体が桁を含むので対象外）
    if (/\[メール\]|\[電話番号\]/.test(expected)) {
      assert.doesNotMatch(out, /\d{7,}/, `PIIの桁が残っている: ${out}`);
    }
  });
}
test('maskContactPii: 保存本文はNFKC正規化後になる（仕様の固定）', () => {
  assert.equal(maskContactPii('①ＦＬＥＸ'), '1FLEX');
});
