import { Sha256 } from '@aws-crypto/sha256-js';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { SignatureV4 } from '@smithy/signature-v4';
import type {
  FaqRagErrorResponse,
  FaqRagGenerateRequest,
  FaqRagGenerateResponse,
  FaqRagPort,
  FaqRagRetrieveRequest,
  FaqRagRetrieveResponse,
} from '../../ports/rag.js';
import {
  FAQ_RAG_CONTRACT_VERSION,
  RemoteContractValidationError,
  parseRemoteV1GenerateRequest,
  parseRemoteV1GenerateResponse,
  parseRemoteV1RetrieveRequest,
  parseRemoteV1RetrieveResponse,
} from './contract.js';

const EXECUTE_API_SERVICE = 'execute-api';
const ASSUME_ROLE_SESSION_NAME = 'faq-remote-rag-client';
const DEFAULT_ABORT_SAFETY_MARGIN_MS = 100;
const DEFAULT_CREDENTIAL_REFRESH_WINDOW_MS = 60_000;
const RETRIEVE_BACKOFF_MS = [100, 300] as const;
const RETRIEVE_JITTER_MS = [50, 100] as const;

type RemoteOperation = 'retrieve' | 'generate';

interface SigningCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

type CredentialProvider = () => Promise<SigningCredentials>;
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface AssumeRoleInput {
  region: string;
  roleArn: string;
  externalId?: string;
  sourceCredentials: CredentialProvider;
}

type AssumeRole = (input: AssumeRoleInput) => Promise<SigningCredentials>;

export interface RemoteFaqRagHttpClientOptions {
  /** Defaults to process.env. Intended for deterministic composition/tests. */
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
  /** Source credentials for direct signing or for STS AssumeRole. */
  credentialsProvider?: CredentialProvider;
  /** Test seam; production uses STS AssumeRole. */
  assumeRole?: AssumeRole;
  abortSafetyMarginMs?: number;
  credentialRefreshWindowMs?: number;
}

interface RemoteConfig {
  baseUrl: string;
  region: string;
  roleArn?: string;
  externalId?: string;
}

interface AttemptResult<T> {
  response: T;
  retry: boolean;
  retryAfterMs?: number;
}

function technicalError(
  code: 'deadline_exceeded' | 'retrieval_failed' | 'generation_failed'
): FaqRagErrorResponse {
  return {
    contractVersion: FAQ_RAG_CONTRACT_VERSION,
    ok: false,
    error: { code, retryable: true },
  };
}

function invalidContractError(): FaqRagErrorResponse {
  return {
    contractVersion: FAQ_RAG_CONTRACT_VERSION,
    ok: false,
    error: { code: 'invalid_contract', retryable: false },
  };
}

function failConfiguration(field: string, reason: string): never {
  throw new Error(`Invalid remote FAQ RAG configuration: ${field} ${reason}`);
}

