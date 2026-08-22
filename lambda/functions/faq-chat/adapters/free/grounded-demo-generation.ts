import type {
  FaqAnswerGenerationPort,
  FaqGenerationRequest,
} from '../../ports/generation.js';

interface GroundedEntry {
  ref: string;
  content: string;
}

const DEMO_PREFIX = '【ローカル・キーワードモード（AI未使用）】';
const MAX_EXCERPT_CHARS = 300;

/**
 * 抜粋から URL を除去する。envelope.ts の containsUrl() ガード（/https?:\/\/|www\./i）は answer に
 * URL があると url_in_answer で scope_fallback に落とすため、KB 本文を逐語コピーするデモ回答は
 * 同じ規則で先に無害化する（出典は sources で返る / PR#124 レビュー指摘）
 */
// URL の許容文字は ASCII（RFC 3986 の unreserved/reserved）に限定する。\S ベースにすると
// 「詳細はhttps://example.com/hoursをご覧ください。」のようにスペースなしで日本語が続く KB 本文で
// URL 以降が行末まで消え、根拠文が黙って落ちる（PR#130 レビュー指摘）。
// 量指定子は * にして、裸のスキーム（"https:// をご覧ください"）や www. 直後が非 ASCII の場合も
// containsUrl() の /https?:\/\/|www\./i と厳密に同じ条件で除去する
const URL_CHARS = "[A-Za-z0-9\\-._~:/?#\\[\\]@!$&'()*+,;=%]*";
const HTTP_URL_PATTERN = new RegExp(`https?://${URL_CHARS}`, 'gi');
const WWW_URL_PATTERN = new RegExp(`www\\.${URL_CHARS}`, 'gi');

function stripUrls(text: string): string {
  return text
    .replace(HTTP_URL_PATTERN, '')
    .replace(WWW_URL_PATTERN, '')
    .replace(/[ \t]{2,}/gu, ' ')
    .trim();
}

function parseKnowledgeBase(system: string): GroundedEntry[] {
  const end = system.lastIndexOf('</knowledge_base>');
  const start = end < 0 ? -1 : system.lastIndexOf('<knowledge_base>', end);
  if (start < 0 || end < 0 || end < start) return [];
  const block = system.slice(start + '<knowledge_base>'.length, end);
  const entries: GroundedEntry[] = [];
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof parsed.ref === 'string' && typeof parsed.content === 'string') {
        entries.push({ ref: parsed.ref, content: parsed.content });
      }
    } catch {
      // Ignore non-JSON and malformed KB lines; only retrieval-produced JSON is trusted structurally.
    }
  }
  return entries;
}

function notifyEndTurn(request: FaqGenerationRequest): void {
  try {
    request.onStopReason?.('end_turn');
  } catch {
    // Observation only.
  }
}

export function createGroundedDemoGenerationPort(): FaqAnswerGenerationPort {
  return {
    supportsStructuredOutput: false,
    async generate(request) {
      const parsedFirst = parseKnowledgeBase(request.system)[0];
      // The free retriever always labels the first ranked entry K1. Fail closed if a caller
      // supplies a malformed block rather than emitting an answer with an unverifiable ref.
      const first = parsedFirst?.ref === 'K1' ? parsedFirst : undefined;
      const envelope = first
        ? {
            responseType: 'answer',
            answer: `${DEMO_PREFIX}\n${Array.from(stripUrls(first.content))
              .slice(0, MAX_EXCERPT_CHARS)
              .join('')}`,
            clarifyingQuestion: '',
            sourceRefs: ['K1'],
          }
        : {
            responseType: 'scope_fallback',
            answer: '',
            clarifyingQuestion: '',
            sourceRefs: [],
          };
      notifyEndTurn(request);
      return {
        text: JSON.stringify(envelope),
        inputTokens: 0,
        outputTokens: 0,
        stopReason: 'end_turn',
      };
    },
  };
}
