import { createHash } from 'node:crypto';
import type {
  FaqRetrievalPort,
  FaqRetrievalResult,
  FaqRetrievalTelemetry,
} from '../../ports/retrieval.js';
import type { FaqKbEntry } from '../../ports/storage.js';

export type SimpleRetrievalEntry = FaqKbEntry;

export interface SimpleRetrievalOptions {
  loadEntries: (kbAgentId?: string) => Promise<SimpleRetrievalEntry[]>;
  topK?: number;
  maxCharsPerEntry?: number;
  cacheTtlMs?: number;
  cacheMaxEntries?: number;
}

interface CorpusEntry extends SimpleRetrievalEntry {
  searchableTokens: Set<string>;
  topicTokens: Set<string>;
}

interface LoadedCorpus {
  entries: CorpusEntry[];
  documentFrequency: Map<string, number>;
  revision: string;
}

interface RankedEntry {
  entry: CorpusEntry;
  score: number;
}

const DEFAULT_TOP_K = 5;
const DEFAULT_MAX_CHARS_PER_ENTRY = 1_500;
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_CACHE_MAX_ENTRIES = 64;
const RETRIEVER_ALGORITHM_REVISION = 'free-bigram-v1';
// メトリクス用トレースの上限と topic の無害化は production（shared/kb-injection.ts の
// METRIC_TRACE_LEX_SLOTS=20 / sanitizeTopicForIndex().slice(0, 30)）と同じ規則にする。
// bi-gram は照合が緩くほぼ全エントリが候補になるため、截断しないとログ行が KB 件数に比例して膨らむ
// （レビュー指摘）。shared は import せず値を写す
const METRIC_TRACE_SLOTS = 20;
const METRIC_TOPIC_CODEPOINTS = 30;

/** 制御文字と '<' を除去し 30 コードポイントに截断（production の sanitizeTopicForIndex().slice(0, 30) 相当） */
function metricTopicLabel(topic: string): string {
  return Array.from(topic.replace(/[\p{C}<]+/gu, ' '))
    .slice(0, METRIC_TOPIC_CODEPOINTS)
    .join('')
    .trim();
}

function toNonNegativeInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : fallback;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

/** Character bi-grams suit unsegmented Japanese; complete ASCII words are an extra lane. */
function tokenize(text: string): Set<string> {
  const normalized = normalize(text);
  const tokens = new Set<string>();
  for (const segment of normalized.match(/[\p{L}\p{N}]+/gu) ?? []) {
    const characters = Array.from(segment);
    for (let index = 0; index + 1 < characters.length; index += 1) {
      tokens.add(`b:${characters[index]}${characters[index + 1]}`);
    }
  }
  for (const word of normalized.match(/[a-z0-9]+/g) ?? []) {
    tokens.add(`w:${word}`);
  }
  return tokens;
}

// Query framing should not create a hit by itself. These polite/request phrases commonly
// occur in KB instructions too ("確認してください" etc.); keeping their bi-grams made an
// unrelated natural question rank entries even when its subject had no lexical overlap.
const QUERY_STOP_TOKENS = new Set(
  [
    'について',
    'に関して',
    '教えて',
    'おしえて',
    '知りたい',
    '知りたいです',
    '説明して',
    '案内して',
    'してください',
    'して下さい',
    'ください',
    '下さい',
    'お願いします',
    'です',
    'ですか',
    'ます',
    'ますか',
    'でしょうか',
  ].flatMap((phrase) => [...tokenize(phrase)])
);

function tokenizeQuestion(text: string): Set<string> {
  const tokens = tokenize(text);
  for (const token of QUERY_STOP_TOKENS) tokens.delete(token);
  return tokens;
}

function corpusRevision(entries: readonly SimpleRetrievalEntry[]): string {
  const serialized = JSON.stringify(
    entries.map((entry) => ({
      id: entry.id,
      topic: entry.topic,
      content: entry.content,
      ...(entry.canonicalUrl === undefined ? {} : { canonicalUrl: entry.canonicalUrl }),
    }))
  );
  return createHash('sha256').update(serialized, 'utf8').digest('hex').slice(0, 16);
}

