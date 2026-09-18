export interface FaqRetrievalHints {
  lexicalTerms: string[];
  semanticQueries: string[];
}

export type FaqRetrievalTraceRejectionReason =
  | 'entry_cap'
  | 'chunk_cap'
  | 'char_budget'
  | 'per_entry_cap'
  | 'anchor_fail'
  | 'near_duplicate'
  | 'unknown';

export interface FaqRetrievalMetricCandidateTrace {
  t: string;
  p: string;
  l: 'l' | 's' | 'x';
  lex: number | null;
  sem: number | null;
  rrf: number | null;
  r: FaqRetrievalTraceRejectionReason | null;
}

export interface FaqRetrievalTrace {
  metricCandidates: FaqRetrievalMetricCandidateTrace[];
  metricSemanticBestRankByEntry: Record<string, number>;
}

export interface FaqRetrievalTelemetry {
  corpusRevision: string;
  retrievalRevision: string;
  selectionRevision: string;
  queryPlanRevision: string | null;
  chunkCount: number;
  totalEntryCount: number;
  totalChunkCount: number;
  candidateCount: number;
  budgetSkippedCount: number;
  indexTruncated: boolean;
  semanticUsed: boolean;
  semanticOnlySelectedCount: number;
  semanticLaneSelectedEntryCount: number;
  attenuatedLaneSelectedEntryCount: number;
  attenuatedOnlySelectedEntryCount: number;
  planUsed: boolean;
  planLexicalDroppedTermCount: number;
  planLexicalRawTermCount: number;
  planLexicalSelectedEntryCount: number;
  planOnlySelectedEntryCount: number;
  planOverlapSelectedEntryCount: number;
  planSemanticEmbeddedQueryCount: number;
  planSemanticQueryCount: number;
  planSemanticSelectedEntryCount: number;
  retrieverAlgorithmRevision: string;
  lexRankMode: 'hybrid' | 'lexical';
  selectedChunkLabels: string[];
  selectedTopics: string[];
  embeddedChunkRatio: number;
  retrievalTrace: FaqRetrievalTrace;
}

export interface FaqRetrievalEntry {
  topic: string;
  canonicalUrl?: string;
}

export interface FaqRetrievalResult {
  block: string;
  entryIdByRef: Map<string, string>;
  entryById: Map<string, FaqRetrievalEntry>;
  entryCount: number;
  telemetry: FaqRetrievalTelemetry;
}

export interface FaqRetrievalPort {
  retrieve(input: {
    question: string;
    hints?: FaqRetrievalHints | null;
    /** 後方互換のdefault FAQ経路では省略する。 */
    kbAgentId?: string;
  }): Promise<FaqRetrievalResult>;
}
