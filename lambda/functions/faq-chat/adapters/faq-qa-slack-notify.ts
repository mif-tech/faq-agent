import type { FaqQaLogRecord } from '../ports/storage.js';

export const FAQ_QA_NOTIFY_TIMEOUT_MS = 2_000;

const NOTIFY_QUESTION_MAX = 300;
const NOTIFY_ANSWER_MAX = 700;
const NOTIFY_QUESTION_RENDERED_MAX = 900;
const NOTIFY_ANSWER_RENDERED_MAX = 1_800;
const SLACK_SECTION_TEXT_MAX = 2_900;
const SLACK_CONTEXT_TEXT_MAX = 1_900;
const SLACK_INCOMING_WEBHOOK_PATH =
  /^\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+$/u;
const TRUNCATION_SUFFIX = '…（続きはQ&Aログ参照）';
const USER_BACKTICK_REPLACEMENT = '｀';
const LOG_PREFIX = '[faq-chat] Q&A Slack notification';

/** Iterate by Unicode code point and replace any pre-existing lone surrogate. */
function wellFormedCodePoints(text: string): string[] {
  return Array.from(text, (codePoint) => {
    const firstUnit = codePoint.charCodeAt(0);
    return codePoint.length === 1 && firstUnit >= 0xd800 && firstUnit <= 0xdfff
      ? '\ufffd'
      : codePoint;
  });
}

function escapedMrkdwnChunk(codePoint: string): string {
  if (codePoint === '`') return USER_BACKTICK_REPLACEMENT;
  if (codePoint === '&') return '&amp;';
  if (codePoint === '<') return '&lt;';
  if (codePoint === '>') return '&gt;';
  return codePoint;
}

function takeWholeChunks(chunks: string[], maxUnits: number): string {
  let usedUnits = 0;
  let result = '';
  for (const chunk of chunks) {
    if (usedUnits + chunk.length > maxUnits) break;
    result += chunk;
    usedUnits += chunk.length;
  }
  return result;
}

/**
 * Bound untrusted text twice: first by saved-content code points, then by the
 * rendered mrkdwn size after entity expansion. No entity or surrogate pair is
 * ever sliced, and every user-supplied backtick is made inert before fencing.
 */
function renderFencedUserText(
  text: string,
  rawCodePointMax: number,
  renderedMaxUnits: number
): string {
  const original = wellFormedCodePoints(text);
  const selected = original.slice(0, rawCodePointMax);
  const chunks = selected.map(escapedMrkdwnChunk);
  const suffix = wellFormedCodePoints(TRUNCATION_SUFFIX).map(escapedMrkdwnChunk).join('');
  const rawTruncated = original.length > selected.length;
  const renderedLength = chunks.reduce((total, chunk) => total + chunk.length, 0);

  if (!rawTruncated && renderedLength <= renderedMaxUnits) return chunks.join('');

  const availableUnits = Math.max(0, renderedMaxUnits - suffix.length);
  return `${takeWholeChunks(chunks, availableUnits)}${suffix}`;
}

function truncatePlainText(text: string, maxUnits: number): string {
  const chunks = wellFormedCodePoints(text);
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  if (length <= maxUnits) return chunks.join('');

  const suffix = '…';
  return `${takeWholeChunks(chunks, Math.max(0, maxUnits - suffix.length))}${suffix}`;
}

function singleLinePlainText(text: string): string {
  return wellFormedCodePoints(text)
    .map((codePoint) => (/\s/u.test(codePoint) ? ' ' : codePoint))
    .join('');
}

function isSlackIncomingWebhookUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'hooks.slack.com' &&
      url.username === '' &&
      url.password === '' &&
      url.port === '' &&
      SLACK_INCOMING_WEBHOOK_PATH.test(url.pathname) &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

