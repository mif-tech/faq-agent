export interface FaqGenerationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface FaqGenerationRequest {
  system: string;
  messages: FaqGenerationMessage[];
  model: string;
  maxTokens: number;
  // 未指定は production adapter 側（callClaudeFaq）の既定 FAQ_TIMEOUT_MS に委ねる
  timeoutMs?: number;
  temperature?: number;
  jsonSchema?: Record<string, unknown>;
  onStopReason?: (reason: string | null) => void;
  onStructuredOutputFallback?: () => void;
}

export interface FaqGenerationResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
}

export interface FaqAnswerPromptPolicy {
  buildSystemPrompt(base: string, kbBlock: string): string;
}

export interface FaqAnswerGenerationPort {
  generate(request: FaqGenerationRequest): Promise<FaqGenerationResult | null>;
  /**
   * この実装が `jsonSchema`（構造化出力）を実際にプロバイダへ渡すか。省略時は true（互換）。
   * handler はモデル名の allowlist と **AND** で判定し、false なら jsonSchema を渡さず
   * `structured_output_used=false` を記録する。フリー版の汎用 adapter は jsonSchema を使わないため
   * false（さもないと allowlist 該当モデルで偽陽性が出て eval 比較が歪む / レビュー指摘）
   */
  readonly supportsStructuredOutput?: boolean;
}

export interface FaqSmalltalkGenerationPort {
  complete(request: FaqGenerationRequest): Promise<FaqGenerationResult | null>;
  /** 回答ポートと同じ意味（ルーター段の jsonSchema 付与と router_structured_output_used の判定に AND で効く）。省略時 true */
  readonly supportsStructuredOutput?: boolean;
}
