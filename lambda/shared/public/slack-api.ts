/**
 * Slack Web API client for agent workers.
 *
 * The bot token is injected by the edition-specific worker. Keep this
 * module free of environment-variable lookup so one worker cannot
 * accidentally use another worker's credential.
 *
 * Response bodies may contain employee messages. This module deliberately
 * does not log response bodies or attach them to errors.
 */

const SLACK_API_BASE_URL = 'https://slack.com/api';
export const DEFAULT_SLACK_API_TIMEOUT_MS = 5_000;
export const MAX_SLACK_REPLIES_PAGES = 5;

export type SlackApiMethod =
  | 'chat.postMessage'
  | 'conversations.replies'
  | 'conversations.history';

export type SlackApiErrorKind =
  | 'configuration'
  | 'invalid_request'
  | 'timeout'
  | 'network'
  | 'http'
  | 'invalid_json'
  | 'slack'
  | 'invalid_response';

export class SlackApiError extends Error {
  readonly kind: SlackApiErrorKind;
  readonly method: SlackApiMethod | 'client';
  readonly httpStatus?: number;
  readonly slackError?: string;
  readonly retryAfterSeconds?: number;

  constructor(params: {
    kind: SlackApiErrorKind;
    method: SlackApiMethod | 'client';
    message: string;
    httpStatus?: number;
    slackError?: string;
    retryAfterSeconds?: number;
  }) {
    super(params.message);
    this.name = 'SlackApiError';
    this.kind = params.kind;
    this.method = params.method;
    this.httpStatus = params.httpStatus;
    this.slackError = params.slackError;
    this.retryAfterSeconds = params.retryAfterSeconds;
  }
}

export interface SlackMessage {
  type?: string;
  ts: string;
  text?: string;
  userId?: string;
  botId?: string;
  appId?: string;
  subtype?: string;
  threadTs?: string;
}

export interface SlackPostMessageParams {
  channel: string;
  text: string;
  threadTs?: string;
}

export interface SlackPostMessageResult {
  channel: string;
  ts: string;
}

interface SlackConversationRangeParams {
  channel: string;
  /** Slack timestamp lower bound. */
  oldest?: string;
  /** Slack timestamp upper bound. */
  latest?: string;
  inclusive?: boolean;
  /** Per-page limit. Thread replies are cursor-paginated up to a fixed safety cap. */
  limit?: number;
}

export interface SlackGetRepliesParams extends SlackConversationRangeParams {
  /** Parent message timestamp passed to conversations.replies as `ts`. */
  threadTs: string;
}

export type SlackGetHistoryParams = SlackConversationRangeParams;

export interface SlackApiClient {
  postMessage(params: SlackPostMessageParams): Promise<SlackPostMessageResult>;
  /** Returns cursor pages in Slack's chronological order. */
  getReplies(params: SlackGetRepliesParams): Promise<SlackMessage[]>;
  /** Returns Slack's order unchanged (history is normally newest first). */
  getHistory(params: SlackGetHistoryParams): Promise<SlackMessage[]>;
}

export interface CreateSlackApiClientOptions {
  botToken: string;
  timeoutMs?: number;
  /** Injectable for unit tests; production callers should leave this unset. */
  fetchImpl?: typeof fetch;
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidRequest(method: SlackApiMethod, field: string): never {
  throw new SlackApiError({
    kind: 'invalid_request',
    method,
    message: `Slack ${method} request has an invalid ${field}`,
  });
}

function requireRequestString(
  value: string,
  field: string,
  method: SlackApiMethod,
  allowEmpty: boolean = false
): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
    return invalidRequest(method, field);
  }
  return value;
}

function addConversationRange(
  body: JsonObject,
  params: SlackConversationRangeParams,
  method: SlackApiMethod
): void {
  if (params.oldest !== undefined) {
    body.oldest = requireRequestString(params.oldest, 'oldest', method);
  }
  if (params.latest !== undefined) {
    body.latest = requireRequestString(params.latest, 'latest', method);
  }
  if (params.inclusive !== undefined) {
    if (typeof params.inclusive !== 'boolean') invalidRequest(method, 'inclusive');
    body.inclusive = params.inclusive;
  }
  if (params.limit !== undefined) {
    if (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 999) {
      invalidRequest(method, 'limit');
    }
    body.limit = params.limit;
  }
}

