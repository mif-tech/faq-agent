#!/usr/bin/env node
/** Free FAQ Anthropic and grounded-demo generation contract tests / issue #120 run4. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FREE_ROOT = path.join(HERE, '..', 'functions', 'faq-chat', 'adapters', 'free');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faq-free-generation-test-'));
const outfile = path.join(outDir, 'free-generation.mjs');
const anthropicPath = path.join(FREE_ROOT, 'anthropic-generation.ts').replaceAll('\\', '/');
const groundedPath = path
  .join(FREE_ROOT, 'grounded-demo-generation.ts')
  .replaceAll('\\', '/');

process.on('exit', () => fs.rmSync(outDir, { recursive: true, force: true }));

await build({
  stdin: {
    contents: [
      `export { createAnthropicGenerationPort } from ${JSON.stringify(anthropicPath)};`,
      `export { createGroundedDemoGenerationPort } from ${JSON.stringify(groundedPath)};`,
    ].join('\n'),
    loader: 'ts',
    resolveDir: HERE,
    sourcefile: 'faq-free-generation-test-entry.ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile,
  logLevel: 'silent',
});

const { createAnthropicGenerationPort, createGroundedDemoGenerationPort } = await import(
  pathToFileURL(outfile).href
);

function generationRequest(overrides = {}) {
  return {
    system: 'system prompt',
    messages: [{ role: 'user', content: '質問です' }],
    model: 'test-haiku',
    maxTokens: 321,
    timeoutMs: 4_567,
    temperature: 0,
    jsonSchema: { type: 'object' },
    ...overrides,
  };
}

test('Anthropic port は最小 request を渡し、end_turn の text block を連結する', async () => {
  const calls = [];
  const reasons = [];
  const client = {
    messages: {
      async create(...args) {
        calls.push(args);
        return {
          stop_reason: 'end_turn',
          content: [
            { type: 'text', text: '{"responseType":' },
            { type: 'tool_use', id: 'ignored', name: 'ignored', input: {} },
            { type: 'text', text: '"answer"}' },
          ],
          usage: { input_tokens: 12, output_tokens: 7 },
        };
      },
    },
  };
  const port = createAnthropicGenerationPort({ apiKey: 'test-key', client });
  const request = generationRequest({ onStopReason: (reason) => reasons.push(reason) });

  const result = await port.generate(request);

  assert.deepEqual(calls, [
    [
      {
        model: 'test-haiku',
        max_tokens: 321,
        system: 'system prompt',
        messages: [{ role: 'user', content: '質問です' }],
      },
      { timeout: 4_567, maxRetries: 0 },
    ],
  ]);
  assert.deepEqual(result, {
    text: '{"responseType":"answer"}',
    inputTokens: 12,
    outputTokens: 7,
    stopReason: 'end_turn',
  });
  assert.deepEqual(reasons, ['end_turn']);
});

test('Anthropic port は max_tokens を通知して null にし、既定 timeout を使う', async () => {
  const calls = [];
  const reasons = [];
  const client = {
    messages: {
      async create(...args) {
        calls.push(args);
        return {
          stop_reason: 'max_tokens',
          content: [{ type: 'text', text: '切断された本文' }],
          usage: { input_tokens: 5, output_tokens: 321 },
        };
      },
    },
  };
  const port = createAnthropicGenerationPort({ apiKey: 'test-key', client });

  const result = await port.generate(
    generationRequest({
      timeoutMs: undefined,
      onStopReason: (reason) => reasons.push(reason),
    })
  );

  assert.equal(result, null);
  assert.deepEqual(reasons, ['max_tokens']);
  assert.deepEqual(calls[0][1], { timeout: 20_000, maxRetries: 0 });
});

test('Anthropic port は SDK 例外を1行記録して null を返す', async () => {
  const client = {
    messages: {
      async create() {
        throw new Error('synthetic SDK failure');
      },
    },
  };
  const port = createAnthropicGenerationPort({ apiKey: 'test-key', client });
  const errors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    assert.equal(await port.generate(generationRequest()), null);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(errors.length, 1);
});

test('grounded demo は先頭の実検索結果だけから AI 未使用の answer 封筒を作る', async () => {
  const longContent = 'あ'.repeat(350);
  const first = JSON.stringify({ ref: 'K1', topic: '営業時間', content: longContent });
  const second = JSON.stringify({ ref: 'K2', topic: '所在地', content: '二件目' });
  const reasons = [];
  const port = createGroundedDemoGenerationPort();

  const result = await port.generate(
    generationRequest({
      system: `簡素ルール\n<knowledge_base>\n${first}\n${second}\n</knowledge_base>`,
      onStopReason: (reason) => reasons.push(reason),
    })
  );
  const envelope = JSON.parse(result.text);

  assert.deepEqual(envelope, {
    responseType: 'answer',
    answer: `【ローカル・キーワードモード（AI未使用）】\n${longContent.slice(0, 300)}`,
    clarifyingQuestion: '',
    sourceRefs: ['K1'],
  });
  assert.deepEqual(
    { inputTokens: result.inputTokens, outputTokens: result.outputTokens, stopReason: result.stopReason },
    { inputTokens: 0, outputTokens: 0, stopReason: 'end_turn' }
  );
  assert.deepEqual(reasons, ['end_turn']);
});

test('grounded demo は KB 0件なら scope_fallback 封筒を返す', async () => {
  const reasons = [];
  const port = createGroundedDemoGenerationPort();

  const result = await port.generate(
    generationRequest({
      system: '簡素ルール\n<knowledge_base>\n</knowledge_base>',
      onStopReason: (reason) => reasons.push(reason),
    })
  );

  assert.deepEqual(JSON.parse(result.text), {
    responseType: 'scope_fallback',
    answer: '',
    clarifyingQuestion: '',
    sourceRefs: [],
  });
  assert.equal(result.stopReason, 'end_turn');
  assert.deepEqual(reasons, ['end_turn']);
});

test('grounded demo は先頭refがK1でない不正blockを fail closed にする', async () => {
  const port = createGroundedDemoGenerationPort();
  const row = JSON.stringify({ ref: 'K2', topic: '不正', content: '採用しない本文' });

  const result = await port.generate(
    generationRequest({ system: `<knowledge_base>\n${row}\n</knowledge_base>` })
  );

  assert.deepEqual(JSON.parse(result.text), {
    responseType: 'scope_fallback',
    answer: '',
    clarifyingQuestion: '',
    sourceRefs: [],
  });
});

// ---- PR#124 レビュー対応 ----

test('grounded demo は KB 本文の URL を除去して answer を作る（url_in_answer ガードに落ちない）', async () => {
  const content = '営業時間は9時から18時です。詳細は https://example.com/hours?x=1 または www.example.com/hours を参照。';
  const first = JSON.stringify({ ref: 'K1', topic: '営業時間', content });
  const port = createGroundedDemoGenerationPort();

  const result = await port.generate(
    generationRequest({ system: `簡素ルール\n<knowledge_base>\n${first}\n</knowledge_base>` })
  );
  const envelope = JSON.parse(result.text);

  assert.equal(envelope.responseType, 'answer');
  assert.doesNotMatch(envelope.answer, /https?:\/\/|www\./i);
  assert.match(envelope.answer, /営業時間は9時から18時です/);
  assert.equal(port.supportsStructuredOutput, false);
});

test('Anthropic port は supportsStructuredOutput=false を宣言する（jsonSchema を使わない）', () => {
  const port = createAnthropicGenerationPort({ apiKey: 'k', client: { messages: { create: async () => ({}) } } });
  assert.equal(port.supportsStructuredOutput, false);
});

test('grounded demo の URL 除去は ASCII に限定され、スペースなしで続く日本語本文を残す', async () => {
  const content = '詳細はhttps://example.com/hoursをご覧ください。受付は9時からです。Awww.example.com/xも参照。';
  const first = JSON.stringify({ ref: 'K1', topic: '営業時間', content });
  const port = createGroundedDemoGenerationPort();
  const result = await port.generate(
    generationRequest({ system: `簡素ルール\n<knowledge_base>\n${first}\n</knowledge_base>` })
  );
  const envelope = JSON.parse(result.text);
  assert.doesNotMatch(envelope.answer, /https?:\/\/|www\./i);
  assert.match(envelope.answer, /詳細は\s*をご覧ください。受付は9時からです。/);
  assert.match(envelope.answer, /も参照。/);
});

test('grounded demo は裸のスキームや www. 直後が非ASCIIでも除去し、ガードと同条件になる', async () => {
  const content = '案内はwww.日本語.jp です。詳細は https:// をご覧ください。';
  const first = JSON.stringify({ ref: 'K1', topic: '案内', content });
  const port = createGroundedDemoGenerationPort();
  const result = await port.generate(generationRequest({ system: `簡素ルール\n<knowledge_base>\n${first}\n</knowledge_base>` }));
  const envelope = JSON.parse(result.text);
  assert.equal(envelope.responseType, 'answer');
  assert.doesNotMatch(envelope.answer, /https?:\/\/|www\./i);
  assert.match(envelope.answer, /をご覧ください。/);
});
