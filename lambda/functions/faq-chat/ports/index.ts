import type {
  FaqAnswerGenerationPort,
  FaqAnswerPromptPolicy,
  FaqSmalltalkGenerationPort,
} from './generation.js';
import type { FaqRetrievalPort } from './retrieval.js';
import type { FaqAgentConfigPort, FaqStoragePort } from './storage.js';

/**
 * 雑談ガードの決定的語彙（LLM が誤っても効く層）。handler の汎用語彙に**追加**される。
 * テナント/ベンダー固有の製品名（例: 自社製品名・旧ベンダー名）は公開ツリーに出せないため、
 * canonical の production adapter がここから注入し、公開 overlay / free は空にする（レビュー指摘）。
 * 比較は NFKC 正規化・小文字化した文字列への部分一致。
 */
export interface FaqGuardVocabulary {
  /**
   * 業務話題とみなす語。入力側の決定的フォールバック（has_business_topic）には全語が効く。
   * 生成済み雑談文の post-guard はラテン文字を先に reject するため、post-guard で意味を持つのは
   * カタカナ等の非ラテン語彙だけ
   */
  readonly businessTerms: readonly string[];
}

/** Complete dependency boundary consumed by the reusable HTTP handler. */
export interface FaqPorts {
  retrieval: FaqRetrievalPort;
  answerGeneration: FaqAnswerGenerationPort;
  smalltalkGeneration: FaqSmalltalkGenerationPort;
  answerPrompt: FaqAnswerPromptPolicy;
  storage: FaqStoragePort;
  /** compositionが有効なプロファイルを明示解決しない限りnamed agentは利用不可。 */
  agentConfig: FaqAgentConfigPort;
  defaultModel: string;
  /** 省略時は追加語彙なし（handler の汎用語彙のみ） */
  guardVocabulary?: FaqGuardVocabulary;
}
