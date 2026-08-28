/**
 * Slack エージェントの ingress -> SQS -> worker 契約。
 *
 * agentId / trustClass は署名検証済みの受信経路から ingress が設定する。
 * Slack payload 内の自己申告値を agentId として採用しない。
 */

import type { SlackAgentLogPolicy } from './slack-agent-ports.js';

export interface SlackAgentJob<TTrustClass extends string> {
  schemaVersion: 1;
  trustClass: TTrustClass;
  agentId: string;
  apiAppId: string;
  teamId: string;
  eventId: string;
  channel: string;
  channelType: string;
  user: string;
  text: string;
  ts: string;
  /** Slack event payloadの生thread_ts。トップレベル投稿では未設定。 */
  rawThreadTs?: string;
  /** 会話取得・返信先に使う実効thread ts（channelトップレベルではtsを補完）。 */
  threadTs?: string;
  receivedAt: string;
}

export type SlackAgentDeliveryStatus = 'generated' | 'posted';

/**
 * trust class 別 Q&A ログに共通するメタデータ。
 * off はログオブジェクト自体を作らないため、この契約には含めない。
 */
interface SlackAgentQaLogMetadata<TTrustClass extends string> {
  agentId: string;
  trustClass: TTrustClass;
  sourceEventId: string;
  teamId: string;
  channel: string;
  threadTs?: string;
  slackUserId: string;
  responseType: 'answer';
  latencyMs: number;
  deliveryStatus: 'generated';
  createdAt: string;
}

export type SlackAgentQaLogEntry<TTrustClass extends string> =
  | (SlackAgentQaLogMetadata<TTrustClass> & {
      logPolicy: Extract<SlackAgentLogPolicy, 'metadata_only'>;
    })
  | (SlackAgentQaLogMetadata<TTrustClass> & {
      logPolicy: Extract<SlackAgentLogPolicy, 'redacted_full'>;
      question: string;
      answer: string;
      contextUserMessages: string[];
    });

export interface SlackAgentQaLogRef<TTrustClass extends string> {
  agentId: string;
  trustClass: TTrustClass;
  sourceEventId: string;
}

export interface SlackAgentQaLogWriteOptions {
  /** 呼び出し側のタイムアウトで下位のDynamoDB呼び出しも実際に中断する（レビュー指摘）。 */
  abortSignal?: AbortSignal;
}

export interface SlackAgentQaLogSaveResult<TTrustClass extends string> {
  ref: SlackAgentQaLogRef<TTrustClass>;
  /**
   * true = 既存行がposted済みで書き込みをスキップした（lease切れ・markPosted失敗後の再実行）。
   * 呼び出し側は以降のmarkPosted・通知をスキップする（正常系でエラーメトリクスを立てない）。
   */
  skipped: boolean;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** SQS body を信頼せず、worker の環境境界と突き合わせる。 */
export function parseSlackAgentJob<TTrustClass extends string>(
  rawBody: string,
  expected: { agentId: string; trustClass: TTrustClass }
): SlackAgentJob<TTrustClass> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new Error('Slack agent job is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Slack agent job must be an object');
  }

  const candidate = parsed as Record<string, unknown>;
  const requiredStrings = [
    'agentId',
    'trustClass',
    'apiAppId',
    'teamId',
    'eventId',
    'channel',
    'channelType',
    'user',
    'text',
    'ts',
    'receivedAt',
  ] as const;
  for (const field of requiredStrings) {
    if (!isNonEmptyString(candidate[field])) {
      throw new Error(`Slack agent job field ${field} must be a non-empty string`);
    }
  }
  if (candidate.schemaVersion !== 1) {
    throw new Error('Unsupported Slack agent job schemaVersion');
  }
  if (candidate.agentId !== expected.agentId || candidate.trustClass !== expected.trustClass) {
    throw new Error('Slack agent job does not match the worker trust boundary');
  }
  if (candidate.threadTs !== undefined && !isNonEmptyString(candidate.threadTs)) {
    throw new Error('Slack agent job field threadTs must be a non-empty string when present');
  }
  if (candidate.rawThreadTs !== undefined && !isNonEmptyString(candidate.rawThreadTs)) {
    throw new Error('Slack agent job field rawThreadTs must be a non-empty string when present');
  }

  const receivedAt = new Date(candidate.receivedAt as string);
  if (Number.isNaN(receivedAt.getTime())) {
    throw new Error('Slack agent job field receivedAt must be an ISO date');
  }

  return candidate as unknown as SlackAgentJob<TTrustClass>;
}
