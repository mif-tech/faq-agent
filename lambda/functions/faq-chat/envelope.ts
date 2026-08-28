/**
 * FAQ回答封筒（モデル出力のJSON契約）の型・スキーマ・パース・公開可否ガード。
 *
 * handler.ts から分離した純粋モジュール（I/O・環境依存なし）。分離の目的は
 * 決定的な単体テスト（lambda/tests/faq-chat-envelope.test.mjs）を可能にすること
 * （封筒は外部APIとモデルの間の契約であり、変更のたびに表形式で固定検証する / codexレビュー指摘）。
 *
 * 封筒v2（4型化・clarify/案内型の段階導入）:
 * - responseType: answer | clarify | scope_fallback | refuse
 * - null は使わず空文字センチネル（全フィールド必須の単純なwire形式を維持する設計判断）
 * - **モデルに渡すスキーマの enum は発動済みの型のみ**（現在 answer/refuse/scope_fallback。
 *   clarify は将来フェーズまで未発動）。4型は TypeScript 型とパーサーが先行対応し、
 *   発動時は MODEL_ENVELOPE_RESPONSE_TYPES に追加するだけでよい
 */

export type FaqEnvelopeResponseType = 'answer' | 'clarify' | 'scope_fallback' | 'refuse';

/** パーサー・型が受理する全型（サーバー側の防御的な受け皿） */
export const FAQ_ENVELOPE_RESPONSE_TYPES: readonly FaqEnvelopeResponseType[] = [
  'answer',
  'clarify',
  'scope_fallback',
  'refuse',
];

/** モデルに選択を許す型（structured outputs スキーマの enum）。発動済みの型だけを載せる。
 * scope_fallback は発動済み（範囲内だが資料不足。案内文はサーバーが合成し、
 *  モデルには文面を書かせない=引用ロンダリング回避 / codex設計）。clarify は将来フェーズまで未発動 */
export const MODEL_ENVELOPE_RESPONSE_TYPES: readonly FaqEnvelopeResponseType[] = [
  'answer',
  'refuse',
  'scope_fallback',
];

export interface FaqEnvelope {
  responseType: FaqEnvelopeResponseType;
  /** answer 型のみ非空 */
  answer: string;
  /** clarify 型のみ非空（発動まで常に空） */
  clarifyingQuestion: string;
  /** answer 型のみ非空 */
  sourceRefs: string[];
  /** 観測用: どの形式で受理したか（v1=旧 answerable 形式の写像 / v2=responseType 形式） */
  formatVersion: 'v1' | 'v2';
}

export const FAQ_ENVELOPE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    responseType: { type: 'string', enum: [...MODEL_ENVELOPE_RESPONSE_TYPES] },
    answer: { type: 'string' },
    clarifyingQuestion: { type: 'string' },
    sourceRefs: { type: 'array', items: { type: 'string' } },
  },
  required: ['responseType', 'answer', 'clarifyingQuestion', 'sourceRefs'],
  additionalProperties: false,
} satisfies Record<string, unknown>;

/** 回答本文に URL・リンク構文が含まれたら fail closed（出典は sources で返す設計） */
export function containsUrl(text: string): boolean {
  return /https?:\/\/|www\./i.test(text);
}

/**
 * モデル出力から JSON 封筒を取り出す（コードフェンスのみ許容）。
 * 出力**全体**が単一の JSON オブジェクトでなければ失敗にする（fail closed）。
 * 部分抽出（最初の '{' 〜 最後の '}'）は、KB/ユーザー由来の偽 JSON をモデルが引用した
 * 場合に偽封筒を掴む余地があるためやらない（codex レビュー指摘）。
 *
 * 形式判定: responseType キーが**存在する場合は必ずv2として厳格検証**し、不正なら失敗にする。
 * 旧形式 {answer, answerable, sourceRefs} へのフォールバックは responseType キー自体が
 * ない場合だけ（壊れたv2が旧形式として受理される fail-open を防ぐ / codexレビュー指摘）。
 */
