/**
 * Slack エージェント worker が edition 間で共有する汎用 port 契約。
 *
 * edition 固有の repository・LLM・Q&Aログ・trust policy は composition root で
 * 必ず注入する。policy を optional hook にしないことで、未構成時は fail closed にする。
 */

import type {
  SlackAgentJob,
  SlackAgentQaLogEntry,
  SlackAgentQaLogRef,
  SlackAgentQaLogSaveResult,
  SlackAgentQaLogWriteOptions,
} from './slack-agent-contract.js';

export type SlackAgentAccess = 'public' | 'internal';
export type SlackAgentEmbeddingPolicy = 'enabled' | 'disabled';
export type SlackAgentLogPolicy = 'off' | 'metadata_only' | 'redacted_full';

export interface SlackAgentQaLogNotificationConfig {
  enabled: boolean;
  channelId?: string;
}

/** worker が参照する項目だけに正規化した AgentConfig。 */
export interface SlackAgentResolvedConfig<TTrustClass extends string = string> {
  agentId: string;
  trustClass: TTrustClass;
  access: SlackAgentAccess;
  model: string;
  maxOutputTokens: number;
  systemPrompt: string;
  logPolicy: SlackAgentLogPolicy;
  embeddingPolicy: SlackAgentEmbeddingPolicy;
  kbTable: string;
  qaLogTable: string;
  enabled: boolean;
  qaLogNotification?: SlackAgentQaLogNotificationConfig;
}

/**
 * 保存済み設定は実行境界との照合前なので、trustClass は string のまま返す。
 * PolicyPort の boundary assert が edition の型へ絞り込む。
 */
export interface SlackAgentConfigPort {
  resolve(agentId: string): Promise<SlackAgentResolvedConfig | null>;
}

export type SlackKbInjectionStrategy = 'query' | 'full';

export interface SlackKbLoadInput<TTrustClass extends string> {
  agentId: string;
  trustClass: TTrustClass;
  embeddingPolicy: SlackAgentEmbeddingPolicy;
  question: string;
  strategy: SlackKbInjectionStrategy;
}

export interface SlackKbInjection {
  /** 完全な<knowledge_base> block。worker 側で二重にタグを付けない。 */
  block: string;
  sourceIds: string[];
}

export interface SlackKbPort<TTrustClass extends string> {
  load(input: SlackKbLoadInput<TTrustClass>): Promise<SlackKbInjection>;
}

export interface SlackGenerationMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** 現行 callClaudeFaq と同じ request 粒度。 */
export interface SlackGenerationRequest {
  system: string;
  messages: SlackGenerationMessage[];
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  onStopReason?: (stopReason: string | null) => void;
  temperature?: number;
  jsonSchema?: Record<string, unknown>;
  onStructuredOutputFallback?: () => void;
}

/** 現行 callClaudeFaq と同じ null / completion 契約。 */
export interface SlackGenerationResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
}

export interface SlackGenerationPort {
  generate(request: SlackGenerationRequest): Promise<SlackGenerationResult | null>;
}

/** Q&Aログの保存・状態更新契約。 */
export interface SlackQaLogPort<TTrustClass extends string> {
  saveGenerated(
    entry: SlackAgentQaLogEntry<TTrustClass>,
    options?: SlackAgentQaLogWriteOptions
  ): Promise<SlackAgentQaLogSaveResult<TTrustClass>>;
  markPosted(
    input: {
      ref: SlackAgentQaLogRef<TTrustClass>;
      slackMessageTs: string;
      postedAt: string;
    },
    options?: SlackAgentQaLogWriteOptions
  ): Promise<void>;
}

export interface SlackAgentQaLogSession<TTrustClass extends string> {
  entry: SlackAgentQaLogEntry<TTrustClass>;
  ref: SlackAgentQaLogRef<TTrustClass>;
  /** true = 既存行がposted済み。markPosted・通知も行わない。 */
  skipped: boolean;
}

export interface SlackAgentRuntimeBoundary<TTrustClass extends string> {
  agentId: string;
  trustClass: TTrustClass;
  kbTableName: string;
  qaLogTableName: string;
}

export type SlackAgentJobPolicyDecision = 'process' | 'ack';

/**
 * policyのboundary assertが「無効化されたagent」を示すために投げる終端エラー。
 * worker coreは error.name === 'SlackAgentDisabledError' でこれを識別し、
 * retry/DLQ/利用者向けエラー投稿にせず警告メトリクス付きでACKする。
 * 両editionのpolicyはこのclassを使うこと（nameによる識別はworker側の判定実装であって、
 * nameだけ合わせた別Errorを新たに作る根拠にしない）。
 */
export class SlackAgentDisabledError extends Error {
  constructor(agentId: string) {
    super(`Slack agent ${agentId} is disabled`);
    this.name = 'SlackAgentDisabledError';
  }
}

/**
 * trust class 固有の検査・分岐。全メソッドを必須にして fail-open を防ぐ。
 * 許容 trust class 集合の source of truth は isTrustClass のみ（集合の二重定義を避ける）。
 */
export interface SlackAgentPolicyPort<TTrustClass extends string> {
  isTrustClass(value: string): value is TTrustClass;
  /**
   * server-sideのQ&AログlogPolicy強制（設定より制限を弱めない方向にのみ効く）。
   * edition固有のtrust classへの強制はこのmapで注入する（公開コアの
   * resolveEffectiveAgentLogPolicy が消費 / レビュー指摘）。
   */
  readonly qaLogPolicyOverrides: Readonly<Partial<Record<TTrustClass, SlackAgentLogPolicy>>>;
  inspectJob(job: SlackAgentJob<TTrustClass>): SlackAgentJobPolicyDecision;
  assertAgentConfigBoundary(
    config: SlackAgentResolvedConfig | null,
    runtime: SlackAgentRuntimeBoundary<TTrustClass>
  ): asserts config is SlackAgentResolvedConfig<TTrustClass>;
  selectKbInjectionStrategy(trustClass: TTrustClass): SlackKbInjectionStrategy;
  canSendQaLogNotification(config: SlackAgentResolvedConfig<TTrustClass>): boolean;
  sendQaLogNotification(input: {
    session: SlackAgentQaLogSession<TTrustClass> | null;
    notification: SlackAgentQaLogNotificationConfig | undefined;
    slackMessageTs: string;
    send: (message: { channel: string; text: string }) => Promise<void>;
  }): Promise<boolean>;
}

export interface SlackAgentPorts<TTrustClass extends string> {
  config: SlackAgentConfigPort;
  kb: SlackKbPort<TTrustClass>;
  generation: SlackGenerationPort;
  qaLog: SlackQaLogPort<TTrustClass>;
  policy: SlackAgentPolicyPort<TTrustClass>;
}