export function buildFaqQaSlackPayload(record: FaqQaLogRecord): {
  text: string;
  blocks: object[];
} {
  // The handler has already masked contact PII, normalized it with NFKC, and
  // bounded the stored fields. Use that exact saved record instead of touching
  // the original request again on the notification path.
  const question = renderFencedUserText(
    record.question,
    NOTIFY_QUESTION_MAX,
    NOTIFY_QUESTION_RENDERED_MAX
  );
  const answer = renderFencedUserText(
    record.answer,
    NOTIFY_ANSWER_MAX,
    NOTIFY_ANSWER_RENDERED_MAX
  );
  const meta = [
    `responseType: ${singleLinePlainText(record.responseType)}`,
    `route: ${singleLinePlainText(record.route)}`,
    `totalMs: ${record.totalMs ?? 'null'}`,
    record.scopeFallback ? 'scopeFallback: true' : null,
    record.failureKind
      ? `failureKind: ${singleLinePlainText(record.failureKind)}`
      : null,
    record.guardDetail
      ? `guardDetail: ${singleLinePlainText(record.guardDetail)}`
      : null,
    record.model ? `model: ${singleLinePlainText(record.model)}` : null,
    record.sources.length > 0
      ? `sources: ${singleLinePlainText(record.sources.join(' / '))}`
      : null,
  ]
    .filter((value): value is string => value !== null)
    .join(' | ');
  const sectionText = [
    '*FAQチャット利用*',
    '*Q:*',
    '```',
    question,
    '```',
    '*A:*',
    '```',
    answer,
    '```',
  ].join('\n');
  const contextText = truncatePlainText(
    `${singleLinePlainText(record.ts)} | ${meta}`,
    SLACK_CONTEXT_TEXT_MAX
  );

  // The fixed labels/fences plus the two rendered budgets are deliberately
  // below the Slack section limit. Do not reintroduce a final raw slice here.
  if (sectionText.length > SLACK_SECTION_TEXT_MAX) {
    throw new Error('FAQ Q&A Slack section exceeded its internal size bound');
  }

  return {
    text: `FAQチャット利用 Q&A ${singleLinePlainText(record.ts)}`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: sectionText },
      },
      {
        type: 'context',
        elements: [{ type: 'plain_text', text: contextText }],
      },
    ],
  };
}

function errorName(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof error.name === 'string'
  ) {
    return error.name;
  }
  return 'unknown error';
}

function effectiveTimeoutMs(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs)) return FAQ_QA_NOTIFY_TIMEOUT_MS;
  return Math.max(0, Math.min(FAQ_QA_NOTIFY_TIMEOUT_MS, Math.trunc(timeoutMs)));
}

function sanitizedRetryAfter(response: Response): string | null {
  const value = response.headers?.get('retry-after')?.trim();
  return value && /^\d{1,6}$/u.test(value) ? value : null;
}

/**
 * Best-effort Slack delivery after the DynamoDB write succeeds.
 *
 * The webhook URL is intentionally read only from the Lambda environment. All
 * delivery failures are contained here so notification cannot turn a successful
 * Q&A log write (or the user's FAQ response) into an error.
 */
export async function notifyFaqQaLog(
  record: FaqQaLogRecord,
  timeoutMs = FAQ_QA_NOTIFY_TIMEOUT_MS
): Promise<void> {
  const webhookUrl = process.env.FAQ_QA_NOTIFY_WEBHOOK_URL?.trim();
  if (!webhookUrl) return;

  if (!isSlackIncomingWebhookUrl(webhookUrl)) {
    console.warn(`${LOG_PREFIX} failed: invalid webhook URL`);
    return;
  }

  const budgetMs = effectiveTimeoutMs(timeoutMs);
  if (budgetMs <= 0) {
    console.warn(
      `${LOG_PREFIX} skipped (qaLogTs=${record.ts}, budgetMs=${budgetMs}, ` +
        `requestedMs=${timeoutMs}, reason=non_positive_budget)`
    );
    return;
  }
  console.info(`${LOG_PREFIX} started (qaLogTs=${record.ts}, timeoutMs=${budgetMs})`);

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildFaqQaSlackPayload(record)),
      signal: AbortSignal.timeout(budgetMs),
      redirect: 'error',
    });
    if (response.ok) {
      console.info(`${LOG_PREFIX} completed (qaLogTs=${record.ts})`);
      return;
    }
    if (response.status === 429) {
      const retryAfter = sanitizedRetryAfter(response);
      console.warn(
        `${LOG_PREFIX} rate limited: HTTP 429, dropped without retry` +
          (retryAfter ? ` (retryAfter=${retryAfter}s)` : '')
      );
      return;
    }
    console.warn(`${LOG_PREFIX} failed: HTTP ${response.status}`);
  } catch (error) {
    const name = errorName(error);
    if (name === 'TimeoutError' || name === 'AbortError') {
      console.warn(`${LOG_PREFIX} timed out (>${budgetMs}ms)`);
      return;
    }
    // Do not log the error message: malformed fetch errors can contain the secret URL.
    console.warn(`${LOG_PREFIX} failed (${name})`);
  }
}
