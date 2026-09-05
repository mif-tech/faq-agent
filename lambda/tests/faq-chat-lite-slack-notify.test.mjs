#!/usr/bin/env node
/** Public-only tests for best-effort FAQ Q&A Slack webhook delivery. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAMBDA_ROOT = path.resolve(HERE, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'faq-lite-slack-notify-test-'));
const bundlePath = path.join(tempRoot, 'faq-qa-slack-notify.mjs');
// Keep a realistic runtime value without placing a credential-shaped URL in public source.
const WEBHOOK_URL = [
  'https://hooks.slack.com',
  'services',
  'T00000000',
  'B00000000',
  'x'.repeat(24),
].join('/');
const LOG_PREFIX = '[faq-chat] Q&A Slack notification';

const record = {
  dateBucket: '2026-08-30',
  ts: '2026-08-30T12:34:56.000Z#abcd1234',
  question: `正規化・マスク済み [REDACTED_EMAIL] ${'Q'.repeat(320)} QUESTION_TAIL`,
  answer: `利用者へ返した回答 ${'A'.repeat(720)} ANSWER_TAIL`,
  responseType: 'kb_answer',
  route: 'kb_answer',
  scopeFallback: false,
  failureKind: null,
  guardDetail: null,
  sources: ['public-source'],
  model: 'public-model',
  totalMs: 321,
  ttl: 1_800_000_000,
};

after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

async function loadNotifier() {
  await build({
    entryPoints: [
      path.join(
        LAMBDA_ROOT,
        'functions',
        'faq-chat',
        'adapters',
        'faq-qa-slack-notify.ts'
      ),
    ],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outfile: bundlePath,
    logLevel: 'silent',
  });
  return import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);
}

const notifier = await loadNotifier();

async function withRuntime(
  { webhookUrl, fetchImpl, timeoutImpl },
  callback
) {
  const previousWebhookUrl = process.env.FAQ_QA_NOTIFY_WEBHOOK_URL;
  const previousFetch = globalThis.fetch;
  const previousTimeout = AbortSignal.timeout;
  const previousWarn = console.warn;
  const previousInfo = console.info;
  const warnings = [];
  const infos = [];

  if (webhookUrl === undefined) delete process.env.FAQ_QA_NOTIFY_WEBHOOK_URL;
  else process.env.FAQ_QA_NOTIFY_WEBHOOK_URL = webhookUrl;
  globalThis.fetch = fetchImpl;
  AbortSignal.timeout = timeoutImpl;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  console.info = (...args) => infos.push(args.map(String).join(' '));

  try {
    await callback({ warnings, infos });
  } finally {
    if (previousWebhookUrl === undefined) delete process.env.FAQ_QA_NOTIFY_WEBHOOK_URL;
    else process.env.FAQ_QA_NOTIFY_WEBHOOK_URL = previousWebhookUrl;
    globalThis.fetch = previousFetch;
    AbortSignal.timeout = previousTimeout;
    console.warn = previousWarn;
    console.info = previousInfo;
  }
}

function hasLoneSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

test('webhook success posts the saved masked record with bounded Slack content', async () => {
  const calls = [];
  const signal = new AbortController().signal;
  await withRuntime(
    {
      webhookUrl: WEBHOOK_URL,
      timeoutImpl(timeoutMs) {
        assert.equal(timeoutMs, 2_000);
        return signal;
      },
      async fetchImpl(url, init) {
        calls.push({ url, init });
        return { ok: true, status: 200 };
      },
    },
    async ({ warnings, infos }) => {
      await notifier.notifyFaqQaLog(record);
      assert.deepEqual(warnings, []);
      assert.deepEqual(infos, [
        `${LOG_PREFIX} started (qaLogTs=${record.ts}, timeoutMs=2000)`,
        `${LOG_PREFIX} completed (qaLogTs=${record.ts})`,
      ]);
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, WEBHOOK_URL);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(calls[0].init.headers, { 'content-type': 'application/json' });
  assert.strictEqual(calls[0].init.signal, signal);
  assert.equal(calls[0].init.redirect, 'error');

  const payload = JSON.parse(calls[0].init.body);
  const section = payload.blocks[0].text.text;
  const context = payload.blocks[1].elements[0].text;
  assert.equal(payload.blocks[0].text.type, 'mrkdwn');
  assert.equal(payload.blocks[1].elements[0].type, 'plain_text');
  assert.equal(section.includes(record.question.slice(0, 300)), true);
  assert.equal(section.includes(record.question.slice(300)), false);
  assert.equal(section.includes(record.answer.slice(0, 700)), true);
  assert.equal(section.includes(record.answer.slice(700)), false);
  assert.match(section, /\[REDACTED_EMAIL\]/u);
  assert.match(section, /\*Q:\*\n```[\s\S]+```\n\*A:\*\n```[\s\S]+```/u);
  assert.equal(section.length <= 2_900, true);
  assert.equal(context.length <= 1_900, true);
  assert.match(context, /responseType: kb_answer/u);
  assert.match(context, /route: kb_answer/u);
  assert.match(context, /totalMs: 321/u);
  assert.match(context, /sources: public-source/u);
  assert.match(payload.text, /2026-08-30T12:34:56\.000Z#abcd1234/u);
});

test('Q&A fences contain newline/label injection and neutralize backticks and mentions', () => {
  const payload = notifier.buildFaqQaSlackPayload({
    ...record,
    question: 'first line\n*A:* forged answer\n``` <!channel> <@U123> A&B `tail`',
    answer: 'real answer\n*Q:* forged question\n```` and `more`',
  });
  const section = payload.blocks[0].text.text;
  const fenceParts = section.split('```');

  assert.equal(fenceParts.length, 5, 'only the four system-owned fences may remain');
  assert.match(fenceParts[1], /first line\n\*A:\* forged answer/u);
  assert.match(fenceParts[2], /\*A:\*/u, 'the real answer label remains outside Q content');
  assert.match(fenceParts[3], /real answer\n\*Q:\* forged question/u);
  assert.equal(section.replaceAll('```', '').includes('`'), false);
  assert.match(section, /｀｀｀/u);
  assert.match(section, /&lt;!channel&gt;/u);
  assert.match(section, /&lt;@U123&gt;/u);
  assert.match(section, /A&amp;B/u);
  assert.equal(section.includes('<!channel>'), false);
  assert.equal(section.includes('<@U123>'), false);
});