function readConfig(env: Readonly<Record<string, string | undefined>>): RemoteConfig {
  const rawBaseUrl = env.FAQ_REMOTE_RAG_BASE_URL;
  if (rawBaseUrl === undefined || rawBaseUrl.trim() === '') {
    return failConfiguration('FAQ_REMOTE_RAG_BASE_URL', 'is required');
  }
  if (rawBaseUrl !== rawBaseUrl.trim()) {
    return failConfiguration('FAQ_REMOTE_RAG_BASE_URL', 'must not contain surrounding whitespace');
  }

  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(rawBaseUrl);
  } catch {
    return failConfiguration('FAQ_REMOTE_RAG_BASE_URL', 'must be an absolute URL');
  }
  if (parsedBaseUrl.protocol !== 'https:') {
    return failConfiguration('FAQ_REMOTE_RAG_BASE_URL', 'must use https');
  }
  if (
    parsedBaseUrl.username !== '' ||
    parsedBaseUrl.password !== '' ||
    parsedBaseUrl.search !== '' ||
    parsedBaseUrl.hash !== ''
  ) {
    return failConfiguration(
      'FAQ_REMOTE_RAG_BASE_URL',
      'must not contain credentials, a query, or a fragment'
    );
  }

  const region = env.AWS_REGION;
  if (region === undefined || region.trim() === '') {
    return failConfiguration('AWS_REGION', 'is required');
  }
  if (region !== region.trim()) {
    return failConfiguration('AWS_REGION', 'must not contain surrounding whitespace');
  }

  // 署名 region は AWS_REGION（この Lambda 自身の region）。base URL が execute-api の標準ホスト
  // 形式ならその region と突き合わせ、不一致を config 時に落とす。別 region の API を設定すると
  // 全リクエストが SigV4 署名不一致で 403 → retrieval_failed → fallback に写像され、設定ミスと
  // 区別できなくなるため fail-fast する（B2 レビュー指摘1。custom domain は region を推定できず対象外）。
  const executeApiHost = /^[^.]+\.execute-api\.([^.]+)\.amazonaws\.com$/.exec(
    parsedBaseUrl.hostname
  );
  if (executeApiHost !== null && executeApiHost[1] !== region) {
    return failConfiguration(
      'FAQ_REMOTE_RAG_BASE_URL',
      `host region (${executeApiHost[1]}) must match AWS_REGION (${region})`
    );
  }

  const configuredRoleArn = env.FAQ_REMOTE_RAG_ROLE_ARN;
  let roleArn: string | undefined;
  if (configuredRoleArn !== undefined && configuredRoleArn !== '') {
    if (
      configuredRoleArn !== configuredRoleArn.trim() ||
      !/^arn:[^:\s]+:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(configuredRoleArn)
    ) {
      return failConfiguration('FAQ_REMOTE_RAG_ROLE_ARN', 'must be an IAM role ARN');
    }
    roleArn = configuredRoleArn;
  }

  const configuredExternalId = env.FAQ_REMOTE_RAG_EXTERNAL_ID;
  let externalId: string | undefined;
  if (configuredExternalId !== undefined && configuredExternalId !== '') {
    // STS AssumeRole の ExternalId 実仕様は 2〜1224 文字・[\w+=,.@:/-]。ここで落とさないと
    // role 作成は通るのに実行時の AssumeRole が必ず ValidationError になる（レビュー）
    if (!/^[A-Za-z0-9_+=,.@:/-]{2,1224}$/.test(configuredExternalId)) {
      return failConfiguration(
        'FAQ_REMOTE_RAG_EXTERNAL_ID',
        'must be 2-1224 characters of [A-Za-z0-9_+=,.@:/-]'
      );
    }
    externalId = configuredExternalId;
  }
  if (externalId !== undefined && roleArn === undefined) {
    return failConfiguration(
      'FAQ_REMOTE_RAG_EXTERNAL_ID',
      'requires FAQ_REMOTE_RAG_ROLE_ARN'
    );
  }

  // Store the base without trailing slashes so operation paths have one separator.
  parsedBaseUrl.pathname = parsedBaseUrl.pathname.replace(/\/+$/, '');
  return {
    baseUrl: parsedBaseUrl.href.replace(/\/$/, ''),
    region,
    ...(roleArn === undefined ? {} : { roleArn }),
    ...(externalId === undefined ? {} : { externalId }),
  };
}

function validateNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function defaultAssumeRole({
  region,
  roleArn,
  externalId,
  sourceCredentials,
}: AssumeRoleInput): Promise<SigningCredentials> {
  const client = new STSClient({ region, credentials: sourceCredentials });
  const output = await client.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: ASSUME_ROLE_SESSION_NAME,
      ...(externalId === undefined ? {} : { ExternalId: externalId }),
    })
  );
  const credentials = output.Credentials;
  if (
    credentials?.AccessKeyId === undefined ||
    credentials.SecretAccessKey === undefined ||
    credentials.SessionToken === undefined ||
    credentials.Expiration === undefined
  ) {
    throw new Error('STS AssumeRole returned incomplete credentials');
  }
  return {
    accessKeyId: credentials.AccessKeyId,
    secretAccessKey: credentials.SecretAccessKey,
    sessionToken: credentials.SessionToken,
    expiration: credentials.Expiration,
  };
}

