import type { FaqPorts } from '../ports/index.js';
import type {
  FaqAnswerGenerationPort,
  FaqGenerationRequest,
  FaqGenerationResult,
  FaqSmalltalkGenerationPort,
} from '../ports/generation.js';
import type {
  FaqRetrievalHints,
  FaqRetrievalPort,
  FaqRetrievalResult,
  FaqRetrievalTelemetry,
} from '../ports/retrieval.js';
import type {
  FaqAgentConfigPort,
  FaqAgentProfile,
  FaqChatSettings,
  FaqQaLogRecord,
  FaqStoragePort,
} from '../ports/storage.js';

/**
 * 'slow_empty' は指定ms待ってから空結果を返すだけ（= 遅い empty）。handler の time_budget 分岐は
 * context.getRemainingTimeInMillis で踏むので、本物の「タイムアウト」を模すものではない
 * （レビュー指摘で 'timeout' から改名）
 */
export type StubFaqRetrievalScenario = 'normal' | 'empty' | 'slow_empty' | 'throw';

/**
 * 文字列シナリオは代表的な固定ケース。任意の stop_reason / 本文を叩きたい場合はオブジェクト形を使う:
 * - stopReason が 'end_turn' なら text（省略時は既定 envelope）を返す。text が空文字なら production と同じく null
 * - stopReason が 'end_turn' 以外（'refusal' / 'pause_turn' / 'stop_sequence' / 未知）なら onStopReason 通知後に null
 * - stopReason が null なら onStopReason を呼ばず null（API障害相当）
 * 'slow_null' は指定ms待ってから null（= 遅い null）
 */
export type StubFaqGenerationScenario =
  | 'envelope'
  | 'null'
  | 'max_tokens'
  | 'invalid_json'
  | 'slow_null'
  | { stopReason: string | null; text?: string };

export interface StubFaqEntry {
  id: string;
  topic: string;
  canonicalUrl?: string;
  content: string;
}

export interface StubFaqPortsOptions {
  entries?: readonly StubFaqEntry[];
  /** Explicit null simulates a missing Settings row. */
  settings?: FaqChatSettings | null;
  /** Optional caller-owned sink used to inspect persisted Q&A records. */
  qaLogs?: FaqQaLogRecord[];
  /** stub resolverが返すnamed agentプロファイル。省略時はnamed agentなし。 */
  agentProfiles?: readonly FaqAgentProfile[];
  topN?: number;
  retrieval?: StubFaqRetrievalScenario;
  answerGeneration?: StubFaqGenerationScenario;
  smalltalkGeneration?: StubFaqGenerationScenario;
  /** jsonSchema 付きの呼出で onStructuredOutputFallback を発火させる（構造化出力の400→再試行経路の模擬） */
  simulateStructuredOutputFallback?: boolean;
  /** 雑談ガードへ注入する追加語彙（省略時なし） */
  guardBusinessTerms?: readonly string[];
  /** `envelope` シナリオで返す、FAQ envelope の JSON 文字列。 */
  envelope?: string;
  retrievalDelayMs?: number;
  answerGenerationDelayMs?: number;
  smalltalkGenerationDelayMs?: number;
}

export interface StubFaqRetrievalCall {
  question: string;
  hints?: FaqRetrievalHints | null;
  kbAgentId?: string;
}

export interface StubFaqRetrievalPort extends FaqRetrievalPort {
  readonly calls: StubFaqRetrievalCall[];
}

export interface StubFaqAnswerGenerationPort extends FaqAnswerGenerationPort {
  readonly calls: FaqGenerationRequest[];
}

export interface StubFaqSmalltalkGenerationPort extends FaqSmalltalkGenerationPort {
  readonly calls: FaqGenerationRequest[];
}

export interface StubFaqStoragePort extends FaqStoragePort {
  readonly qaLogs: FaqQaLogRecord[];
}

export interface StubFaqAgentConfigPort extends FaqAgentConfigPort {
  readonly calls: string[];
}

export interface StubFaqPorts extends FaqPorts {
  readonly retrieval: StubFaqRetrievalPort;
  readonly answerGeneration: StubFaqAnswerGenerationPort;
  readonly smalltalkGeneration: StubFaqSmalltalkGenerationPort;
  readonly storage: StubFaqStoragePort;
  readonly agentConfig: StubFaqAgentConfigPort;
  readonly defaultModel: 'stub-model';
}

export const DEFAULT_STUB_FAQ_ENVELOPE = JSON.stringify({
  responseType: 'answer',
  answer: 'スタブ回答です。',
  clarifyingQuestion: '',
  sourceRefs: ['K1'],
});

const DEFAULT_TOP_N = 3;
const DEFAULT_DELAY_MS = 10;
const STUB_INPUT_TOKENS = 11;
const STUB_OUTPUT_TOKENS = 7;

interface RankedStubEntry {
  entry: StubFaqEntry;
  originalIndex: number;
  score: number;
}

function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().trim();
}

function toNonNegativeInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : fallback;
}