test('rendering preserves emoji boundaries and never slices an mrkdwn entity', () => {
  const payload = notifier.buildFaqQaSlackPayload({
    ...record,
    question: `${'Q'.repeat(299)}😀TAIL`,
    answer: '&<>'.repeat(1_000),
    model: '😀'.repeat(2_000),
  });
  const section = payload.blocks[0].text.text;
  const context = payload.blocks[1].elements[0].text;
  const fenceParts = section.split('```');
  const questionBlock = fenceParts[1];
  const answerBlock = fenceParts[3];

  assert.match(questionBlock, /😀…（続きはQ&amp;Aログ参照）/u);
  assert.equal(questionBlock.includes('TAIL'), false);
  assert.equal(hasLoneSurrogate(section), false);
  assert.equal(hasLoneSurrogate(context), false);
  assert.equal(section.length <= 2_900, true);
  assert.equal(context.length <= 1_900, true);
  assert.equal(context.endsWith('…'), true);
  assert.equal(
    answerBlock.replaceAll('&amp;', '').replaceAll('&lt;', '').replaceAll('&gt;', '').includes('&'),
    false,
    'no partial entity may survive a rendered-size truncation'
  );
  assert.match(section, /\*Q:\*/u);
  assert.match(section, /\*A:\*/u);
});

