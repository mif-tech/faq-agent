/** Slack Events API の署名・イベント検証 / */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const SLACK_SIGNATURE_MAX_AGE_SECONDS = 5 * 60;

export interface SlackHttpRequest {
  body?: string | null;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined | null>;
}

export type SlackSignatureFailureReason =
  | 'missing_signing_secret'
  | 'missing_body'
  | 'invalid_base64_body'
  | 'invalid_utf8_body'
  | 'missing_timestamp'
  | 'invalid_timestamp'
  | 'timestamp_out_of_range'
  | 'missing_signature'
  | 'invalid_signature';

export type SlackSignatureVerificationResult =
  | {
      ok: true;
      rawBody: string;
      rawBodyBytes: Buffer;
      timestamp: number;
    }
  | {
      ok: false;
      reason: SlackSignatureFailureReason;
    };

export interface SlackSignatureVerificationOptions {
  /** 単体テスト用。指定しない場合は現在時刻（秒）。 */
  nowSeconds?: number;
}

export interface SlackEventValidationOptions<TTrustClass extends string> {
  trustClass: TTrustClass;
  /** edition が許容する trust class を単一の predicate として注入する。 */
  isTrustClass: (value: string) => value is TTrustClass;
  /** DM専用クラスかどうかを edition policy から注入する。 */
  requiresDirectMessage: (trustClass: TTrustClass) => boolean;
  expectedAppId: string;
  expectedTeamId: string;
  expectedBotUserId: string;
  /** チャンネル応答先。空配列は全チャンネル拒否。 */
  allowedChannelIds?: readonly string[] | ReadonlySet<string>;
}

export interface ValidatedSlackMessageEvent extends Record<string, unknown> {
  type: 'message' | 'app_mention';
  user: string;
  channel: string;
  text: string;
  ts: string;
  thread_ts?: string;
  channel_type?: string;
}

export interface ValidatedSlackEventCallback extends Record<string, unknown> {
  type: 'event_callback';
  api_app_id: string;
  team_id: string;
  event_id: string;
  event: ValidatedSlackMessageEvent;
}

export type SlackEventFailureReason =
  | 'invalid_payload'
  | 'invalid_url_verification'
  | 'unsupported_envelope_type'
  | 'invalid_validation_config'
  | 'app_id_mismatch'
  | 'team_id_mismatch'
  | 'external_shared_channel'
  | 'invalid_event_callback'
  | 'unsupported_event_type'
  | 'bot_event'
  | 'self_event'
  | 'subtype_event'
  | 'dm_only_agent_requires_dm'
  | 'dm_requires_message'
  | 'channel_requires_app_mention'
  | 'channel_not_allowed';

export type SlackEventValidationResult =
  | {
      ok: true;
      kind: 'url_verification';
      challenge: string;
    }
  | {
      ok: true;
      kind: 'event_callback';
      envelope: ValidatedSlackEventCallback;
      event: ValidatedSlackMessageEvent;
    }
  | {
      ok: false;
      /** true は署名済みだが処理対象外であり、Slack の再送を不要とする。 */
      ignored: boolean;
      reason: SlackEventFailureReason;
    };

export type SlackPayloadParseResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: 'invalid_json' | 'invalid_payload' };

export type SlackRequestValidationResult =
  | (Extract<SlackEventValidationResult, { ok: true }> & {
      rawBody: string;
      timestamp: number;
    })
  | {
      ok: false;
      ignored: boolean;
      stage: 'signature' | 'payload' | 'event';
      reason: SlackSignatureFailureReason | SlackEventFailureReason | 'invalid_json';
    };

/**
 * API Gateway が渡した body を、Slack が署名した元の byte 列へ戻して検証する。
 * JSON parse はこの関数の成功後にのみ行うこと。
 */
