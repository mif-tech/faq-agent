#!/usr/bin/env node
/** Free FAQ Anthropic and grounded-demo generation contract tests / . */
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
const anthropicSmalltalkPath = path
  .join(FREE_ROOT, 'anthropic-smalltalk.ts')
  .replaceAll('\\', '/');
const freeIndexPath = path.join(FREE_ROOT, 'index.ts').replaceAll('\\', '/');
const groundedPath = path
  .join(FREE_ROOT, 'grounded-demo-generation.ts')
  .replaceAll('\\', '/');

process.on('exit', () => fs.rmSync(outDir, { recursive: true, force: true }));

await build({
  stdin: {
    contents: [
      `export { createAnthropicGenerationPort } from ${JSON.stringify(anthropicPath)};`,
      `export { createAnthropicSmalltalkPort } from ${JSON.stringify(anthropicSmalltalkPath)};`,
      `export { createFreeFaqPorts } from ${JSON.stringify(freeIndexPath)};`,
      `export { createGroundedDemoGenerationPort } from ${JSON.stringify(groundedPath)};`,
      "export { default as AnthropicSdk } from '@anthropic-ai/sdk';",
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
  plugins: [
    {
      name: 'mock-free-kb-source',
      setup(esbuild) {
        esbuild.onResolve({ filter: /dynamodb-entries\.js$/ }, () => ({
          path: 'dynamodb-entries',
          namespace: 'faq-free-generation-stub',
        }));
        esbuild.onLoad(
          { filter: /^dynamodb-entries$/, namespace: 'faq-free-generation-stub' },
          () => ({
            contents: `export const dynamoDbFaqKbSource = {
              async loadPublicEntries() { throw new Error('default KB source must not be called'); }
            };`,
            loader: 'js',
          })
        );
      },
    },
  ],
});

const {
  createAnthropicGenerationPort,
  createAnthropicSmalltalkPort,
  createFreeFaqPorts,
  createGroundedDemoGenerationPort,
  AnthropicSdk,
} = await import(pathToFileURL(outfile).href);

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

test('free factory は key ありで構造化出力対応 smalltalk port を選び request を伝える', async () => {
  const calls = [];
  const reasons = [];
  const schema = {
    type: 'object',
    properties: { route: { type: 'string' } },
    required: ['route'],
  };
  const client = {
    messages: {
      async create(...args) {
        calls.push(args);
        return {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '{"route":"faq_or_mixed"}' }],
          usage: { input_tokens: 17, output_tokens: 9 },
        };
      },
    },
  };
  const ports = createFreeFaqPorts({
    apiKey: 'test-key',
    client,
    kbSource: { loadPublicEntries: async () => [] },
  });
  const request = generationRequest({
    jsonSchema: schema,
    onStopReason: (reason) => reasons.push(reason),
  });

  const result = await ports.smalltalkGeneration.complete(request);

  assert.equal(ports.smalltalkGeneration.supportsStructuredOutput, true);
  assert.deepEqual(calls, [
    [
      {
        model: 'test-haiku',
        max_tokens: 321,
        system: 'system prompt',
        messages: [{ role: 'user', content: '質問です' }],
        temperature: 0,
        output_config: { format: { type: 'json_schema', schema } },
      },
      { timeout: 4_567, maxRetries: 0 },
    ],
  ]);
  assert.deepEqual(result, {
    text: '{"route":"faq_or_mixed"}',
    inputTokens: 17,
    outputTokens: 9,
    stopReason: 'end_turn',
  });
  assert.deepEqual(reasons, ['end_turn']);
});

test('free factory は key なしで null stub を選び structured output 非対応を宣言する', async () => {
  let clientCalls = 0;
  const ports = createFreeFaqPorts({
    apiKey: null,
    client: {
      messages: {
        async create() {
          clientCalls += 1;
          throw new Error('must not be called');
        },
      },
    },
    kbSource: { loadPublicEntries: async () => [] },
  });

  assert.equal(ports.smalltalkGeneration.supportsStructuredOutput, false);
  assert.equal(await ports.smalltalkGeneration.complete(generationRequest()), null);
  assert.equal(clientCalls, 0);
});

test('free factory は ANTHROPIC_API_KEY からも smalltalk port を選ぶ', () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  try {
    process.env.ANTHROPIC_API_KEY = 'environment-test-key';
    const ports = createFreeFaqPorts({
      client: { messages: { create: async () => ({}) } },
      kbSource: { loadPublicEntries: async () => [] },
    });
    assert.equal(ports.smalltalkGeneration.supportsStructuredOutput, true);
  } finally {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
  }
});