function scoreEntry(question: string, entry: StubFaqEntry): number {
  const normalizedQuestion = normalize(question);
  if (normalizedQuestion.length === 0) return 0;

  const normalizedTopic = normalize(entry.topic);
  const searchable = `${normalizedTopic}\n${normalize(entry.content)}`;
  let score = 0;

  if (searchable.includes(normalizedQuestion)) {
    score += 1_000 + normalizedQuestion.length;
  }
  if (normalizedTopic.length > 0 && normalizedQuestion.includes(normalizedTopic)) {
    score += 500 + normalizedTopic.length;
  }

  for (const term of normalizedQuestion.split(/\s+/u)) {
    if (term.length > 1 && searchable.includes(term)) {
      score += term.length;
    }
  }
  return score;
}

function createTelemetry(
  allEntries: readonly StubFaqEntry[],
  candidates: readonly RankedStubEntry[],
  selected: readonly RankedStubEntry[]
): FaqRetrievalTelemetry {
  return {
    corpusRevision: 'stub-corpus-v1',
    retrievalRevision: 'stub-retrieval-v1',
    selectionRevision: 'stub-selection-v1',
    queryPlanRevision: null,
    chunkCount: selected.length,
    totalEntryCount: allEntries.length,
    totalChunkCount: allEntries.length,
    candidateCount: candidates.length,
    budgetSkippedCount: Math.max(0, candidates.length - selected.length),
    indexTruncated: candidates.length > selected.length,
    semanticUsed: false,
    semanticOnlySelectedCount: 0,
    semanticLaneSelectedEntryCount: 0,
    attenuatedLaneSelectedEntryCount: 0,
    attenuatedOnlySelectedEntryCount: 0,
    planUsed: false,
    planLexicalDroppedTermCount: 0,
    planLexicalRawTermCount: 0,
    planLexicalSelectedEntryCount: 0,
    planOnlySelectedEntryCount: 0,
    planOverlapSelectedEntryCount: 0,
    planSemanticEmbeddedQueryCount: 0,
    planSemanticQueryCount: 0,
    planSemanticSelectedEntryCount: 0,
    retrieverAlgorithmRevision: 'stub-v1',
    lexRankMode: 'lexical',
    selectedChunkLabels: selected.map(({ entry }) => `${entry.topic}#1/1`),
    selectedTopics: selected.map(({ entry }) => entry.topic),
    embeddedChunkRatio: 0,
    retrievalTrace: {
      metricCandidates: candidates.map(({ entry }, index) => ({
        t: entry.topic,
        p: '1/1',
        l: 'l',
        lex: index + 1,
        sem: null,
        rrf: null,
        r: index < selected.length ? null : 'entry_cap',
      })),
      metricSemanticBestRankByEntry: {},
    },
  };
}

function createEmptyRetrievalResult(entries: readonly StubFaqEntry[]): FaqRetrievalResult {
  return {
    block: '<knowledge_base></knowledge_base>',
    entryIdByRef: new Map(),
    entryById: new Map(),
    entryCount: 0,
    telemetry: createTelemetry(entries, [], []),
  };
}