function buildCorpus(loaded: SimpleRetrievalEntry[]): LoadedCorpus {
  const sorted = loaded
    .map((entry) => ({ ...entry }))
    .sort(
      (left, right) =>
        compareText(left.topic, right.topic) || compareText(left.id, right.id)
    );
  const entries: CorpusEntry[] = sorted.map((entry) => ({
    ...entry,
    searchableTokens: tokenize(`${entry.topic}\n${entry.content}`),
    topicTokens: tokenize(entry.topic),
  }));
  const documentFrequency = new Map<string, number>();
  for (const entry of entries) {
    for (const token of entry.searchableTokens) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  return {
    entries,
    documentFrequency,
    revision: corpusRevision(sorted),
  };
}

function scoreEntry(
  questionTokens: ReadonlySet<string>,
  entry: CorpusEntry,
  documentFrequency: ReadonlyMap<string, number>,
  documentCount: number
): number {
  let score = 0;
  for (const token of questionTokens) {
    if (!entry.searchableTokens.has(token)) continue;
    const frequency = documentFrequency.get(token) ?? documentCount;
    const idf = Math.log((documentCount + 1) / (frequency + 1)) + 1;
    score += token.startsWith('w:') ? idf * 1.25 : idf;
    if (entry.topicTokens.has(token)) score += idf * 0.25;
  }
  return score;
}

function truncateCharacters(text: string, maximum: number): string {
  return Array.from(text).slice(0, maximum).join('');
}

function serializeEntry(entry: CorpusEntry, ref: string, maximum: number): string {
  return JSON.stringify({
    ref,
    topic: entry.topic,
    content: truncateCharacters(entry.content, maximum),
  }).replace(/</g, '\\u003c');
}

function createTelemetry(
  corpus: LoadedCorpus,
  candidates: readonly RankedEntry[],
  selected: readonly RankedEntry[],
  topK: number,
  maxCharsPerEntry: number
): FaqRetrievalTelemetry {
  return {
    corpusRevision: corpus.revision,
    retrievalRevision: RETRIEVER_ALGORITHM_REVISION,
    selectionRevision: `${RETRIEVER_ALGORITHM_REVISION}:top${topK}:chars${maxCharsPerEntry}`,
    queryPlanRevision: null,
    chunkCount: selected.length,
    totalEntryCount: corpus.entries.length,
    totalChunkCount: corpus.entries.length,
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
    retrieverAlgorithmRevision: RETRIEVER_ALGORITHM_REVISION,
    lexRankMode: 'lexical',
    selectedChunkLabels: selected.map(({ entry }) => `${metricTopicLabel(entry.topic)}#1/1`),
    selectedTopics: selected.map(({ entry }) => metricTopicLabel(entry.topic)),
    embeddedChunkRatio: 0,
    retrievalTrace: {
      // 上位枠の外でも選択済みエントリは必ずトレースに載せる（production の lane 'x' と同じ不変条件）
      metricCandidates: candidates.slice(0, Math.max(METRIC_TRACE_SLOTS, selected.length)).map(({ entry }, index) => ({
        t: metricTopicLabel(entry.topic),
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

function toRetrievalResult(
  corpus: LoadedCorpus,
  question: string,
  topK: number,
  maxCharsPerEntry: number
): FaqRetrievalResult {
  const questionTokens = tokenizeQuestion(question);
  const candidates = corpus.entries
    .map((entry) => ({
      entry,
      score: scoreEntry(
        questionTokens,
        entry,
        corpus.documentFrequency,
        corpus.entries.length
      ),
    }))
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        compareText(left.entry.topic, right.entry.topic) ||
        compareText(left.entry.id, right.entry.id)
    );
  const selected = candidates.slice(0, topK);
  const entryIdByRef = new Map<string, string>();
  const entryById = new Map<string, { topic: string; canonicalUrl?: string }>();
  const lines = selected.map(({ entry }, index) => {
    const ref = `K${index + 1}`;
    entryIdByRef.set(ref, entry.id);
    entryById.set(entry.id, {
      topic: entry.topic,
      ...(entry.canonicalUrl === undefined ? {} : { canonicalUrl: entry.canonicalUrl }),
    });
    return serializeEntry(entry, ref, maxCharsPerEntry);
  });

  return {
    block:
      lines.length === 0
        ? '<knowledge_base>\n</knowledge_base>'
        : `<knowledge_base>\n${lines.join('\n')}\n</knowledge_base>`,
    entryIdByRef,
    entryById,
    entryCount: selected.length,
    telemetry: createTelemetry(corpus, candidates, selected, topK, maxCharsPerEntry),
  };
}

export function createSimpleRetrievalPort(options: SimpleRetrievalOptions): FaqRetrievalPort {
  const topK = toNonNegativeInteger(options.topK, DEFAULT_TOP_K);
  const maxCharsPerEntry = toNonNegativeInteger(
    options.maxCharsPerEntry,
    DEFAULT_MAX_CHARS_PER_ENTRY
  );
  const cacheTtlMs = toNonNegativeInteger(options.cacheTtlMs, DEFAULT_CACHE_TTL_MS);
  const cacheMaxEntries = Math.max(
    1,
    toNonNegativeInteger(options.cacheMaxEntries, DEFAULT_CACHE_MAX_ENTRIES)
  );
  const cachedByAgent = new Map<
    string | undefined,
    { corpus: LoadedCorpus; expiresAt: number }
  >();
  const loadingByAgent = new Map<string | undefined, Promise<LoadedCorpus>>();

  const pruneCachedCorpora = (now: number): void => {
    for (const [cachedAgentId, cached] of cachedByAgent) {
      if (cached.expiresAt <= now) cachedByAgent.delete(cachedAgentId);
    }
  };

  const cacheCorpus = (kbAgentId: string | undefined, corpus: LoadedCorpus): void => {
    pruneCachedCorpora(Date.now());
    while (cachedByAgent.size >= cacheMaxEntries) {
      const oldestAgentId = cachedByAgent.keys().next().value as string | undefined;
      if (oldestAgentId === undefined && !cachedByAgent.has(undefined)) break;
      cachedByAgent.delete(oldestAgentId);
    }
    cachedByAgent.set(kbAgentId, {
      corpus,
      expiresAt: Date.now() + cacheTtlMs,
    });
  };

  const loadCorpus = async (kbAgentId?: string): Promise<LoadedCorpus> => {
    const now = Date.now();
    if (cacheTtlMs > 0) pruneCachedCorpora(now);
    const cached = cachedByAgent.get(kbAgentId);
    if (cacheTtlMs > 0 && cached && now < cached.expiresAt) {
      // Mapの挿入順をLRU順として使う。default(undefined)も他agentと同じ1枠。
      cachedByAgent.delete(kbAgentId);
      cachedByAgent.set(kbAgentId, cached);
      return cached.corpus;
    }

    let loading = loadingByAgent.get(kbAgentId);
    if (!loading) {
      // default 経路では従来どおり引数なしで loader を呼び、named のときだけ scope を渡す。
      loading = (kbAgentId === undefined
        ? options.loadEntries()
        : options.loadEntries(kbAgentId)
      ).then(buildCorpus);
      loadingByAgent.set(kbAgentId, loading);
    }
    try {
      const corpus = await loading;
      if (cacheTtlMs > 0) {
        cacheCorpus(kbAgentId, corpus);
      }
      return corpus;
    } finally {
      if (loadingByAgent.get(kbAgentId) === loading) {
        loadingByAgent.delete(kbAgentId);
      }
    }
  };

  return {
    async retrieve({ question, kbAgentId }) {
      return toRetrievalResult(
        await loadCorpus(kbAgentId),
        question,
        topK,
        maxCharsPerEntry
      );
    },
  };
}