export function parseEnvelope(text: string): FaqEnvelope | null {
  let candidate = text.trim();
  // 言語タグの表記揺れ（JSON/js等）を許容（parseStrictJsonObject と対称 / PRレビュー指摘）
  const fence = candidate.match(/^```[A-Za-z0-9]*\s*([\s\S]*?)```$/);
  if (fence) candidate = fence[1].trim();
  if (!candidate.startsWith('{') || !candidate.endsWith('}')) return null;
  try {
    const obj = JSON.parse(candidate) as Record<string, unknown>;
    let refs: unknown[] | null = null;
    if (Array.isArray(obj.sourceRefs)) {
      refs = obj.sourceRefs;
    } else if (Array.isArray(obj.sourceEntryIds)) {
      refs = obj.sourceEntryIds;
    }
    if ('responseType' in obj) {
      // fail-open防止の本体は responseType の妥当性検証。付随フィールドは
      // 「存在すれば型検証・無ければ安全な既定値」に緩める: スキーマなしフォールバック
      // （llm-provider の400再試行）で clarifyingQuestion 等が欠落しただけの意味的に完全な
      // 拒否を envelope_parse_failed（技術失敗・再試行案内）へ誤分類しない（codexレビュー指摘）
      if (
        typeof obj.responseType !== 'string' ||
        !(FAQ_ENVELOPE_RESPONSE_TYPES as readonly string[]).includes(obj.responseType)
      )
        return null;
      const responseType = obj.responseType as FaqEnvelopeResponseType;
      if ('clarifyingQuestion' in obj && typeof obj.clarifyingQuestion !== 'string') return null;
      const clarifyingQuestion = typeof obj.clarifyingQuestion === 'string' ? obj.clarifyingQuestion : '';
      // answer の欠落も同じ原則で緩和: answer 型では必須（封筒として壊れている）、
      // refuse/clarify/scope_fallback では常に空＝意味的に無負荷なので既定値 ''
      // （「空だから省く」はスキーマなしフォールバック時のモデルの現実的な挙動 / codexレビュー指摘）
      if ('answer' in obj && typeof obj.answer !== 'string') return null;
      if (responseType === 'answer' && typeof obj.answer !== 'string') return null;
      const answer = typeof obj.answer === 'string' ? obj.answer : '';
      // sourceRefs の欠落は refuse / scope_fallback で許容（どちらも出典検証を通らないため
      // 公開面に影響なし。スキーマなしフォールバックで省略されただけの意味的に完全な
      // 拒否/案内型を技術失敗に誤分類しない / codexレビュー指摘）。
      // answer / clarify で欠落したら封筒として壊れている＝従来どおりパース失敗
      if (refs === null && responseType !== 'refuse' && responseType !== 'scope_fallback') return null;
      return {
        responseType,
        answer,
        clarifyingQuestion,
        sourceRefs: (refs ?? []).filter((v): v is string => typeof v === 'string'),
        formatVersion: 'v2',
      };
    }
    // 旧形式（v1）は従来どおり answer / refs とも必須
    if (typeof obj.answer !== 'string') return null;
    if (refs === null) return null;
    if (typeof obj.answerable === 'boolean') {
      return {
        responseType: obj.answerable ? 'answer' : 'refuse',
        answer: obj.answer,
        clarifyingQuestion: '',
        sourceRefs: refs.filter((v): v is string => typeof v === 'string'),
        formatVersion: 'v1',
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Q&Aログ（v1）の保存前マスク。対象は**接触先PII（メールアドレス・電話番号）のみ**——
 * 氏名・住所はパターン化できないため対象外で、UI告知（入力しない案内+保存の明示）でカバーする。
 * 180日保持されるPIIの唯一の防波堤のため、handler.ts から分離して単体テストで固定する
 * （PRレビュー指摘: 非exportの複雑な正規表現が回帰検知なしで動いていた）。
 *
 * 検出方式:
 * - NFKC正規化で全角数字・全角ハイフン等を半角へ寄せてから照合（スマホIME入力対策）。
 *   **戻り値=保存本文も正規化後**になる（①→1・㈱→(株)等に書き換わり、後続sliceの切れ位置も
 *   変わる）。利用者の表記そのものが必要になったら検出用コピーと保存本文の分離を検討
 * - 電話3群形式は市外局番後に区切り必須+**総桁数10-11の検証**で、郵便番号（060-0042=7桁）・
 *   価格・日付を誤マスクしない。区切りは . スペース タブ 括弧 ハイフン類を0文字以上許容
 *   （090.1234.5678 / 090 - 1234 - 5678 等のすり抜け対策 / PRレビュー指摘）。
 *   **スラッシュは区切りに含めない**: URLパスの数値列（https://…/0120/123/456）が[電話番号]に
 *   化けて誤答分析の手がかりを壊すため（PRレビュー指摘）。090/1234/5678 のスラッシュ区切り
 *   電話は素通りする割り切り。改行も区切りに含めない（数値だけの複数行が1件に結合されるのを防ぐ）
 * - 区切りなしの連続形は0始まり10-11桁のみ。+81 国際表記は先頭0残し（+81 090-…）も拾う
 */
export function maskContactPii(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[メール]')
    .replace(/\+81[-ー‐.()（） \t]*\d(?:[-ー‐.()（） \t]*\d){8,10}/g, '[電話番号]')
    .replace(
      /(?<![0-9-])(?:[(（]0\d{1,4}[)）]|0\d{1,4}[-ー‐. \t])[-ー‐. \t]*\d{1,4}[-ー‐. \t]*\d{3,4}(?![0-9])/g,
      (m) => {
        const digitCount = m.replace(/\D/g, '').length;
        return digitCount === 10 || digitCount === 11 ? '[電話番号]' : m;
      }
    )
    .replace(/(?<![0-9-])0\d{9,10}(?![0-9-])/g, '[電話番号]');
}

export type FaqGuardDetail =
  | 'envelope_parse_failed'
  | 'model_answerable_false'
  | 'route_not_enabled'
  | 'scope_fallback_invalid'
  | 'empty_answer'
  | 'no_valid_source'
  | 'url_in_answer';

/** 公開可否ガードを従来の短絡評価と同じ順序で判定し、最初の拒否理由だけを返す。
 *  - model_answerable_false: モデルが responseType='refuse' を選んだ（旧 answerable=false と同義。
 *    メトリクスの継続性のため名前を維持）
 *  - route_not_enabled: モデルが未発動の型（clarify）を選んだ。スキーマの enum に載せていないため
 *    通常は到達不能だが、スキーマなしフォールバック時の防御として残す。
 *    技術失敗ではなく意味的拒否として扱う（retryable にしない: 曖昧質問の再送を促すと
 *    無理な回答への反転を誘発しうる / codexレビュー合意）
 * - scope_fallback（発動済み）: 全フィールドが空の正常形だけを有効（guardDetail=null）とする。
 *    answer・sourceRefs・clarifyingQuestion のいずれかが非空なら scope_fallback_invalid ＝
 *    「答えられる内容があるのに型だけ fallback にした」壊れた封筒として技術失敗（再試行で救済）に
 *    分類する。無条件にガードを迂回させると有効な部分回答を黙って捨てる（codexレビュー指摘）
 *  - refuse 時のクロスフィールド違反（answer 非空等）は失敗にしない: 外部レスポンスでは
 *    固定文言と空 sources に置換されるため漏洩せず、技術失敗に分類すると意味的拒否を
 *    envelope_invalid/retryable に誤分類してしまう（codexレビュー合意） */
export function getFaqGuardDetail(envelope: FaqEnvelope | null, validSourceCount: number): FaqGuardDetail | null {
  if (envelope === null) return 'envelope_parse_failed';
  if (envelope.responseType === 'refuse') return 'model_answerable_false';
  if (envelope.responseType === 'scope_fallback') {
    // 空判定は answer と揃えて trim（空白のみの clarifyingQuestion を不正扱いしない / codexレビュー指摘）
    return envelope.answer.trim() === '' && envelope.sourceRefs.length === 0 && envelope.clarifyingQuestion.trim() === ''
      ? null
      : 'scope_fallback_invalid';
  }
  if (envelope.responseType !== 'answer') return 'route_not_enabled';
  if (envelope.answer.trim().length === 0) return 'empty_answer';
  if (validSourceCount === 0) return 'no_valid_source';
  if (containsUrl(envelope.answer)) return 'url_in_answer';
  return null;
}