function safeSlackError(value: unknown): string | undefined {
  if (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 100 &&
    /^[a-z0-9_.-]+$/i.test(value)
  ) {
    return value;
  }
  return undefined;
}

function parseRetryAfter(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (raw === null || raw.trim() === '') return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function responseString(
  data: JsonObject,
  field: string,
  method: SlackApiMethod,
  allowEmpty: boolean = false
): string {
  const value = data[field];
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new SlackApiError({
      kind: 'invalid_response',
      method,
      message: `Slack ${method} response has an invalid ${field}`,
    });
  }
  return value;
}

function optionalResponseString(
  data: JsonObject,
  field: string,
  method: SlackApiMethod
): string | undefined {
  const value = data[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new SlackApiError({
      kind: 'invalid_response',
      method,
      message: `Slack ${method} response has an invalid ${field}`,
    });
  }
  return value;
}

function parseMessage(value: unknown, method: SlackApiMethod): SlackMessage {
  if (!isJsonObject(value)) {
    throw new SlackApiError({
      kind: 'invalid_response',
      method,
      message: `Slack ${method} response contains an invalid message`,
    });
  }

  const type = optionalResponseString(value, 'type', method);
  const text = optionalResponseString(value, 'text', method);
  const userId = optionalResponseString(value, 'user', method);
  const botId = optionalResponseString(value, 'bot_id', method);
  const appId = optionalResponseString(value, 'app_id', method);
  const subtype = optionalResponseString(value, 'subtype', method);
  const threadTs = optionalResponseString(value, 'thread_ts', method);

  return {
    ts: responseString(value, 'ts', method),
    ...(text !== undefined ? { text } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(userId !== undefined ? { userId } : {}),
    ...(botId !== undefined ? { botId } : {}),
    ...(appId !== undefined ? { appId } : {}),
    ...(subtype !== undefined ? { subtype } : {}),
    ...(threadTs !== undefined ? { threadTs } : {}),
  };
}

function parseNextCursor(data: JsonObject, method: SlackApiMethod): string | undefined {
  if (data.response_metadata === undefined) return undefined;
  if (!isJsonObject(data.response_metadata)) {
    throw new SlackApiError({
      kind: 'invalid_response',
      method,
      message: `Slack ${method} response has invalid pagination metadata`,
    });
  }
  const cursor = data.response_metadata.next_cursor;
  if (cursor === undefined || cursor === '') return undefined;
  if (typeof cursor !== 'string') {
    throw new SlackApiError({
      kind: 'invalid_response',
      method,
      message: `Slack ${method} response has an invalid next cursor`,
    });
  }
  return cursor;
}

function parseMessages(data: JsonObject, method: SlackApiMethod): SlackMessage[] {
  if (!Array.isArray(data.messages)) {
    throw new SlackApiError({
      kind: 'invalid_response',
      method,
      message: `Slack ${method} response has an invalid messages field`,
    });
  }
  return data.messages.map((message) => parseMessage(message, method));
}

/**
 * Create a client bound to exactly one bot credential.
 *
 * The client does not retry: SQS is the durable retry boundary for agent
 * workers, and an automatic postMessage retry could create duplicate replies.
 */
export function createSlackApiClient(
  options: CreateSlackApiClientOptions
): SlackApiClient {
  const botToken = options.botToken?.trim();
  if (!botToken) {
    throw new SlackApiError({
      kind: 'configuration',
      method: 'client',
      message: 'Slack bot token is required',
    });
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_SLACK_API_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new SlackApiError({
      kind: 'configuration',
      method: 'client',
      message: 'Slack API timeout must be a positive integer',
    });
  }
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request(method: SlackApiMethod, body: JsonObject): Promise<JsonObject> {
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${SLACK_API_BASE_URL}/${method}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${botToken}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch {
      if (signal.aborted) {
        throw new SlackApiError({
          kind: 'timeout',
          method,
          message: `Slack ${method} request timed out`,
        });
      }
      throw new SlackApiError({
        kind: 'network',
        method,
        message: `Slack ${method} request failed`,
      });
    }

    let data: unknown;
    let hasValidJson = true;
    try {
      data = await response.json();
    } catch {
      hasValidJson = false;
    }

    if (!response.ok) {
      const slackError = isJsonObject(data) ? safeSlackError(data.error) : undefined;
      throw new SlackApiError({
        kind: 'http',
        method,
        message: `Slack ${method} returned HTTP ${response.status}`,
        httpStatus: response.status,
        slackError,
        retryAfterSeconds: parseRetryAfter(response),
      });
    }

    if (!hasValidJson) {
      throw new SlackApiError({
        kind: 'invalid_json',
        method,
        message: `Slack ${method} returned invalid JSON`,
      });
    }
    if (!isJsonObject(data) || typeof data.ok !== 'boolean') {
      throw new SlackApiError({
        kind: 'invalid_response',
        method,
        message: `Slack ${method} returned an invalid response envelope`,
      });
    }
    if (!data.ok) {
      const slackError = safeSlackError(data.error) ?? 'unknown_error';
      throw new SlackApiError({
        kind: 'slack',
        method,
        message: `Slack ${method} failed (${slackError})`,
        slackError,
        retryAfterSeconds: parseRetryAfter(response),
      });
    }
    return data;
  }

  return {
    async postMessage(params: SlackPostMessageParams): Promise<SlackPostMessageResult> {
      const method: SlackApiMethod = 'chat.postMessage';
      const body: JsonObject = {
        channel: requireRequestString(params.channel, 'channel', method),
        text: requireRequestString(params.text, 'text', method),
      };
      if (params.threadTs !== undefined) {
        body.thread_ts = requireRequestString(params.threadTs, 'threadTs', method);
      }
      const data = await request(method, body);
      return {
        channel: responseString(data, 'channel', method),
        ts: responseString(data, 'ts', method),
      };
    },

    async getReplies(params: SlackGetRepliesParams): Promise<SlackMessage[]> {
      const method: SlackApiMethod = 'conversations.replies';
      const channel = requireRequestString(params.channel, 'channel', method);
      const threadTs = requireRequestString(params.threadTs, 'threadTs', method);
      const messages: SlackMessage[] = [];
      let cursor: string | undefined;

      // conversations.replies は古い順のため、1ページだけでは長いthreadの直近文脈を
      // 取得できない。cursorを追い、上限（5ページ=スレッド先頭側の取得分）に達したら
      // 取得済み分を「捨てて」空で続行する: 手元に残るのは古い側だけで、これを文脈に
      // 使うと直近の会話と無関係な発言が「これまでの利用者発言」として添えられる。
      // throwで沈黙させず、現在の質問のみで回答させる（レビュー第2回指摘2）。
      for (let page = 0; page < MAX_SLACK_REPLIES_PAGES; page += 1) {
        const body: JsonObject = { channel, ts: threadTs };
        addConversationRange(body, params, method);
        if (cursor !== undefined) body.cursor = cursor;
        const data = await request(method, body);
        messages.push(...parseMessages(data, method));
        cursor = parseNextCursor(data, method);
        if (cursor === undefined) return messages;
      }

      console.warn(
        JSON.stringify({
          metric: 'slack_replies_pagination_truncated',
          method,
          pages: MAX_SLACK_REPLIES_PAGES,
          discardedMessages: messages.length,
        })
      );
      return [];
    },

    async getHistory(params: SlackGetHistoryParams): Promise<SlackMessage[]> {
      const method: SlackApiMethod = 'conversations.history';
      const body: JsonObject = {
        channel: requireRequestString(params.channel, 'channel', method),
      };
      addConversationRange(body, params, method);
      return parseMessages(await request(method, body), method);
    },
  };
}
