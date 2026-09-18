import { Sha256 } from '@aws-crypto/sha256-js';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { SignatureV4 } from '@smithy/signature-v4';
import {
  recordFaqAnswerBudget,
  recordFaqCredentialTiming,
  recordFaqGenerateBudget,
  recordFaqRemoteAttemptTiming,
  type FaqTimingOutcome as TimingOutcome,
  type FaqRemoteAttemptTiming as RemoteAttemptTiming,
} from '../../shell-timing.js';
import type {
  FaqRagCallContext,
  FaqRagErrorResponse,
  FaqRagGenerateRequest,
  FaqRagGenerateResponse,
  FaqRagPort,
  FaqRagRetrieveRequest,
  FaqRagRetrieveResponse,
} from '../../ports/rag.js';
import type { FaqRagAnswerPort, FaqRagAnswerResult } from '../../ports/answer.js';
import {
  FAQ_RAG_ANSWER_CONTRACT_VERSION,
  RemoteOneShotContractValidationError,
  parseRemoteOneShotAnswerRequest,
  parseRemoteOneShotAnswerResponse,
  type RemoteOneShotAnswerErrorCode,
  type RemoteOneShotAnswerRequest,
  type RemoteOneShotAnswerResponse,
} from './answer-contract.js';
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
  /** Counts actual SDK send attempts, including SDK retries; never carries SDK data. */
  onSdkAttempt?: () => void;
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
  /** Trusted composition only. Evaluation can disable split retries; production defaults to 2. */
  retrieveMaxRetries?: 0 | 1 | 2;
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

function newAttemptTiming(operation: RemoteAttemptTiming['operation'], attempt: number): RemoteAttemptTiming {
  return { operation, attempt, signing_ms: 0, http_headers_ms: 0, body_parse_ms: 0, retry_wait_ms: 0, outcome: 'failure' };
}

function responseOutcome(response: { ok: boolean; error?: { code: string } }): TimingOutcome {
  // no_match is a successful, validated remote operation, not a transport failure.
  if (response.ok || response.error?.code === 'no_match') return 'success';
  return response.error?.code === 'deadline_exceeded' ? 'timeout' : 'failure';
}

async function measureAttemptStep<T>(
  timing: RemoteAttemptTiming,
  field: 'signing_ms' | 'http_headers_ms' | 'body_parse_ms',
  now: () => number,
  start: () => Promise<T>,
  signal: AbortSignal
): Promise<T> {
  const startedAt = now();
  try {
    return await waitForDeadlineStep(start, signal);
  } finally {
    // This finally belongs to the deadline-bounded caller, never the late SDK/fetch work.
    timing[field] += Math.max(0, now() - startedAt);
  }
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
  onSdkAttempt,
}: AssumeRoleInput): Promise<SigningCredentials> {
  const client = new STSClient({ region, credentials: sourceCredentials });
  try {
    // SDK retries run at finalizeRequest/high; low runs inside each retry without
    // depending on an internal middleware name that might fail to resolve at send.
    client.middlewareStack.add(
      (next) => async (args) => {
        onSdkAttempt?.();
        return next(args);
      },
      {
        step: 'finalizeRequest',
        name: 'faqShellAssumeRoleAttempts',
        priority: 'low',
        tags: ['FAQ_SHELL_TIMING'],
      }
    );
  } catch {
    // Attempt counting is optional; registration failures must not block AssumeRole.
  }
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

interface CredentialResolution {
  promise: Promise<SigningCredentials>;
  cache: 'hit' | 'refresh' | 'cold';
  assumeRole?: {
    startedAt: number;
    finishedAt?: number;
    attempts: number;
    outcome?: 'success' | 'failure';
  };
}

type StartCredentialResolution = () => CredentialResolution;

function createAssumedCredentialProvider(options: {
  assumeRole: AssumeRole;
  input: AssumeRoleInput;
  now: () => number;
  refreshWindowMs: number;
}): StartCredentialResolution {
  let cached: SigningCredentials | undefined;
  let inFlight: CredentialResolution | undefined;

  return () => {
    const cachedExpiration = cached?.expiration?.getTime();
    if (
      cached !== undefined &&
      cachedExpiration !== undefined &&
      Number.isFinite(cachedExpiration) &&
      cachedExpiration - options.refreshWindowMs > options.now()
    ) {
      return { promise: Promise.resolve(cached), cache: 'hit' };
    }
    if (inFlight !== undefined) return inFlight;

    const refresh: NonNullable<CredentialResolution['assumeRole']> = { startedAt: options.now(), attempts: 0 };
    const promise = Promise.resolve()
      .then(() => options.assumeRole({ ...options.input, onSdkAttempt: () => { refresh.attempts += 1; } }))
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
        refresh.outcome = 'success';
        return credentials;
      })
      .catch((error: unknown) => {
        refresh.outcome = 'failure';
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
        refresh.finishedAt = options.now();
        inFlight = undefined;
      });
    inFlight = { promise, cache: cached === undefined ? 'cold' : 'refresh', assumeRole: refresh };
    return inFlight;
  };
}

