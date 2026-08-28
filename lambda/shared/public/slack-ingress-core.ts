/** Slack Events API ingress の edition 共有コア。 */

import { createHash } from 'node:crypto';
import type { SlackAgentJob } from './slack-agent-contract.js';
import { verifyAndValidateSlackRequest } from './slack-verify.js';

export interface SlackIngressRuntimeConfig<TTrustClass extends string> {
  agentId: string;
  trustClass: TTrustClass;
  isTrustClass: (value: string) => value is TTrustClass;
  requiresDirectMessage: (trustClass: TTrustClass) => boolean;
  signingSecret: string;
  expectedAppId: string;
  expectedTeamId: string;
  expectedBotUserId: string;
  allowedChannelIds: ReadonlySet<string>;
  queueUrl: string;
}

export interface SlackIngressHttpEvent {
  body?: string | null;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined | null>;
}

export interface SlackIngressHttpResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export interface SlackIngressQueueMessage {
  QueueUrl: string;
  MessageBody: string;
  MessageGroupId: string;
  MessageDeduplicationId: string;
}

export interface SlackIngressQueuePort {
  send(
    message: SlackIngressQueueMessage,
    options: { abortSignal: AbortSignal }
  ): Promise<unknown>;
}

// Slackの3秒期限内に失敗を確定し、非2xxでSlack再送へ委ねる。
const ENQUEUE_TIMEOUT_MS = 1_800;

function jsonResponse(statusCode: number, body: unknown): SlackIngressHttpResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function effectiveThreadKey(input: {
  channelType: string;
  channel: string;
  ts: string;
  threadTs?: string;
}): string {
  if (input.threadTs) return `${input.channel}:${input.threadTs}`;
  // スレッドなしDMはDM全体を1会話として直列化する。
  if (input.channelType === 'im') return `${input.channel}:dm`;
  // チャンネルのトップレベルmentionはevent tsを新規スレッドキーにする。
  return `${input.channel}:${input.ts}`;
}

async function enqueue<TTrustClass extends string>(
  job: SlackAgentJob<TTrustClass>,
  queueUrl: string,
  queue: SlackIngressQueuePort
): Promise<void> {
  const groupId = sha256(
    effectiveThreadKey({
      channelType: job.channelType,
      channel: job.channel,
      ts: job.ts,
      ...(job.threadTs ? { threadTs: job.threadTs } : {}),
    })
  );
  const deduplicationId = sha256(`${job.trustClass}:${job.teamId}:${job.eventId}`);
  await queue.send(
    {
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(job),
      MessageGroupId: groupId,
      MessageDeduplicationId: deduplicationId,
    },
    { abortSignal: AbortSignal.timeout(ENQUEUE_TIMEOUT_MS) }
  );
}

function rejectedStatus(stage: 'signature' | 'payload' | 'event', reason: string): number {
  // secret未設定は構成ミスであり「無効な署名」ではない。Slack側の誤診断を避けるため503。
  if (reason === 'missing_signing_secret') return 503;
  if (stage === 'signature') return 401;
  if (reason === 'app_id_mismatch' || reason === 'team_id_mismatch') return 403;
  return 400;
}

export async function runSlackIngress<TTrustClass extends string>(
  event: SlackIngressHttpEvent,
  runtime: SlackIngressRuntimeConfig<TTrustClass>,
  queue: SlackIngressQueuePort
): Promise<SlackIngressHttpResult> {
  const validation = verifyAndValidateSlackRequest(
    {
      body: event.body,
      isBase64Encoded: event.isBase64Encoded,
      headers: event.headers,
    },
    runtime.signingSecret,
    {
      trustClass: runtime.trustClass,
      isTrustClass: runtime.isTrustClass,
      requiresDirectMessage: runtime.requiresDirectMessage,
      expectedAppId: runtime.expectedAppId,
      expectedTeamId: runtime.expectedTeamId,
      expectedBotUserId: runtime.expectedBotUserId,
      allowedChannelIds: runtime.allowedChannelIds,
    }
  );

  if (!validation.ok) {
    if (validation.ignored) {
      console.log(
        JSON.stringify({
          metric: 'slack_ingress_ignored',
          agentId: runtime.agentId,
          trustClass: runtime.trustClass,
          reason: validation.reason,
        })
      );
      return jsonResponse(200, { ok: true, ignored: true });
    }
    console.warn(
      JSON.stringify({
        metric: 'slack_ingress_rejected',
        agentId: runtime.agentId,
        trustClass: runtime.trustClass,
        stage: validation.stage,
        reason: validation.reason,
      })
    );
    return jsonResponse(rejectedStatus(validation.stage, validation.reason), {
      error: 'Slack request rejected',
    });
  }

  if (validation.kind === 'url_verification') {
    return jsonResponse(200, { challenge: validation.challenge });
  }

  const slackEvent = validation.event;
  // メンション文字しかない投稿は回答対象外。署名済み対象外イベントとしてACKし再送させない。
  if (
    slackEvent.text.replaceAll(`<@${runtime.expectedBotUserId}>`, '').trim().length === 0
  ) {
    return jsonResponse(200, { ok: true, ignored: true });
  }

  const channelType = slackEvent.channel_type ?? 'channel';
  const conversationThreadTs =
    slackEvent.thread_ts ?? (channelType === 'im' ? undefined : slackEvent.ts);
  const job: SlackAgentJob<TTrustClass> = {
    schemaVersion: 1,
    trustClass: runtime.trustClass,
    agentId: runtime.agentId,
    apiAppId: validation.envelope.api_app_id,
    teamId: validation.envelope.team_id,
    eventId: validation.envelope.event_id,
    channel: slackEvent.channel,
    channelType,
    user: slackEvent.user,
    text: slackEvent.text,
    ts: slackEvent.ts,
    ...(slackEvent.thread_ts ? { rawThreadTs: slackEvent.thread_ts } : {}),
    ...(conversationThreadTs ? { threadTs: conversationThreadTs } : {}),
    receivedAt: new Date().toISOString(),
  };

  try {
    await enqueue(job, runtime.queueUrl, queue);
  } catch (error) {
    console.error(
      JSON.stringify({
        metric: 'slack_ingress_enqueue_failed',
        agentId: runtime.agentId,
        trustClass: runtime.trustClass,
        sourceEventId: job.eventId,
        error: error instanceof Error ? error.name : 'Unknown',
      })
    );
    // 2xxにしない。Slack Events APIの再送が durable retry の入口になる。
    return jsonResponse(503, { error: 'Slack event was not enqueued' });
  }

  return jsonResponse(200, { ok: true });
}