function createAssumedCredentialProvider(options: {
  assumeRole: AssumeRole;
  input: AssumeRoleInput;
  now: () => number;
  refreshWindowMs: number;
}): CredentialProvider {
  let cached: SigningCredentials | undefined;
  let inFlight: Promise<SigningCredentials> | undefined;

  return async () => {
    const cachedExpiration = cached?.expiration?.getTime();
    if (
      cached !== undefined &&
      cachedExpiration !== undefined &&
      Number.isFinite(cachedExpiration) &&
      cachedExpiration - options.refreshWindowMs > options.now()
    ) {
      return cached;
    }
    if (inFlight !== undefined) return inFlight;

    inFlight = options
      .assumeRole(options.input)
      .then((credentials) => {
        const expirationMs = credentials.expiration?.getTime();
        if (
          credentials.accessKeyId === '' ||
          credentials.secretAccessKey === '' ||
          credentials.sessionToken === undefined ||
          credentials.sessionToken === '' ||
          expirationMs === undefined ||
          !Number.isFinite(expirationMs) ||
          expirationMs <= options.now()
        ) {
          throw new Error('STS AssumeRole returned invalid credentials');
        }
        cached = credentials;
        return credentials;
      })
      .catch((error: unknown) => {
        const cachedExpiration = cached?.expiration?.getTime();
        if (
          cached !== undefined &&
          cachedExpiration !== undefined &&
          Number.isFinite(cachedExpiration) &&
          cachedExpiration > options.now()
        ) {
          // 成功扱いで無音だと、STS が失敗し続けてもキャッシュ失効まで無症状になる。
          // 予兆として旗だけ残す（role ARN・エラー本文は出さない）
          console.warn(
            '[remote-v1] client assume_role_refresh_failed fallback=cached_credentials'
          );
          return cached;
        }
        throw error;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
}

function contractField(error: unknown, fallback: string): string {
  return error instanceof RemoteContractValidationError ? error.field : fallback;
}

function logContractViolation(
  operation: RemoteOperation,
  direction: 'request' | 'response',
  field: string,
  status?: number
): void {
  const statusField = status === undefined ? '' : ` status=${status}`;
  // Deliberately log only classification metadata. Request/response values stay private.
  console.error(
    `[remote-v1] client invalid_contract operation=${operation} direction=${direction} field=${field}${statusField}`
  );
}

function logTransportFailure(
  operation: RemoteOperation,
  code: 'retrieval_failed' | 'generation_failed',
  status?: number
): void {
  const statusField = status === undefined ? '' : ` status=${status}`;
  console.error(`[remote-v1] client failure operation=${operation} code=${code}${statusField}`);
}

function logServerContractFallback(
  operation: RemoteOperation,
  field: string,
  status: number,
  code: 'retrieval_failed' | 'generation_failed'
): void {
  console.error(
    `[remote-v1] client server_contract_violation operation=${operation} field=${field} status=${status} code=${code}`
  );
}

function operationUrl(baseUrl: string, operation: RemoteOperation): URL {
  return new URL(`${baseUrl}/v1/${operation}`);
}

function requestForSigning(url: URL, body: string) {
  return {
    method: 'POST',
    protocol: url.protocol,
    hostname: url.hostname,
    ...(url.port === '' ? {} : { port: Number(url.port) }),
    path: url.pathname,
    query: {},
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      host: url.host,
    },
    body,
  };
}

function isHttpSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function isAuthenticationOrServerFailure(status: number): boolean {
  return status === 401 || status === 403 || status >= 500;
}

function retrieveDtoRetryDelay(response: FaqRagRetrieveResponse): number | undefined {
  if (response.ok) return undefined;
  if (response.error.code === 'retrieval_failed') return 0;
  if (response.error.code === 'quota_exceeded') return response.error.retryAfterMs;
  // kill_switch and deadline_exceeded are retryable by a later workflow, but an immediate
  // in-request retry is not useful. no_match/invalid_contract are explicitly final.
  return undefined;
}

/**
 * Build the SigV4 HTTP implementation of the managed FAQ RAG boundary.
 *
 * Configuration is read and validated synchronously so selecting the remote profile fails fast.
 */
export function createRemoteFaqRagHttpClient(
  options: RemoteFaqRagHttpClientOptions = {}
): FaqRagPort {
  const config = readConfig(options.env ?? process.env);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Remote FAQ RAG requires global fetch');
  }
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const abortSafetyMarginMs = validateNonNegativeInteger(
    options.abortSafetyMarginMs ?? DEFAULT_ABORT_SAFETY_MARGIN_MS,
    'abortSafetyMarginMs'
  );
  const credentialRefreshWindowMs = validateNonNegativeInteger(
    options.credentialRefreshWindowMs ?? DEFAULT_CREDENTIAL_REFRESH_WINDOW_MS,
    'credentialRefreshWindowMs'
  );
  const sourceCredentials = options.credentialsProvider ?? defaultProvider();
  const credentials =
    config.roleArn === undefined
      ? sourceCredentials
      : createAssumedCredentialProvider({
          assumeRole: options.assumeRole ?? defaultAssumeRole,
          input: {
            region: config.region,
            roleArn: config.roleArn,
            ...(config.externalId === undefined ? {} : { externalId: config.externalId }),
            sourceCredentials,
          },
          now,
          refreshWindowMs: credentialRefreshWindowMs,
        });
  async function performAttempt<
    TRequest extends FaqRagRetrieveRequest | FaqRagGenerateRequest,
    TResponse extends FaqRagRetrieveResponse | FaqRagGenerateResponse,
  >(
    operation: RemoteOperation,
    request: TRequest,
    deadlineAt: number,
    parseRequest: (value: unknown) => TRequest,
    parseResponse: (value: unknown) => TResponse,
    failureCode: 'retrieval_failed' | 'generation_failed'
  ): Promise<AttemptResult<TResponse>> {
    const url = operationUrl(config.baseUrl, operation);
    let resolvedCredentials: SigningCredentials;
    try {
      // Resolve the default chain / STS session before fixing the wire deadline. The first
      // AssumeRole call may take seconds and that time must not be granted to the server.
      resolvedCredentials = await credentials();
    } catch {
      logTransportFailure(operation, failureCode);
      return { response: technicalError(failureCode) as TResponse, retry: false };
    }

    const remainingMs = Math.floor(deadlineAt - now());
    if (remainingMs <= abortSafetyMarginMs) {
      return { response: technicalError('deadline_exceeded') as TResponse, retry: false };
    }

    let outboundRequest: TRequest;
    try {
      outboundRequest = parseRequest({ ...request, remainingMs });
    } catch (error) {
      logContractViolation(operation, 'request', contractField(error, `${operation}Request`));
      return { response: invalidContractError() as TResponse, retry: false };
    }
    const body = JSON.stringify(outboundRequest);
    const signer = new SignatureV4({
      credentials: resolvedCredentials,
      region: config.region,
      service: EXECUTE_API_SERVICE,
      sha256: Sha256,
    });
    let signedHeaders: Record<string, string>;
    try {
      const signed = await signer.sign(requestForSigning(url, body));
      signedHeaders = signed.headers;
    } catch {
      logTransportFailure(operation, failureCode);
      return { response: technicalError(failureCode) as TResponse, retry: false };
    }

    // Credential resolution/signing is part of the caller's end-to-end budget too.
    const fetchBudgetMs = Math.floor(deadlineAt - now() - abortSafetyMarginMs);
    if (fetchBudgetMs <= 0) {
      return { response: technicalError('deadline_exceeded') as TResponse, retry: false };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), fetchBudgetMs);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: signedHeaders,
        body,
        signal: controller.signal,
        redirect: 'manual',
      });
    } catch {
      clearTimeout(timeout);
      if (controller.signal.aborted) {
        return { response: technicalError('deadline_exceeded') as TResponse, retry: false };
      }
      logTransportFailure(operation, failureCode);
      return {
        response: technicalError(failureCode) as TResponse,
        retry: operation === 'retrieve',
      };
    }

    let untrustedResponse: unknown;
    try {
      untrustedResponse = await response.json();
    } catch {
      if (controller.signal.aborted) {
        return { response: technicalError('deadline_exceeded') as TResponse, retry: false };
      }
      const field = `${operation}Response.body`;
      if (isAuthenticationOrServerFailure(response.status)) {
        logServerContractFallback(operation, field, response.status, failureCode);
        return {
          response: technicalError(failureCode) as TResponse,
          retry: operation === 'retrieve' && response.status >= 500,
        };
      }
      logContractViolation(operation, 'response', field, response.status);
      return { response: invalidContractError() as TResponse, retry: false };
    } finally {
      clearTimeout(timeout);
    }

    let parsedResponse: TResponse;
    try {
      parsedResponse = parseResponse(untrustedResponse);
    } catch (error) {
      const field = contractField(error, `${operation}Response`);
      if (isAuthenticationOrServerFailure(response.status)) {
        logServerContractFallback(operation, field, response.status, failureCode);
        return {
          response: technicalError(failureCode) as TResponse,
          retry: operation === 'retrieve' && response.status >= 500,
        };
      }
      logContractViolation(operation, 'response', field, response.status);
      return { response: invalidContractError() as TResponse, retry: false };
    }

    if (parsedResponse.ok !== isHttpSuccess(response.status)) {
      logContractViolation(operation, 'response', `${operation}Response.ok`, response.status);
      return { response: invalidContractError() as TResponse, retry: false };
    }

    if (operation === 'retrieve') {
      const retryAfterMs = retrieveDtoRetryDelay(parsedResponse as FaqRagRetrieveResponse);
      return {
        response: parsedResponse,
        retry: retryAfterMs !== undefined,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      };
    }
    return { response: parsedResponse, retry: false };
  }

  return {
    async retrieve(untrustedRequest: FaqRagRetrieveRequest): Promise<FaqRagRetrieveResponse> {
      let request: FaqRagRetrieveRequest;
      try {
        request = parseRemoteV1RetrieveRequest(untrustedRequest);
      } catch (error) {
        logContractViolation('retrieve', 'request', contractField(error, 'retrieveRequest'));
        return invalidContractError();
      }

      const deadlineAt = now() + request.remainingMs;
      for (let attempt = 0; attempt <= RETRIEVE_BACKOFF_MS.length; attempt += 1) {
        const remainingMs = Math.floor(deadlineAt - now());
        if (remainingMs <= abortSafetyMarginMs) return technicalError('deadline_exceeded');

        const result = await performAttempt(
          'retrieve',
          request,
          deadlineAt,
          parseRemoteV1RetrieveRequest,
          parseRemoteV1RetrieveResponse,
          'retrieval_failed'
        );
        if (!result.retry || attempt === RETRIEVE_BACKOFF_MS.length) return result.response;

        const boundedRandom = Math.max(0, Math.min(0.999_999, random()));
        const backoffMs =
          RETRIEVE_BACKOFF_MS[attempt] +
          Math.floor(boundedRandom * RETRIEVE_JITTER_MS[attempt]);
        const delayMs = Math.max(backoffMs, result.retryAfterMs ?? 0);
        if (now() + delayMs + abortSafetyMarginMs >= deadlineAt) return result.response;
        await sleep(delayMs);
      }
      return technicalError('retrieval_failed');
    },

    async generate(untrustedRequest: FaqRagGenerateRequest): Promise<FaqRagGenerateResponse> {
      let request: FaqRagGenerateRequest;
      try {
        request = parseRemoteV1GenerateRequest(untrustedRequest);
      } catch (error) {
        logContractViolation('generate', 'request', contractField(error, 'generateRequest'));
        return invalidContractError();
      }
      if (request.remainingMs <= abortSafetyMarginMs) {
        return technicalError('deadline_exceeded');
      }

      const deadlineAt = now() + request.remainingMs;

      // Generate is deliberately sent exactly once. Retrying can double-charge the provider;
      // the caller-supplied idempotency key exists for server replay, not client auto-retry.
      const result = await performAttempt(
        'generate',
        request,
        deadlineAt,
        parseRemoteV1GenerateRequest,
        parseRemoteV1GenerateResponse,
        'generation_failed'
      );
      return result.response;
    },
  };
}
