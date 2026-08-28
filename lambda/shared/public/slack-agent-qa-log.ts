/**
 * Slack エージェント Q&Aログの純粋な保存契約コア。
 *
 * 通知やtrust class固有の制約はedition側へ委ね、保存とgenerated -> posted更新だけを扱う。
 * public の FaqQaLogs/Streams workerとは接続せず、S3 archive経路は持たない。
 */

import { maskContactPii } from '../../functions/faq-chat/envelope.js';
import type {
  SlackAgentQaLogEntry,
  SlackAgentQaLogWriteOptions,
} from './slack-agent-contract.js';
import type {
  SlackAgentLogPolicy,
  SlackAgentQaLogSession,
  SlackQaLogPort,
} from './slack-agent-ports.js';

const SERVER_LOG_POLICY_OVERRIDES: Readonly<
  Partial<Record<string, SlackAgentLogPolicy>>
> = Object.freeze({});

const LOG_POLICY_RESTRICTIVENESS: Readonly<Record<SlackAgentLogPolicy, number>> = {
  off: 0,
  metadata_only: 1,
  redacted_full: 2,
};

export function resolveEffectiveAgentLogPolicy(
  trustClass: string,
  configuredPolicy: SlackAgentLogPolicy,
  overrides: Readonly<Partial<Record<string, SlackAgentLogPolicy>>> =
    SERVER_LOG_POLICY_OVERRIDES
): SlackAgentLogPolicy {
  const forced = Object.hasOwn(overrides, trustClass)
    ? overrides[trustClass]
    : undefined;
  if (!forced) return configuredPolicy;
  // server overrideは設定より制限を弱めない。off設定をfullへ戻す等は許可しない。
  return LOG_POLICY_RESTRICTIVENESS[forced] <
    LOG_POLICY_RESTRICTIVENESS[configuredPolicy]
    ? forced
    : configuredPolicy;
}

export interface SlackAgentQaLogBuildInput<TTrustClass extends string> {
  configuredPolicy: SlackAgentLogPolicy;
  /**
   * edition側のserver-side強制（policy portの qaLogPolicyOverrides）。省略時は強制なし。
   * 公開ファイルにはedition固有のtrust class名を書けないため、値は必ず注入で渡す。
   */
  logPolicyOverrides?: Readonly<Partial<Record<string, SlackAgentLogPolicy>>>;
  agentId: string;
  trustClass: TTrustClass;
  sourceEventId: string;
  teamId: string;
  channel: string;
  threadTs?: string;
  slackUserId: string;
  responseType: 'answer';
  /** ジョブ処理開始〜回答生成完了までのミリ秒。slack.postMessage の時間は含まない。 */
  latencyMs: number;
  createdAt: string;
  /** redacted_full のときだけ評価する。off/metadata_onlyでは呼ばない。 */
  buildFullContent: () => {
    question: string;
    answer: string;
    contextUserMessages: string[];
  };
}

/** policyを最初に確定し、本文を持つログobjectはredacted_fullでのみ構築する。 */
export function buildSlackAgentQaLogEntry<TTrustClass extends string>(
  input: SlackAgentQaLogBuildInput<TTrustClass>
): SlackAgentQaLogEntry<TTrustClass> | null {
  const logPolicy = resolveEffectiveAgentLogPolicy(
    input.trustClass,
    input.configuredPolicy,
    input.logPolicyOverrides ?? SERVER_LOG_POLICY_OVERRIDES
  );
  if (logPolicy === 'off') return null;

  const metadata = {
    agentId: input.agentId,
    trustClass: input.trustClass,
    sourceEventId: input.sourceEventId,
    teamId: input.teamId,
    channel: input.channel,
    ...(input.threadTs !== undefined ? { threadTs: input.threadTs } : {}),
    slackUserId: input.slackUserId,
    responseType: input.responseType,
    latencyMs: Math.max(0, Math.round(input.latencyMs)),
    deliveryStatus: 'generated' as const,
    createdAt: input.createdAt,
  };
  if (logPolicy === 'metadata_only') {
    return { ...metadata, logPolicy };
  }

  const fullContent = input.buildFullContent();
  return {
    ...metadata,
    logPolicy,
    question: maskContactPii(fullContent.question),
    answer: maskContactPii(fullContent.answer),
    contextUserMessages: fullContent.contextUserMessages.map(maskContactPii),
  };
}

/** offならwriterを一度も呼ばない。 */
export async function startSlackAgentQaLog<TTrustClass extends string>(
  input: SlackAgentQaLogBuildInput<TTrustClass>,
  writer: SlackQaLogPort<TTrustClass>,
  options?: SlackAgentQaLogWriteOptions
): Promise<SlackAgentQaLogSession<TTrustClass> | null> {
  const entry = buildSlackAgentQaLogEntry(input);
  if (!entry) return null;
  const { ref, skipped } = await writer.saveGenerated(entry, options);
  return { entry, ref, skipped };
}

export async function completeSlackAgentQaLog<TTrustClass extends string>(
  session: SlackAgentQaLogSession<TTrustClass> | null,
  slackMessageTs: string,
  postedAt: string,
  writer: SlackQaLogPort<TTrustClass>,
  options?: SlackAgentQaLogWriteOptions
): Promise<void> {
  // skipped = 既存行はposted済み。条件式（deliveryStatus=generated）で確定失敗するため呼ばない。
  if (!session || session.skipped) return;
  await writer.markPosted(
    {
      ref: session.ref,
      slackMessageTs,
      postedAt,
    },
    options
  );
}