test('webhook HTTP and transport failures warn without rejecting or leaking content', async () => {
  const secretError = Object.assign(
    new Error(`failed to fetch ${WEBHOOK_URL}?question=${record.question}`),
    { name: 'TypeError' }
  );
  const outcomes = [
    { ok: false, status: 503 },
    secretError,
  ];
  const signal = new AbortController().signal;

  await withRuntime(
    {
      webhookUrl: WEBHOOK_URL,
      timeoutImpl: () => signal,
      async fetchImpl() {
        const outcome = outcomes.shift();
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    },
    async ({ warnings, infos }) => {
      await assert.doesNotReject(notifier.notifyFaqQaLog(record));
      await assert.doesNotReject(notifier.notifyFaqQaLog(record));
      assert.equal(warnings.length, 2);
      assert.match(warnings[0], /failed: HTTP 503/u);
      assert.match(warnings[1], /failed \(TypeError\)/u);
      assert.equal(infos.length, 2);
      assert.equal(infos.every((info) => info.startsWith(`${LOG_PREFIX} started`)), true);
      for (const message of [...warnings, ...infos]) {
        assert.equal(message.includes(WEBHOOK_URL), false);
        assert.equal(message.includes(record.question), false);
      }
    }
  );
});

test('HTTP 429 is warned and dropped once without a synchronous retry', async () => {
  let fetchCalls = 0;
  const signal = new AbortController().signal;
  await withRuntime(
    {
      webhookUrl: WEBHOOK_URL,
      timeoutImpl(timeoutMs) {
        assert.equal(timeoutMs, 600);
        return signal;
      },
      async fetchImpl() {
        fetchCalls += 1;
        return {
          ok: false,
          status: 429,
          headers: { get: (name) => (name === 'retry-after' ? '2' : null) },
        };
      },
    },
    async ({ warnings, infos }) => {
      await assert.doesNotReject(notifier.notifyFaqQaLog(record, 600));
      assert.deepEqual(warnings, [
        `${LOG_PREFIX} rate limited: HTTP 429, dropped without retry (retryAfter=2s)`,
      ]);
      assert.deepEqual(infos, [
        `${LOG_PREFIX} started (qaLogTs=${record.ts}, timeoutMs=600)`,
      ]);
    }
  );
  assert.equal(fetchCalls, 1);
});

test('webhook timeout abort is warn-only and reports the actual caller budget', async () => {
  const timeoutError = Object.assign(new Error('deadline exceeded'), {
    name: 'TimeoutError',
  });
  let timeoutCalls = 0;

  await withRuntime(
    {
      webhookUrl: WEBHOOK_URL,
      timeoutImpl(timeoutMs) {
        timeoutCalls += 1;
        assert.equal(timeoutMs, 375);
        return AbortSignal.abort(timeoutError);
      },
      async fetchImpl(_url, init) {
        assert.equal(init.signal.aborted, true);
        throw init.signal.reason;
      },
    },
    async ({ warnings, infos }) => {
      await assert.doesNotReject(notifier.notifyFaqQaLog(record, 375));
      assert.deepEqual(warnings, [`${LOG_PREFIX} timed out (>375ms)`]);
      assert.deepEqual(infos, [
        `${LOG_PREFIX} started (qaLogTs=${record.ts}, timeoutMs=375)`,
      ]);
    }
  );

  assert.equal(notifier.FAQ_QA_NOTIFY_TIMEOUT_MS, 2_000);
  assert.equal(timeoutCalls, 1);
});

test('caller timeout is honored below the maximum and capped at two seconds', async () => {
  const timeoutCalls = [];
  await withRuntime(
    {
      webhookUrl: WEBHOOK_URL,
      timeoutImpl(timeoutMs) {
        timeoutCalls.push(timeoutMs);
        return new AbortController().signal;
      },
      async fetchImpl() {
        return { ok: true, status: 200 };
      },
    },
    async ({ warnings, infos }) => {
      await notifier.notifyFaqQaLog(record, 250);
      await notifier.notifyFaqQaLog(record, 20_000);
      assert.deepEqual(warnings, []);
      assert.equal(infos.length, 4);
      assert.match(infos[0], /timeoutMs=250/u);
      assert.match(infos[2], /timeoutMs=2000/u);
    }
  );
  assert.deepEqual(timeoutCalls, [250, 2_000]);
});

test('non-positive timeout budget skips before payload rendering, timeout creation, fetch, or start trace', async () => {
  let fetchCalls = 0;
  let timeoutCalls = 0;
  const payloadMustNotBeBuilt = { ...record };
  Object.defineProperty(payloadMustNotBeBuilt, 'question', {
    get() {
      throw new Error('payload must not be rendered');
    },
  });
  await withRuntime(
    {
      webhookUrl: WEBHOOK_URL,
      timeoutImpl() {
        timeoutCalls += 1;
        throw new Error('timeout signal must not be created');
      },
      async fetchImpl() {
        fetchCalls += 1;
        throw new Error('fetch must not be called');
      },
    },
    async ({ warnings, infos }) => {
      await notifier.notifyFaqQaLog(payloadMustNotBeBuilt, 0);
      await notifier.notifyFaqQaLog(record, -25);
      assert.deepEqual(warnings, [
        `${LOG_PREFIX} skipped (qaLogTs=${record.ts}, budgetMs=0, requestedMs=0, reason=non_positive_budget)`,
        `${LOG_PREFIX} skipped (qaLogTs=${record.ts}, budgetMs=0, requestedMs=-25, reason=non_positive_budget)`,
      ]);
      assert.deepEqual(infos, []);
    }
  );

  assert.equal(fetchCalls, 0);
  assert.equal(timeoutCalls, 0);
});

test('invalid webhook URLs warn without fetch, timeout creation, or start trace', async () => {
  const invalidUrls = [
    'https://evil.example/services/T/B/token',
    'https://hooks.slack.com.evil.example/services/T/B/token',
    'http://hooks.slack.com/services/T/B/token',
    'https://user@hooks.slack.com/services/T/B/token',
    'https://user:password@hooks.slack.com/services/T/B/token',
    'https://hooks.slack.com:8443/services/T/B/token',
    'https://hooks.slack.com/services/T/B',
    'https://hooks.slack.com/services/T/B/token/extra',
    'https://hooks.slack.com/services/T/B/token/',
    'https://hooks.slack.com/services/T-/B/token',
    'https://hooks.slack.com/services/T/B/token?channel=other',
    'https://hooks.slack.com/services/T/B/token#fragment',
    'not a url',
  ];
  let fetchCalls = 0;
  let timeoutCalls = 0;

  for (const webhookUrl of invalidUrls) {
    await withRuntime(
      {
        webhookUrl,
        timeoutImpl() {
          timeoutCalls += 1;
          throw new Error('timeout signal must not be created');
        },
        async fetchImpl() {
          fetchCalls += 1;
          throw new Error('fetch must not be called');
        },
      },
      async ({ warnings, infos }) => {
        await notifier.notifyFaqQaLog(record);
        assert.deepEqual(warnings, [`${LOG_PREFIX} failed: invalid webhook URL`]);
        assert.deepEqual(infos, []);
      }
    );
  }

  assert.equal(fetchCalls, 0);
  assert.equal(timeoutCalls, 0);
});

test('unset webhook environment is a complete no-op', async () => {
  let fetchCalls = 0;
  let timeoutCalls = 0;
  await withRuntime(
    {
      webhookUrl: undefined,
      timeoutImpl() {
        timeoutCalls += 1;
        throw new Error('timeout signal must not be created');
      },
      async fetchImpl() {
        fetchCalls += 1;
        throw new Error('fetch must not be called');
      },
    },
    async ({ warnings, infos }) => {
      await notifier.notifyFaqQaLog(record);
      assert.deepEqual(warnings, []);
      assert.deepEqual(infos, []);
    }
  );

  assert.equal(fetchCalls, 0);
  assert.equal(timeoutCalls, 0);
});
