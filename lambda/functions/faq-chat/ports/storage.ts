/**
 * Public FAQ storage boundaries.
 *
 * Keep these types independent from lambda/shared so the handler can be copied to the
 * public distribution without importing the canonical repository's internal data model.
 */

/** Settings value stored at Settings(key='faq_chat'). */
export interface FaqChatSettings {
  enabled: boolean;
  model?: string;
  systemPrompt?: string;
  fallbackMessage?: string;
  maxHistoryMessages?: number;
  maxMessageChars?: number;
  maxOutputTokens?: number;
  smalltalkMode?: string;
  scopeFallbackMessage?: string;
}

/** 既存FAQフローへ入る前に解決する公開named agentプロファイル。 */
export interface FaqAgentProfile {
  agentId: string;
  enabled: boolean;
  systemPrompt?: string;
  model?: string;
  maxOutputTokens?: number;
  fallbackMessage?: string;
  kbAgentId?: string;
  logPolicy?: 'off' | 'metadata_only' | 'redacted_full';
}

export interface FaqAgentConfigPort {
  resolveAgentProfile(agentId: string): Promise<FaqAgentProfile | null>;
}

/** Exact item written to the FAQ Q&A log table by the handler. */
export interface FaqQaLogRecord {
  dateBucket: string;
  ts: string;
  question: string;
  answer: string;
  responseType: string;
  route: string;
  scopeFallback: boolean;
  failureKind: string | null;
  guardDetail: string | null;
  sources: string[];
  model: string | null;
  totalMs: number | null;
  ttl: number;
}

export interface FaqStoragePort {
  loadSettings(): Promise<FaqChatSettings | null>;
  putQaLog(record: FaqQaLogRecord): Promise<void>;
}

/** Minimal public projection consumed by the free lexical retriever. */
export interface FaqKbEntry {
  id: string;
  topic: string;
  content: string;
  canonicalUrl?: string;
}

export interface FaqKbSourcePort {
  loadPublicEntries(kbAgentId?: string): Promise<FaqKbEntry[]>;
}
