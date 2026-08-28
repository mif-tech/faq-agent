import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { SignatureV4 } from '@smithy/signature-v4';
import type {
  SlackIngressQueueMessage,
  SlackIngressQueuePort,
} from '../shared/public/slack-ingress-core.js';

interface SigningCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

type CredentialProvider = () => Promise<SigningCredentials>;
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface LiteSqsQueueOptions {
  region: string;
  fetch?: FetchLike;
  credentialsProvider?: CredentialProvider;
}

function validateQueueUrl(rawUrl: string): URL {
  let queueUrl: URL;
  try {
    queueUrl = new URL(rawUrl);
  } catch {
    throw new Error('Slack SQS queue URL must be an absolute URL');
  }
  if (
    queueUrl.protocol !== 'https:' ||
    queueUrl.username !== '' ||
    queueUrl.password !== '' ||
    queueUrl.search !== '' ||
    queueUrl.hash !== '' ||
    queueUrl.pathname === '/'
  ) {
    throw new Error('Slack SQS queue URL must be a credential-free HTTPS queue URL');
  }
  return queueUrl;
}

function requestBody(message: SlackIngressQueueMessage): string {
  return new URLSearchParams({
    Action: 'SendMessage',
    Version: '2012-11-05',
    MessageBody: message.MessageBody,
    MessageGroupId: message.MessageGroupId,
    MessageDeduplicationId: message.MessageDeduplicationId,
  }).toString();
}

/**
 * abortSignalの期限をpromiseへ適用する。下位のHTTP往復自体は中断できないが、
 * Slackの3秒ACK期限内に失敗を確定させる（credential endpointの詰まり対策）。
 */
function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  what: string
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error(`${what} aborted`));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(signal.reason instanceof Error ? signal.reason : new Error(`${what} aborted`));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

/** Minimal signed SQS Query API adapter; avoids adding an SDK package to the lite edition. */
export function createLiteSqsQueue(options: LiteSqsQueueOptions): SlackIngressQueuePort {
  const region = options.region.trim();
  if (!region || region !== options.region) {
    throw new Error('Slack SQS AWS region must be a non-empty trimmed value');
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Slack SQS requires global fetch');
  const credentialsProvider = options.credentialsProvider ?? defaultProvider();

  return {
    async send(message, sendOptions) {
      const queueUrl = validateQueueUrl(message.QueueUrl);
      const body = requestBody(message);
      // credential解決もenqueueタイムアウトの制御下に置く（正本のSDKクライアントが
      // signalをリクエスト全体へ適用するのと性質を揃える）。providerはadapter生存中
      // memoizeされるため、ウォーム時はここでHTTP往復しない。
      const credentials = await withAbort(
        credentialsProvider(),
        sendOptions.abortSignal,
        'SQS credential resolution'
      );
      const signer = new SignatureV4({
        credentials,
        region,
        service: 'sqs',
        sha256: Sha256,
      });
      const signed = await signer.sign({
        method: 'POST',
        protocol: queueUrl.protocol,
        hostname: queueUrl.hostname,
        ...(queueUrl.port === '' ? {} : { port: Number(queueUrl.port) }),
        path: queueUrl.pathname,
        query: {},
        headers: {
          accept: 'application/xml',
          'content-type': 'application/x-www-form-urlencoded',
          host: queueUrl.host,
        },
        body,
      });
      const response = await fetchImpl(queueUrl, {
        method: 'POST',
        headers: signed.headers,
        body,
        signal: sendOptions.abortSignal,
        redirect: 'manual',
      });
      if (!response.ok) {
        throw new Error(`SQS SendMessage failed with status ${response.status}`);
      }
    },
  };
}

// invocationごとの再生成を避けるregion別遅延シングルトン。defaultProvider の
// credential memoize をウォームコンテナ内で効かせる（レビュー指摘）。
const liteSqsQueueByRegion = new Map<string, SlackIngressQueuePort>();

export function getLiteSqsQueue(region: string): SlackIngressQueuePort {
  const existing = liteSqsQueueByRegion.get(region);
  if (existing) return existing;
  const created = createLiteSqsQueue({ region });
  liteSqsQueueByRegion.set(region, created);
  return created;
}