export function verifySlackRequestSignature(
  request: SlackHttpRequest,
  signingSecret: string,
  options: SlackSignatureVerificationOptions = {}
): SlackSignatureVerificationResult {
  if (typeof signingSecret !== 'string' || signingSecret.length === 0) {
    return { ok: false, reason: 'missing_signing_secret' };
  }
  if (typeof request.body !== 'string') {
    return { ok: false, reason: 'missing_body' };
  }

  const rawBodyBytes = request.isBase64Encoded
    ? decodeBase64Strict(request.body)
    : Buffer.from(request.body, 'utf8');
  if (rawBodyBytes === null) {
    return { ok: false, reason: 'invalid_base64_body' };
  }

  const rawBody = rawBodyBytes.toString('utf8');
  // Buffer#toString は不正UTF-8を置換するため、round-tripで曖昧な入力を拒否する。
  if (!Buffer.from(rawBody, 'utf8').equals(rawBodyBytes)) {
    return { ok: false, reason: 'invalid_utf8_body' };
  }

  const timestampHeader = getSingleHeader(request.headers, 'x-slack-request-timestamp');
  if (timestampHeader === undefined) {
    return { ok: false, reason: 'missing_timestamp' };
  }
  if (!/^[0-9]+$/.test(timestampHeader)) {
    return { ok: false, reason: 'invalid_timestamp' };
  }
  const timestamp = Number(timestampHeader);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    return { ok: false, reason: 'invalid_timestamp' };
  }

  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(nowSeconds)) {
    return { ok: false, reason: 'invalid_timestamp' };
  }
  if (Math.abs(Math.floor(nowSeconds) - timestamp) > SLACK_SIGNATURE_MAX_AGE_SECONDS) {
    return { ok: false, reason: 'timestamp_out_of_range' };
  }

  const signature = getSingleHeader(request.headers, 'x-slack-signature');
  if (signature === undefined) {
    return { ok: false, reason: 'missing_signature' };
  }

  const digest = createHmac('sha256', signingSecret)
    .update(`v0:${timestampHeader}:`, 'utf8')
    .update(rawBodyBytes)
    .digest('hex');
  const expectedSignature = `v0=${digest}`;
  if (!constantTimeEqual(expectedSignature, signature)) {
    return { ok: false, reason: 'invalid_signature' };
  }

  return { ok: true, rawBody, rawBodyBytes, timestamp };
}

export function parseSlackEventPayload(rawBody: string): SlackPayloadParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  if (!isRecord(parsed)) {
    return { ok: false, reason: 'invalid_payload' };
  }
  return { ok: true, payload: parsed };
}

/** 署名検証済み payload のみを渡す。 */
export function validateSlackEvent<TTrustClass extends string>(
  payload: unknown,
  options: SlackEventValidationOptions<TTrustClass>
): SlackEventValidationResult {
  if (!isRecord(payload) || !isNonEmptyString(payload.type)) {
    return rejected('invalid_payload');
  }

  if (payload.type === 'url_verification') {
    // Slack公式のchallenge payloadは api_app_id/team_id を含まない。
    if (!isNonEmptyString(payload.challenge)) {
      return rejected('invalid_url_verification');
    }
    return { ok: true, kind: 'url_verification', challenge: payload.challenge };
  }

  if (payload.type !== 'event_callback') {
    return ignored('unsupported_envelope_type');
  }

  const normalizedOptions = normalizeValidationOptions(options);
  if (normalizedOptions === null) {
    return rejected('invalid_validation_config');
  }
  if (!isNonEmptyString(payload.api_app_id) || payload.api_app_id !== options.expectedAppId) {
    return rejected('app_id_mismatch');
  }
  if (!isNonEmptyString(payload.team_id) || payload.team_id !== options.expectedTeamId) {
    return rejected('team_id_mismatch');
  }
  if (
    Object.hasOwn(payload, 'is_ext_shared_channel') &&
    typeof payload.is_ext_shared_channel !== 'boolean'
  ) {
    return rejected('invalid_event_callback');
  }
  // allowlist済みchannelが後からSlack Connect共有へ変わっても、外部参加者の発言を
  // 社内メンバー境界へ取り込まない。署名済みなので再送不要のACK-ignoreとする。
  if (payload.is_ext_shared_channel === true) {
    return ignored('external_shared_channel');
  }
  if (!isNonEmptyString(payload.event_id) || !isRecord(payload.event)) {
    return rejected('invalid_event_callback');
  }

  const event = payload.event;
  if (!isNonEmptyString(event.type)) {
    return rejected('invalid_event_callback');
  }

  // bot/subtypeイベントはmessageの必須fieldを欠く場合があるため、先にACK対象へ落とす。
  if (Object.hasOwn(event, 'bot_id')) return ignored('bot_event');
  if (Object.hasOwn(event, 'subtype')) return ignored('subtype_event');
  if (event.user === options.expectedBotUserId) return ignored('self_event');

  if (event.type !== 'message' && event.type !== 'app_mention') {
    return ignored('unsupported_event_type');
  }

  if (
    !isNonEmptyString(event.channel) ||
    !isNonEmptyString(event.user) ||
    !isNonEmptyString(event.text) ||
    !isNonEmptyString(event.ts) ||
    (Object.hasOwn(event, 'thread_ts') && !isNonEmptyString(event.thread_ts)) ||
    (Object.hasOwn(event, 'channel_type') && typeof event.channel_type !== 'string')
  ) {
    return rejected('invalid_event_callback');
  }

  if (normalizedOptions.requiresDirectMessage) {
    if (event.channel_type !== 'im') return ignored('dm_only_agent_requires_dm');
    if (event.type !== 'message') return ignored('unsupported_event_type');
  } else if (event.channel_type === 'im') {
    if (event.type !== 'message') return ignored('dm_requires_message');
  } else {
    if (event.type !== 'app_mention') {
      return ignored('channel_requires_app_mention');
    }
    if (!normalizedOptions.allowedChannelIds.has(event.channel)) {
      return ignored('channel_not_allowed');
    }
  }

  const validatedEvent = event as ValidatedSlackMessageEvent;
  const envelope = payload as ValidatedSlackEventCallback;
  return { ok: true, kind: 'event_callback', envelope, event: validatedEvent };
}

