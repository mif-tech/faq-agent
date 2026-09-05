import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  runSlackIngress,
  type SlackIngressRuntimeConfig,
} from '../../shared/public/slack-ingress-core.js';
import { getLiteSqsQueue } from '../../shared-lite/slack-sqs.js';
import type { SlackIngressQueuePort } from '../../shared/public/slack-ingress-core.js';

type LiteSlackTrustClass = 'slack';

interface IngressEnvironment {
  runtime: SlackIngressRuntimeConfig<LiteSlackTrustClass>;
  region: string;
}

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`[slack-ingress] ${name} is required`);
  return value;
}

export function isLiteSlackTrustClass(value: string): value is LiteSlackTrustClass {
  return value === 'slack';
}

export function requiresLiteSlackDirectMessage(
  _trustClass: LiteSlackTrustClass
): boolean {
  void _trustClass;
  return false;
}

export function loadIngressEnvironment(): IngressEnvironment {
  const trustClass = requiredEnv('TRUST_CLASS');
  if (!isLiteSlackTrustClass(trustClass)) {
    throw new Error('[slack-ingress] TRUST_CLASS must be slack');
  }
  const allowedChannelIds = new Set(
    requiredEnv('ALLOWED_CHANNEL_IDS')
      .split(',')
      .map((channel) => channel.trim())
      .filter(Boolean)
  );
  if (allowedChannelIds.size === 0) {
    throw new Error('[slack-ingress] ALLOWED_CHANNEL_IDS must list at least one channel');
  }

  return {
    runtime: {
      agentId: requiredEnv('AGENT_ID'),
      trustClass,
      isTrustClass: isLiteSlackTrustClass,
      requiresDirectMessage: requiresLiteSlackDirectMessage,
      signingSecret: requiredEnv('SLACK_SIGNING_SECRET'),
      expectedAppId: requiredEnv('EXPECTED_API_APP_ID'),
      expectedTeamId: requiredEnv('EXPECTED_TEAM_ID'),
      expectedBotUserId: requiredEnv('EXPECTED_BOT_USER_ID'),
      allowedChannelIds,
      queueUrl: requiredEnv('SLACK_EVENT_QUEUE_URL'),
    },
    region: requiredEnv('AWS_REGION'),
  };
}

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  let environment: IngressEnvironment;
  let queue: SlackIngressQueuePort;
  try {
    environment = loadIngressEnvironment();
    // region別の遅延シングルトン。invocationごとにcredential providerを作り直さない
    //（構成エラーは従来どおり503で返す / レビュー指摘）。
    queue = getLiteSqsQueue(environment.region);
  } catch (error) {
    console.error(
      JSON.stringify({
        metric: 'slack_ingress_configuration_error',
        error: error instanceof Error ? error.message : 'Unknown',
      })
    );
    return jsonResponse(503, { error: 'Slack ingress is not configured' });
  }

  return runSlackIngress(event, environment.runtime, queue);
}