async function resolveCredentials(
  start: StartCredentialResolution,
  signal: AbortSignal,
  now: () => number
): Promise<SigningCredentials> {
  const startedAt = now();
  let resolution: CredentialResolution | undefined;
  let outcome: TimingOutcome = 'failure';
  try {
    const result = await waitForDeadlineStep(() => {
      resolution = start();
      return resolution.promise;
    }, signal);
    outcome = 'success';
    return result;
  } catch (error) {
    outcome = signal.aborted ? 'timeout' : 'failure';
    throw error;
  } finally {
    const finishedAt = now();
    const refresh = resolution?.assumeRole;
    recordFaqCredentialTiming({
      credential_wait_ms: Math.max(0, finishedAt - startedAt),
      credential_cache: resolution?.cache ?? 'cold',
      // A shared refresh is observed only as far as this caller waited. Late resolution
      // can warm the cache but never emits into this or another invocation's telemetry.
      assume_role_ms: refresh === undefined ? 0 : Math.max(0, (refresh.finishedAt ?? finishedAt) - refresh.startedAt),
      assume_role_attempts: refresh?.attempts ?? 0,
      outcome: outcome === 'timeout' ? outcome : refresh?.outcome ?? outcome,
    });
  }
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

function operationUrl(baseUrl: string, operation: RemoteOperation | 'answer'): URL {
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

function observeHttpResponse(
  context: FaqRagCallContext | undefined,
  operation: RemoteOperation | 'answer',
  response: Response
): void {
  // Correlation stays in response headers and invocation-local diagnostics, never wire DTOs.
  // Only bounded opaque IDs are accepted; gateway error bodies are never logged.
  let requestId: string | undefined;
  for (const name of ['x-faq-remote-request-id', 'x-amzn-requestid', 'x-amzn-request-id', 'apigw-requestid']) {
    const value = response.headers?.get(name);
    if (value !== undefined && value !== null && /^[A-Za-z0-9_+=./:-]{1,128}$/.test(value)) {
      requestId = value;
      break;
    }
  }
  context?.onHttpResponse?.({
    operation,
    status: response.status,
    ...(requestId === undefined ? {} : { requestId }),
  });
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
function createHttpRuntime(options: RemoteFaqRagHttpClientOptions) {
  const config = readConfig(options.env ?? process.env);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Remote FAQ RAG requires global fetch');
  }
  const now = options.now ?? Date.now;
  const abortSafetyMarginMs = validateNonNegativeInteger(
    options.abortSafetyMarginMs ?? DEFAULT_ABORT_SAFETY_MARGIN_MS,
    'abortSafetyMarginMs'
  );
  const credentialRefreshWindowMs = validateNonNegativeInteger(
    options.credentialRefreshWindowMs ?? DEFAULT_CREDENTIAL_REFRESH_WINDOW_MS,
    'credentialRefreshWindowMs'
  );
  const sourceCredentials = options.credentialsProvider ?? defaultProvider();
  const credentials: StartCredentialResolution =
    config.roleArn === undefined
      // The default SDK provider owns its own cache. 'hit' here means the direct path
      // (no client-owned AssumeRole refresh); SDK-provider cache internals are opaque.
      ? () => ({ promise: sourceCredentials(), cache: 'hit' })
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
  return { config, fetchImpl, now, abortSafetyMarginMs, credentials };
}

export function createRemoteFaqRagHttpClient(
  options: RemoteFaqRagHttpClientOptions = {}
): FaqRagPort {
  const { config, fetchImpl, now, abortSafetyMarginMs, credentials } = createHttpRuntime(options);
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const retrieveMaxRetries = options.retrieveMaxRetries ?? RETRIEVE_BACKOFF_MS.length;
  if (!Number.isSafeInteger(retrieveMaxRetries) || retrieveMaxRetries < 0 || retrieveMaxRetries > RETRIEVE_BACKOFF_MS.length) {
    throw new Error('retrieveMaxRetries must be 0, 1 or 2');
  }
  async function performAttempt<
    TRequest extends FaqRagRetrieveRequest | FaqRagGenerateRequest,
    TResponse extends FaqRagRetrieveResponse | FaqRagGenerateResponse,
  >(
    operation: RemoteOperation,
    request: TRequest,
    deadlineAt: number,
    parseRequest: (value: unknown) => TRequest,
    parseResponse: (value: unknown) => TResponse,
    failureCode: 'retrieval_failed' | 'generation_failed',
    timing: RemoteAttemptTiming,
    context?: FaqRagCallContext
  ): Promise<AttemptResult<TResponse>> {
    const attemptBudgetMs = Math.floor(deadlineAt - now() - abortSafetyMarginMs);
    if (operation === 'generate') recordFaqGenerateBudget({ effective_generate_timeout_ms: Math.max(0, attemptBudgetMs) });
    if (attemptBudgetMs <= 0) {
      return { response: technicalError('deadline_exceeded') as TResponse, retry: false };
    }
    const controller = new AbortController();
    // The same budget covers cold credentials, signing, HTTP and body parsing on both arms.
    // It bounds this caller's wait, without canceling a shared credential refresh.
    const timeout = setTimeout(() => controller.abort(), attemptBudgetMs);
    try {
      const url = operationUrl(config.baseUrl, operation);
      let resolvedCredentials: SigningCredentials;
      try {
        // Resolve the default chain / STS session before fixing the wire deadline. The first
        // AssumeRole call may take seconds and that time must not be granted to the server.
        resolvedCredentials = await resolveCredentials(credentials, controller.signal, now);
      } catch {
        if (controller.signal.aborted || now() + abortSafetyMarginMs >= deadlineAt) {
          return { response: technicalError('deadline_exceeded') as TResponse, retry: false };
        }
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
        const signed = await measureAttemptStep(
          timing, 'signing_ms', now, () => signer.sign(requestForSigning(url, body)), controller.signal
        );
        signedHeaders = signed.headers;
      } catch {
        if (controller.signal.aborted || now() + abortSafetyMarginMs >= deadlineAt) {
          return { response: technicalError('deadline_exceeded') as TResponse, retry: false };
        }
        logTransportFailure(operation, failureCode);
        return { response: technicalError(failureCode) as TResponse, retry: false };
      }

      // Credential resolution/signing is part of the caller's end-to-end budget too.
      const fetchBudgetMs = Math.floor(deadlineAt - now() - abortSafetyMarginMs);
      if (fetchBudgetMs <= 0) {
        return { response: technicalError('deadline_exceeded') as TResponse, retry: false };
      }
      let response: Response;
      try {
        response = await measureAttemptStep(timing, 'http_headers_ms', now, () => {
          context?.onHttpRequest?.();
          return fetchImpl(url, {
            method: 'POST',
            headers: signedHeaders,
            body,
            signal: controller.signal,
            redirect: 'manual',
          });
        }, controller.signal);
      } catch {
        if (controller.signal.aborted || now() + abortSafetyMarginMs >= deadlineAt) {
          return { response: technicalError('deadline_exceeded') as TResponse, retry: false };
        }
        logTransportFailure(operation, failureCode);
        return {
          response: technicalError(failureCode) as TResponse,
          retry: operation === 'retrieve',
        };
      }
      observeHttpResponse(context, operation, response);

      let untrustedResponse: unknown;
      try {
        untrustedResponse = await measureAttemptStep(timing, 'body_parse_ms', now, () => response.json(), controller.signal);
      } catch {
        if (controller.signal.aborted || now() + abortSafetyMarginMs >= deadlineAt) {
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
      }
      if (controller.signal.aborted || now() + abortSafetyMarginMs >= deadlineAt) {
        return { response: technicalError('deadline_exceeded') as TResponse, retry: false };
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
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async retrieve(untrustedRequest: FaqRagRetrieveRequest, context?: FaqRagCallContext): Promise<FaqRagRetrieveResponse> {
      let request: FaqRagRetrieveRequest;
      try {
        request = parseRemoteV1RetrieveRequest(untrustedRequest);
      } catch (error) {
        logContractViolation('retrieve', 'request', contractField(error, 'retrieveRequest'));
        return invalidContractError();
      }

      const deadlineAt = now() + request.remainingMs;
      for (let attempt = 0; attempt <= retrieveMaxRetries; attempt += 1) {
        const remainingMs = Math.floor(deadlineAt - now());
        if (remainingMs <= abortSafetyMarginMs) return technicalError('deadline_exceeded');

        const timing = newAttemptTiming('retrieve', attempt + 1);
        const result = await performAttempt(
          'retrieve',
          request,
          deadlineAt,
          parseRemoteV1RetrieveRequest,
          parseRemoteV1RetrieveResponse,
          'retrieval_failed',
          timing,
          context
        );
        timing.outcome = responseOutcome(result.response);
        if (!result.retry || attempt === retrieveMaxRetries) {
          recordFaqRemoteAttemptTiming(timing);
          return result.response;
        }

        const boundedRandom = Math.max(0, Math.min(0.999_999, random()));
        const backoffMs =
          RETRIEVE_BACKOFF_MS[attempt] +
          Math.floor(boundedRandom * RETRIEVE_JITTER_MS[attempt]);
        const delayMs = Math.max(backoffMs, result.retryAfterMs ?? 0);
        if (now() + delayMs + abortSafetyMarginMs >= deadlineAt) {
          recordFaqRemoteAttemptTiming(timing);
          return result.response;
        }
        const retryStartedAt = now();
        try {
          await sleep(delayMs);
        } finally {
          timing.retry_wait_ms = Math.max(0, now() - retryStartedAt);
          recordFaqRemoteAttemptTiming(timing);
        }
      }
      return technicalError('retrieval_failed');
    },

    async generate(untrustedRequest: FaqRagGenerateRequest, context?: FaqRagCallContext): Promise<FaqRagGenerateResponse> {
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
      const timing = newAttemptTiming('generate', 1);
      const result = await performAttempt(
        'generate',
        request,
        deadlineAt,
        parseRemoteV1GenerateRequest,
        parseRemoteV1GenerateResponse,
        'generation_failed',
        timing,
        context
      );
      timing.outcome = responseOutcome(result.response);
      recordFaqRemoteAttemptTiming(timing);
      return result.response;
    },
  };
}

const ANSWER_HTTP_STATUS: Readonly<Record<RemoteOneShotAnswerErrorCode, number>> = {
  no_match: 404,
  invalid_contract: 400,
  quota_exceeded: 429,
  kill_switch: 503,
  deadline_exceeded: 504,
  retrieval_failed: 502,
  generation_failed: 502,
};

function answerClientError(
  code: 'deadline_exceeded' | 'retrieval_failed' | 'invalid_contract' | 'remote_transport_unsupported'
): FaqRagAnswerResult {
  if (code === 'remote_transport_unsupported') {
    return { contractVersion: FAQ_RAG_ANSWER_CONTRACT_VERSION, ok: false, error: { code, retryable: false } };
  }
  if (code === 'invalid_contract') {
    return { contractVersion: FAQ_RAG_ANSWER_CONTRACT_VERSION, ok: false, error: { code, retryable: false } };
  }
  return { contractVersion: FAQ_RAG_ANSWER_CONTRACT_VERSION, ok: false, error: { code, retryable: true } };
}

function logAnswerFailure(code: string, status?: number, field?: string): void {
  // Classification only: no caller text, idempotency key, response body or exception message.
  console.error(
    `[remote-one-shot-v1] client operation=answer code=${code}` +
      (status === undefined ? '' : ` status=${status}`) +
      (field === undefined ? '' : ` field=${field}`)
  );
}

function invalidAnswerResponse(status: number, field: string): FaqRagAnswerResult {
  const code = status === 404 || status === 501
    ? 'remote_transport_unsupported'
    : isAuthenticationOrServerFailure(status) || status === 429
      ? 'retrieval_failed'
      : 'invalid_contract';
  logAnswerFailure(code, status, field);
  return answerClientError(code);
}

/** Stop this caller's wait without canceling the shared AssumeRole refresh promise. */
async function waitForDeadlineStep<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    // Promise.race installs rejection handlers on both branches, including an operation
    // that rejects after this caller has timed out. No late result resumes the caller.
    return await Promise.race([Promise.resolve().then(() => {
      if (signal.aborted) throw signal.reason;
      return start();
    }), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** Single attempt only. A retryable terminal DTO still replays for the same key. */
export function createRemoteFaqRagAnswerHttpClient(
  options: RemoteFaqRagHttpClientOptions = {}
): FaqRagAnswerPort {
  const { config, fetchImpl, now, abortSafetyMarginMs, credentials } = createHttpRuntime(options);
  return {
    async answer(untrustedRequest, context): Promise<FaqRagAnswerResult> {
      let request: RemoteOneShotAnswerRequest;
      try {
        request = parseRemoteOneShotAnswerRequest(untrustedRequest);
      } catch (error) {
        logAnswerFailure('invalid_contract', undefined,
          error instanceof RemoteOneShotContractValidationError ? error.field : 'answerRequest');
        return answerClientError('invalid_contract');
      }
      if (request.remainingMs <= abortSafetyMarginMs) return answerClientError('deadline_exceeded');
      const timing = newAttemptTiming('answer', 1);
      recordFaqAnswerBudget({
        remaining_at_answer_start_ms: request.remainingMs,
        effective_answer_timeout_ms: request.remainingMs - abortSafetyMarginMs,
      });
      const result = await (async (): Promise<FaqRagAnswerResult> => {
        const deadlineAt = now() + request.remainingMs;
        const controller = new AbortController();
        // One timer covers cold credentials, signing, HTTP and body parsing. The caller
        // can still emit a terminal metric/refusal if an SDK promise never resolves.
        const timeout = setTimeout(() => controller.abort(), request.remainingMs - abortSafetyMarginMs);
        try {
          let resolvedCredentials: SigningCredentials;
          try {
            resolvedCredentials = await resolveCredentials(credentials, controller.signal, now);
          } catch {
            if (controller.signal.aborted || now() + abortSafetyMarginMs >= deadlineAt) return answerClientError('deadline_exceeded');
            logAnswerFailure('retrieval_failed');
            return answerClientError('retrieval_failed');
          }
          const remainingMs = Math.floor(deadlineAt - now());
          if (remainingMs <= abortSafetyMarginMs) return answerClientError('deadline_exceeded');
          const url = operationUrl(config.baseUrl, 'answer');
          let body: string;
          try {
            body = JSON.stringify(parseRemoteOneShotAnswerRequest({ ...request, remainingMs }));
          } catch (error) {
            logAnswerFailure('invalid_contract', undefined,
              error instanceof RemoteOneShotContractValidationError ? error.field : 'answerRequest');
            return answerClientError('invalid_contract');
          }
          let signedHeaders: Record<string, string>;
          try {
            const signer = new SignatureV4({
              credentials: resolvedCredentials, region: config.region,
              service: EXECUTE_API_SERVICE, sha256: Sha256,
            });
            signedHeaders = (await measureAttemptStep(
              timing, 'signing_ms', now, () => signer.sign(requestForSigning(url, body)), controller.signal
            )).headers;
          } catch {
            if (controller.signal.aborted || now() + abortSafetyMarginMs >= deadlineAt) return answerClientError('deadline_exceeded');
            logAnswerFailure('retrieval_failed');
            return answerClientError('retrieval_failed');
          }
          const fetchBudgetMs = Math.floor(deadlineAt - now() - abortSafetyMarginMs);
          if (fetchBudgetMs <= 0) return answerClientError('deadline_exceeded');
          let response: Response;
          try {
            response = await measureAttemptStep(timing, 'http_headers_ms', now, () => {
              context?.onHttpRequest?.();
              return fetchImpl(url, {
                method: 'POST', headers: signedHeaders, body,
                signal: controller.signal, redirect: 'manual',
              });
            }, controller.signal);
          } catch {
            if (controller.signal.aborted || now() + abortSafetyMarginMs >= deadlineAt) return answerClientError('deadline_exceeded');
            logAnswerFailure('retrieval_failed');
            return answerClientError('retrieval_failed');
          }
          observeHttpResponse(context, 'answer', response);
          let untrustedResponse: unknown;
          try {
            untrustedResponse = await measureAttemptStep(timing, 'body_parse_ms', now, () => response.json(), controller.signal);
          } catch {
            if (controller.signal.aborted || now() + abortSafetyMarginMs >= deadlineAt) return answerClientError('deadline_exceeded');
            return invalidAnswerResponse(response.status, 'answerResponse.body');
          }
          if (controller.signal.aborted || now() + abortSafetyMarginMs >= deadlineAt) return answerClientError('deadline_exceeded');
          let parsed: RemoteOneShotAnswerResponse;
          try {
            parsed = parseRemoteOneShotAnswerResponse(untrustedResponse);
          } catch (error) {
            return invalidAnswerResponse(response.status,
              error instanceof RemoteOneShotContractValidationError ? error.field : 'answerResponse');
          }
          if (
            response.status === 501 ||
            (response.status === 404 && (parsed.ok || parsed.error.code !== 'no_match'))
          ) {
            logAnswerFailure('remote_transport_unsupported', response.status);
            return answerClientError('remote_transport_unsupported');
          }
          const expectedStatus = parsed.ok ? 200 : ANSWER_HTTP_STATUS[parsed.error.code];
          if (response.status !== expectedStatus) {
            logAnswerFailure('invalid_contract', response.status, 'answerResponse.status');
            return answerClientError('invalid_contract');
          }
          if (!parsed.ok && parsed.error.code !== 'no_match') logAnswerFailure(parsed.error.code, response.status);
          return parsed;
        } finally {
          clearTimeout(timeout);
        }
      })();
      timing.outcome = responseOutcome(result);
      recordFaqRemoteAttemptTiming(timing);
      return result;
    },
  };
}