function createNormalRetrievalResult(
  question: string,
  entries: readonly StubFaqEntry[],
  topN: number
): FaqRetrievalResult {
  const candidates = entries
    .map((entry, originalIndex) => ({
      entry,
      originalIndex,
      score: scoreEntry(question, entry),
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.originalIndex - right.originalIndex);
  const selected = candidates.slice(0, topN);
  const entryIdByRef = new Map<string, string>();
  const entryById = new Map<string, { topic: string; canonicalUrl?: string }>();

  selected.forEach(({ entry }, index) => {
    entryIdByRef.set(`K${index + 1}`, entry.id);
    entryById.set(entry.id, {
      topic: entry.topic,
      ...(entry.canonicalUrl === undefined ? {} : { canonicalUrl: entry.canonicalUrl }),
    });
  });

  const content = selected
    .map(({ entry }, index) => `[K${index + 1}] ${entry.topic}\n${entry.content}`)
    .join('\n\n');

  return {
    block:
      content.length === 0
        ? '<knowledge_base></knowledge_base>'
        : `<knowledge_base>\n${content}\n</knowledge_base>`,
    entryIdByRef,
    entryById,
    entryCount: selected.length,
    telemetry: createTelemetry(entries, candidates, selected),
  };
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function snapshotRequest(request: FaqGenerationRequest): FaqGenerationRequest {
  return {
    ...request,
    messages: request.messages.map((message) => ({ ...message })),
  };
}

/** production（llm-provider）と同じく観測コールバックの例外は握り潰す（契約差を作らない） */
function notifyStopReason(request: FaqGenerationRequest, stopReason: string | null): void {
  try {
    request.onStopReason?.(stopReason);
  } catch {
    // observation callback must not affect the generation result
  }
}

function notifyStructuredOutputFallback(request: FaqGenerationRequest): void {
  try {
    request.onStructuredOutputFallback?.();
  } catch {
    // observation callback must not affect the generation result
  }
}

async function runGenerationScenario(
  scenario: StubFaqGenerationScenario,
  request: FaqGenerationRequest,
  envelope: string,
  delayMs: number,
  simulateStructuredOutputFallback: boolean
): Promise<FaqGenerationResult | null> {
  if (simulateStructuredOutputFallback && request.jsonSchema !== undefined) {
    notifyStructuredOutputFallback(request);
  }
  if (typeof scenario === 'object') {
    if (scenario.stopReason === null) return null;
    notifyStopReason(request, scenario.stopReason);
    if (scenario.stopReason !== 'end_turn') return null;
    const text = scenario.text ?? envelope;
    // production は end_turn でも本文が空なら null を返す（llm-provider）
    if (text.length === 0) return null;
    return {
      text,
      inputTokens: STUB_INPUT_TOKENS,
      outputTokens: STUB_OUTPUT_TOKENS,
      stopReason: 'end_turn',
    };
  }
  if (scenario === 'null') return null;
  if (scenario === 'max_tokens') {
    notifyStopReason(request, 'max_tokens');
    return null;
  }
  if (scenario === 'slow_null') {
    await wait(delayMs);
    return null;
  }

  notifyStopReason(request, 'end_turn');
  return {
    text: scenario === 'invalid_json' ? 'this is not a FAQ envelope' : envelope,
    inputTokens: STUB_INPUT_TOKENS,
    outputTokens: STUB_OUTPUT_TOKENS,
    stopReason: 'end_turn',
  };
}

export function createStubFaqPorts(options: StubFaqPortsOptions = {}): StubFaqPorts {
  const entries = options.entries ?? [];
  const retrievalScenario = options.retrieval ?? 'normal';
  const answerScenario = options.answerGeneration ?? 'envelope';
  const smalltalkScenario = options.smalltalkGeneration ?? 'envelope';
  const simulateStructuredOutputFallback = options.simulateStructuredOutputFallback === true;
  const envelope = options.envelope ?? DEFAULT_STUB_FAQ_ENVELOPE;
  const topN = toNonNegativeInteger(options.topN, DEFAULT_TOP_N);
  const retrievalDelayMs = toNonNegativeInteger(options.retrievalDelayMs, DEFAULT_DELAY_MS);
  const answerDelayMs = toNonNegativeInteger(options.answerGenerationDelayMs, DEFAULT_DELAY_MS);
  const smalltalkDelayMs = toNonNegativeInteger(
    options.smalltalkGenerationDelayMs,
    DEFAULT_DELAY_MS
  );

  const retrievalCalls: StubFaqRetrievalCall[] = [];
  const answerCalls: FaqGenerationRequest[] = [];
  const smalltalkCalls: FaqGenerationRequest[] = [];
  const settings = options.settings === undefined ? { enabled: true } : options.settings;
  const qaLogs = options.qaLogs ?? [];
  const agentConfigCalls: string[] = [];
  const agentProfiles = new Map(
    (options.agentProfiles ?? []).map((profile) => [profile.agentId, profile] as const)
  );

  return {
    retrieval: {
      calls: retrievalCalls,
      async retrieve(input) {
        retrievalCalls.push({
          question: input.question,
          ...(input.hints === undefined ? {} : { hints: input.hints }),
          ...(input.kbAgentId === undefined ? {} : { kbAgentId: input.kbAgentId }),
        });
        if (retrievalScenario === 'throw') {
          throw new Error('Stub FAQ retrieval failure');
        }
        if (retrievalScenario === 'slow_empty') {
          await wait(retrievalDelayMs);
          return createEmptyRetrievalResult(entries);
        }
        if (retrievalScenario === 'empty') {
          return createEmptyRetrievalResult(entries);
        }
        return createNormalRetrievalResult(input.question, entries, topN);
      },
    },
    answerGeneration: {
      calls: answerCalls,
      async generate(request) {
        answerCalls.push(snapshotRequest(request));
        return runGenerationScenario(
          answerScenario,
          request,
          envelope,
          answerDelayMs,
          simulateStructuredOutputFallback
        );
      },
    },
    smalltalkGeneration: {
      calls: smalltalkCalls,
      async complete(request) {
        smalltalkCalls.push(snapshotRequest(request));
        return runGenerationScenario(
          smalltalkScenario,
          request,
          envelope,
          smalltalkDelayMs,
          simulateStructuredOutputFallback
        );
      },
    },
    answerPrompt: {
      buildSystemPrompt: (base, kbBlock) => `${base}\n${kbBlock}`,
    },
    storage: {
      qaLogs,
      async loadSettings() {
        return settings === null ? null : { ...settings };
      },
      async putQaLog(record) {
        qaLogs.push({ ...record, sources: [...record.sources] });
      },
    },
    agentConfig: {
      calls: agentConfigCalls,
      async resolveAgentProfile(agentId) {
        agentConfigCalls.push(agentId);
        const profile = agentProfiles.get(agentId);
        return profile === undefined ? null : { ...profile };
      },
    },
    defaultModel: 'stub-model',
    ...(options.guardBusinessTerms ? { guardVocabulary: { businessTerms: options.guardBusinessTerms } } : {}),
  };
}