/** 署名→JSON parse→event検証の順序を固定する ingress 向けhelper。 */
export function verifyAndValidateSlackRequest<TTrustClass extends string>(
  request: SlackHttpRequest,
  signingSecret: string,
  eventOptions: SlackEventValidationOptions<TTrustClass>,
  signatureOptions: SlackSignatureVerificationOptions = {}
): SlackRequestValidationResult {
  const signatureResult = verifySlackRequestSignature(request, signingSecret, signatureOptions);
  if (!signatureResult.ok) {
    return {
      ok: false,
      ignored: false,
      stage: 'signature',
      reason: signatureResult.reason,
    };
  }

  const parseResult = parseSlackEventPayload(signatureResult.rawBody);
  if (!parseResult.ok) {
    return {
      ok: false,
      ignored: false,
      stage: 'payload',
      reason: parseResult.reason,
    };
  }

  const eventResult = validateSlackEvent(parseResult.payload, eventOptions);
  if (!eventResult.ok) {
    return { ...eventResult, stage: 'event' };
  }
  return {
    ...eventResult,
    rawBody: signatureResult.rawBody,
    timestamp: signatureResult.timestamp,
  };
}

function normalizeValidationOptions<TTrustClass extends string>(
  options: SlackEventValidationOptions<TTrustClass>
): {
  allowedChannelIds: ReadonlySet<string>;
  requiresDirectMessage: boolean;
} | null {
  if (
    typeof options.isTrustClass !== 'function' ||
    typeof options.requiresDirectMessage !== 'function' ||
    !options.isTrustClass(options.trustClass) ||
    !isNonEmptyString(options.expectedAppId) ||
    !isNonEmptyString(options.expectedTeamId) ||
    !isNonEmptyString(options.expectedBotUserId)
  ) {
    return null;
  }

  const requiresDirectMessage = options.requiresDirectMessage(options.trustClass);
  if (typeof requiresDirectMessage !== 'boolean') return null;
  if (requiresDirectMessage) {
    return { allowedChannelIds: new Set(), requiresDirectMessage };
  }
  if (options.allowedChannelIds === undefined) return null;

  const values =
    options.allowedChannelIds instanceof Set
      ? [...options.allowedChannelIds]
      : options.allowedChannelIds;
  if (!Array.isArray(values) || values.some((value) => !isNonEmptyString(value))) {
    return null;
  }
  return { allowedChannelIds: new Set(values), requiresDirectMessage };
}

function getSingleHeader(
  headers: SlackHttpRequest['headers'],
  expectedName: string
): string | undefined {
  if (!headers) return undefined;
  const matching = Object.entries(headers).filter(
    ([name]) => name.toLowerCase() === expectedName
  );
  // 同名headerが大小文字違いで複数現れた場合もfail closed。
  if (matching.length !== 1 || typeof matching[0][1] !== 'string') return undefined;
  return matching[0][1];
}

function decodeBase64Strict(encoded: string): Buffer | null {
  if (
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    return null;
  }
  const decoded = Buffer.from(encoded, 'base64');
  return decoded.toString('base64') === encoded ? decoded : null;
}

function constantTimeEqual(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, 'utf8');
  const actualBytes = Buffer.from(actual, 'utf8');
  const comparableActual = Buffer.alloc(expectedBytes.length);
  actualBytes.copy(comparableActual, 0, 0, expectedBytes.length);
  return timingSafeEqual(expectedBytes, comparableActual) && actualBytes.length === expectedBytes.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function ignored(reason: SlackEventFailureReason): SlackEventValidationResult {
  return { ok: false, ignored: true, reason };
}

function rejected(reason: SlackEventFailureReason): SlackEventValidationResult {
  return { ok: false, ignored: false, reason };
}