test('Anthropic smalltalk port は provider 例外を throw せず null にする', async () => {
  const port = createAnthropicSmalltalkPort({
    apiKey: 'test-key',
    client: {
      messages: {
        async create() {
          throw new Error('synthetic smalltalk failure');
        },
      },
    },
  });
  const errors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    assert.equal(await port.complete(generationRequest()), null);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(port.supportsStructuredOutput, true);
  assert.equal(errors.length, 1);
});

test('Anthropic smalltalk port は非 end_turn を通知して null にする', async () => {
  const reasons = [];
  const port = createAnthropicSmalltalkPort({
    apiKey: 'test-key',
    client: {
      messages: {
        async create() {
          return {
            stop_reason: 'max_tokens',
            content: [{ type: 'text', text: '切断された JSON' }],
            usage: { input_tokens: 4, output_tokens: 321 },
          };
        },
      },
    },
  });

  assert.equal(
    await port.complete(
      generationRequest({ onStopReason: (reason) => reasons.push(reason) })
    ),
    null
  );
  assert.deepEqual(reasons, ['max_tokens']);
});

test('Anthropic smalltalk port は schema 400 のときだけ schema 無しで1回再試行する', async () => {
  const calls = [];
  let fallbackCalls = 0;
  const schema = { type: 'object', required: ['route'] };
  const client = {
    messages: {
      async create(...args) {
        calls.push(args);
        if (calls.length === 1) {
          throw AnthropicSdk.APIError.generate(
            400,
            {
              type: 'error',
              error: { type: 'invalid_request_error', message: 'unsupported output_config' },
            },
            undefined,
            new Headers()
          );
        }
        return {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '{"route":"faq_or_mixed"}' }],
          usage: { input_tokens: 20, output_tokens: 8 },
        };
      },
    },
  };
  const port = createAnthropicSmalltalkPort({ apiKey: 'test-key', client });
  const errors = [];
  const originalConsoleError = console.error;
  let result;
  console.error = (...args) => errors.push(args);
  try {
    result = await port.complete(
      generationRequest({
        jsonSchema: schema,
        onStructuredOutputFallback: () => {
          fallbackCalls += 1;
        },
      })
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0][0].output_config, {
    format: { type: 'json_schema', schema },
  });
  assert.equal(Object.hasOwn(calls[1][0], 'output_config'), false);
  assert.deepEqual(calls[0][1], { timeout: 4_567, maxRetries: 0 });
  assert.deepEqual(calls[1][1], { timeout: 4_567, maxRetries: 0 });
  assert.equal(fallbackCalls, 1);
  assert.equal(errors.length, 1);
  assert.equal(result.text, '{"route":"faq_or_mixed"}');
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

// ---- レビュー対応 ----

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

test('free factory は guardBusinessTerms オプションを guardVocabulary として公開する', () => {
  const ports = createFreeFaqPorts({
    apiKey: null,
    kbSource: { loadPublicEntries: async () => [] },
    guardBusinessTerms: ['MyProduct', 'マイサービス'],
  });
  assert.deepEqual(ports.guardVocabulary, {
    businessTerms: ['MyProduct', 'マイサービス'],
  });
});

test('free factory は FAQ_GUARD_BUSINESS_TERMS を解決し、無指定なら field を出さない', () => {
  const original = process.env.FAQ_GUARD_BUSINESS_TERMS;
  const base = { apiKey: null, kbSource: { loadPublicEntries: async () => [] } };
  try {
    delete process.env.FAQ_GUARD_BUSINESS_TERMS;
    assert.equal(Object.hasOwn(createFreeFaqPorts(base), 'guardVocabulary'), false);

    process.env.FAQ_GUARD_BUSINESS_TERMS = ' Foo, ,Bar ';
    assert.deepEqual(createFreeFaqPorts(base).guardVocabulary, {
      businessTerms: ['Foo', 'Bar'],
    });

    // 明示オプション（空配列含む）は env より優先される
    const overridden = createFreeFaqPorts({ ...base, guardBusinessTerms: [] });
    assert.equal(Object.hasOwn(overridden, 'guardVocabulary'), false);
  } finally {
    if (original === undefined) delete process.env.FAQ_GUARD_BUSINESS_TERMS;
    else process.env.FAQ_GUARD_BUSINESS_TERMS = original;
  }
});

test('free factory は answer と smalltalk に同一 client を配線する', async () => {
  const calls = [];
  const client = {
    messages: {
      async create(...args) {
        calls.push(args[0].max_tokens);
        return {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '{"ok":true}' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    },
  };
  const ports = createFreeFaqPorts({
    apiKey: 'test-key',
    client,
    kbSource: { loadPublicEntries: async () => [] },
  });

  await ports.answerGeneration.generate(generationRequest({ maxTokens: 111 }));
  await ports.smalltalkGeneration.complete(generationRequest({ maxTokens: 222 }));

  assert.deepEqual(calls, [111, 222]);
});
