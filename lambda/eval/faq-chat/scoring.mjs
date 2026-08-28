/**
 * 採点の純粋ロジック（run-eval.mjs から分離）。
 * 分離の目的は refuse / scope_fallback の4象限を決定的テストで固定すること
 * （lambda/tests/faq-chat-eval-scoring.test.mjs / codexレビュー承認条件）。
 */

/** APIが返しうる transport レベルの responseType */
export const VALID_RESPONSE_TYPES = new Set(['kb_answer', 'refuse', 'chat']);

// 実測分類の列。scope_fallback は独立の transport 型ではなく
// 「refuse + scopeFallback:true の直交フラグ」の派生クラス（codex設計）
export const ACTUAL_CLASSES = [...VALID_RESPONSE_TYPES, 'scope_fallback', 'technical', 'invalid'];

/** 技術失敗（生成未完了・時間切れ等）の refuse か。意味的拒否と分離して投票から外す。
 *  model_refusal（モデル/ポリシー拒否）は意味的な拒否として投票に参加させる。
 *  なお eval は本体の retryable フラグを意図的に見ない: 本体の retryable は「ユーザーに再試行を
 *  促すか」の UI 契約で、eval の関心は「意味的応答が得られたか」 */
export function isTechnicalTrial(t) {
  return t.responseType === 'refuse' && t.failureKind != null && t.failureKind !== 'model_refusal';
}

/** 試行の実測分類（混同行列・エピソード採点・単発passOfで使う） */
export function classifyActual(t) {
  if (t.invalid) return 'invalid';
  if (isTechnicalTrial(t)) return 'technical';
  if (t.responseType === 'refuse' && t.scopeFallback) return 'scope_fallback';
  return t.responseType;
}

/** 1有効試行が期待ラベルに適合するか。cls は classifyActual の派生クラス。
 *  refuse と scope_fallback は厳密に区別する（4象限 / codexレビュー指摘:
 *  transportレベルで比較すると scope_fallback gold が永遠に合格できないか、
 *  refuse gold が flagged refuse でも合格してしまう） */
export function passOf(expected, cls) {
  if (expected === 'refuse') return cls === 'refuse';
  if (expected === 'scope_fallback') return cls === 'scope_fallback';
  if (expected === 'clarify') return true; // 有効応答ならどちらでも合格
  return cls === 'kb_answer'; // answer / partial
}
