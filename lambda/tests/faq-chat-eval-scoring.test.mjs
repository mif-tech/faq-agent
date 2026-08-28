#!/usr/bin/env node
/**
 * eval採点ロジックの決定的テスト（レビュー承認条件）。
 * 特に refuse / scope_fallback の4象限を固定する。
 * 実行: cd lambda && npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyActual, passOf, isTechnicalTrial, ACTUAL_CLASSES } from '../eval/faq-chat/scoring.mjs';

const trial = (over) => ({ invalid: false, responseType: 'refuse', failureKind: null, scopeFallback: false, ...over });

// ---- classifyActual ----
const CLASSIFY_CASES = [
  ['無効試行', trial({ invalid: true }), 'invalid'],
  ['技術失敗（切断）', trial({ failureKind: 'generation_incomplete' }), 'technical'],
  ['技術失敗（封筒不正）', trial({ failureKind: 'envelope_invalid' }), 'technical'],
  ['model_refusal は意味的拒否', trial({ failureKind: 'model_refusal' }), 'refuse'],
  ['素の refuse', trial({}), 'refuse'],
  ['refuse + scopeFallback → 派生クラス scope_fallback', trial({ scopeFallback: true }), 'scope_fallback'],
  ['kb_answer', trial({ responseType: 'kb_answer' }), 'kb_answer'],
  ['kb_answer は scopeFallback フラグがあっても kb_answer（フラグは refuse にのみ意味を持つ）',
    trial({ responseType: 'kb_answer', scopeFallback: true }), 'kb_answer'],
  ['chat', trial({ responseType: 'chat' }), 'chat'],
];
for (const [name, t, expected] of CLASSIFY_CASES) {
  test(`classifyActual: ${name}`, () => assert.equal(classifyActual(t), expected));
}

// ---- passOf 4象限（refuse / scope_fallback の厳密区別） ----
test('passOf: refuse gold × 素のrefuse = pass', () => assert.equal(passOf('refuse', 'refuse'), true));
test('passOf: refuse gold × scope_fallback = fail（丁寧な非回答でも拒否goldは保護）', () =>
  assert.equal(passOf('refuse', 'scope_fallback'), false));
test('passOf: scope_fallback gold × 素のrefuse = fail', () => assert.equal(passOf('scope_fallback', 'refuse'), false));
test('passOf: scope_fallback gold × scope_fallback = pass', () =>
  assert.equal(passOf('scope_fallback', 'scope_fallback'), true));

// ---- passOf その他 ----
test('passOf: answer gold は kb_answer のみ合格', () => {
  assert.equal(passOf('answer', 'kb_answer'), true);
  assert.equal(passOf('answer', 'refuse'), false);
  assert.equal(passOf('answer', 'scope_fallback'), false);
  assert.equal(passOf('partial', 'kb_answer'), true);
  assert.equal(passOf('partial', 'scope_fallback'), false);
});
test('passOf: clarify gold は有効応答ならどれでも合格', () => {
  assert.equal(passOf('clarify', 'kb_answer'), true);
  assert.equal(passOf('clarify', 'refuse'), true);
  assert.equal(passOf('clarify', 'scope_fallback'), true);
});

// ---- isTechnicalTrial 契約 ----
test('isTechnicalTrial: failureKind の有無と model_refusal 例外', () => {
  assert.equal(isTechnicalTrial(trial({})), false);
  assert.equal(isTechnicalTrial(trial({ failureKind: 'time_budget' })), true);
  assert.equal(isTechnicalTrial(trial({ failureKind: 'model_refusal' })), false);
});

// ---- 列契約 ----
test('ACTUAL_CLASSES に scope_fallback / technical / invalid が含まれる', () => {
  for (const c of ['kb_answer', 'refuse', 'chat', 'scope_fallback', 'technical', 'invalid'])
    assert.ok(ACTUAL_CLASSES.includes(c), c);
});
