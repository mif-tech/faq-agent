#!/usr/bin/env node
/**
 * faq-chat handler の HTTP event -> response 実行テスト / issue #120 run2
 *
 * handler core の import 閉包は shared/ を持たず、各テストは factory に公開 repo 用
 * stub を注入する。下の小さな wrapper は既存テストの差し替え API を保つ。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAQ_ROOT = path.join(HERE, '..', 'functions', 'faq-chat');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faq-handler-test-'));
process.on('exit', () => fs.rmSync(outDir, { recursive: true, force: true }));
const outfile = path.join(outDir, 'handler-test-entry.mjs');
const handlerPath = path.join(FAQ_ROOT, 'handler.ts').replaceAll('\\', '/');
const stubPath = path.join(FAQ_ROOT, 'adapters', 'stub.ts').replaceAll('\\', '/');
const freePath = path.join(FAQ_ROOT, 'adapters', 'free', 'index.ts').replaceAll('\\', '/');
const remoteContractPath = path
  .join(FAQ_ROOT, 'adapters', 'remote', 'contract.ts')
  .replaceAll('\\', '/');
const SAMPLE_KB = JSON.parse(
  fs.readFileSync(path.join(HERE, '..', 'eval', 'faq-chat', 'sample-kb.json'), 'utf8')
);

await build({
  stdin: {
    contents: [
      `import { createFaqHandler } from ${JSON.stringify(handlerPath)};`,
      'let activeHandler;',
      'export function __setFaqPortsForTest(ports, remoteRag) { activeHandler = createFaqHandler(ports, remoteRag); }',
      "export async function handler(event, context) { if (!activeHandler) throw new Error('FAQ test handler is not configured'); return activeHandler(event, context); }",
      `export { createStubFaqPorts } from ${JSON.stringify(stubPath)};`,
      `export { createFreeFaqPorts } from ${JSON.stringify(freePath)};`,
      `export { parseRemoteV1RetrieveRequest } from ${JSON.stringify(remoteContractPath)};`,
    ].join('\n'),
    loader: 'ts',
    resolveDir: HERE,
    sourcefile: 'faq-chat-handler-test-entry.ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile,
  // 未モックの shared import 等は実行時の undefined ではなくビルド警告として見えるようにする
  logLevel: 'warning',
  plugins: [
    {
      name: 'mock-faq-handler-dependencies',
      setup(esbuild) {
        esbuild.onResolve(
          { filter: /dynamodb-entries\.js$/ },
          () => ({ path: 'dynamodb-entries', namespace: 'faq-handler-stub' })
        );
        esbuild.onResolve(
          { filter: /shared[\\/]kb-injection\.js$/ },
          () => ({ path: 'kb-injection', namespace: 'faq-handler-stub' })
        );
        esbuild.onResolve(
          { filter: /shared[\\/]llm-provider\.js$/ },
          () => ({ path: 'llm-provider', namespace: 'faq-handler-stub' })
        );
        esbuild.onResolve(
          { filter: /shared[\\/]repositories[\\/]knowledgeEntries\.js$/ },
          () => ({ path: 'knowledge-entries', namespace: 'faq-handler-stub' })
        );
        esbuild.onLoad(
          { filter: /^dynamodb-entries$/, namespace: 'faq-handler-stub' },
          () => ({
            contents: `
              export const dynamoDbFaqKbSource = {
                async loadPublicEntries() {
                  throw new Error('default free KB source must not be called');
                },
              };
            `,
            loader: 'js',
          })
        );
        esbuild.onLoad(
          { filter: /^kb-injection$/, namespace: 'faq-handler-stub' },
          () => ({
            contents:
              'export async function buildQueryKbInjection() {' +
              " throw new Error('production KB adapter must not be called'); }",
            loader: 'js',
          })
        );
        esbuild.onLoad(
          { filter: /^llm-provider$/, namespace: 'faq-handler-stub' },
          () => ({
            contents:
              "export const DEFAULT_FAQ_MODEL = 'production-model-must-not-be-used';" +
              ' export async function callClaudeFaq() {' +
              " throw new Error('production LLM adapter must not be called'); }",
            loader: 'js',
          })
        );
        esbuild.onLoad(
          { filter: /^knowledge-entries$/, namespace: 'faq-handler-stub' },
          () => ({
            contents:
              'export async function listAllActive() {' +
              " throw new Error('default free KB loader must not be called'); }",
            loader: 'js',
          })
        );
      },
    },
  ],
});

const {
  __setFaqPortsForTest,
  createFreeFaqPorts,
  createStubFaqPorts,
  handler,
  parseRemoteV1RetrieveRequest,
} = await import(pathToFileURL(outfile).href);

const SERVICE_UNAVAILABLE_MESSAGE =
  'ただいま混み合っております。しばらくしてからもう一度お試しください。';
const TECHNICAL_FALLBACK_MESSAGE =
  '申し訳ありません。一時的に回答を生成できませんでした。お手数ですが、もう一度お試しください。';
const TEST_CONTEXT = {
  getRemainingTimeInMillis: () => 30_000,
};
const NORMAL_ENTRY = {
  id: 'entry-pricing',
  topic: '料金',
  canonicalUrl: 'https://example.com/pricing',
  content: '基本料金は500円です。',
};

let defaultPorts;

beforeEach(() => {
  defaultPorts = createStubFaqPorts({ retrieval: 'empty', settings: { enabled: true } });
  __setFaqPortsForTest(defaultPorts);
});

function createFreeHandlerPorts(options, settings = { enabled: true }) {
  const storage = createStubFaqPorts({ settings }).storage;
  return { ...createFreeFaqPorts(options), storage };
}

function createEvent({ messages, rawBody } = {}) {
  return {
    version: '2.0',
    routeKey: 'POST /faq-chat',
    rawPath: '/faq-chat',
    headers: { 'content-type': 'application/json' },
    requestContext: {
      http: {
        method: 'POST',
        path: '/faq-chat',
      },
    },
    body: rawBody ?? JSON.stringify({ messages }),
    isBase64Encoded: false,
  };
}

async function invoke(options, context = TEST_CONTEXT) {
  const captured = { log: [], warn: [], error: [] };
  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  console.log = (...args) => captured.log.push(args);
  console.warn = (...args) => captured.warn.push(args);
  console.error = (...args) => captured.error.push(args);
  try {
    const response = await handler(createEvent(options), context);
    assert.equal(typeof response, 'object');
    return {
      response,
      body: JSON.parse(response.body),
      captured,
    };
  } finally {
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
  }
}

/** faq_chat メトリクスの最終行。0件なら TypeError ではなく読める失敗理由で落とす */
function lastFaqMetric(captured) {
  const metrics = faqMetrics(captured);
  assert.ok(metrics.length > 0, 'faq_chat metric must be logged');
  return metrics.at(-1);
}

function faqMetrics(captured) {
  const metrics = [];
  for (const args of captured.log) {
    for (const value of args) {
      if (typeof value !== 'string' || !value.startsWith('{')) continue;
      try {
        const parsed = JSON.parse(value);
        if (parsed.metric === 'faq_chat') metrics.push(parsed);
      } catch {
        // 人間向けログ行は対象外。
      }
    }
  }
  return metrics;
}

test('正常系: stub 出典を解決して200を返し、PIIマスク後のQ&Aを1件保存する', async () => {
  const ports = createStubFaqPorts({
    entries: [NORMAL_ENTRY],
    retrieval: 'normal',
    answerGeneration: 'envelope',
    smalltalkGeneration: 'max_tokens',
  });
  __setFaqPortsForTest(ports);
  const question = '料金を教えてください。連絡先は test.user@example.com です。';

  const { response, body } = await invoke({
    messages: [{ role: 'user', content: question }],
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(body, {
    answer: 'スタブ回答です。',
    answerable: true,
    sources: [
      {
        entryId: 'entry-pricing',
        topic: '料金',
        url: 'https://example.com/pricing',
      },
    ],
    responseType: 'kb_answer',
  });
  assert.equal(ports.retrieval.calls.length, 1);
  assert.equal(ports.answerGeneration.calls.length, 1);
  assert.equal(ports.smalltalkGeneration.calls.length, 0);
  assert.match(ports.answerGeneration.calls[0].system, /<knowledge_base>/);
  assert.deepEqual(ports.answerGeneration.calls[0].messages, [
    { role: 'user', content: question },
  ]);
  assert.equal(ports.answerGeneration.calls[0].model, 'stub-model');
  assert.equal(ports.answerGeneration.calls[0].jsonSchema, undefined);

  const putCalls = ports.storage.qaLogs;
  assert.equal(putCalls.length, 1);
  assert.equal(putCalls[0].responseType, 'kb_answer');
  assert.equal(putCalls[0].route, 'kb_answer');
  assert.equal(putCalls[0].question.includes('test.user@example.com'), false);
  assert.match(putCalls[0].question, /\[メール\]/);
  assert.deepEqual(putCalls[0].sources, ['料金']);
});

test('free ports: grounded demo は実検索結果から200 kb_answerと解決済みsourceを返す', async () => {
  const ports = createFreeHandlerPorts({
    kbSource: { loadPublicEntries: async () => SAMPLE_KB },
    apiKey: null,
  });
  __setFaqPortsForTest(ports);

  const { response, body } = await invoke({
    messages: [{ role: 'user', content: '営業時間は何時から何時までですか' }],
  });

  assert.equal(response.statusCode, 200);
  assert.match(body.answer, /^【ローカル・キーワードモード（AI未使用）】/);
  assert.equal(body.answerable, true);
  assert.equal(body.responseType, 'kb_answer');
  assert.deepEqual(body.sources, [
    {
      entryId: 'sample-kb-hours',
      topic: '営業時間',
      url: 'https://example.com/hours',
    },
  ]);
});

test('free ports: generated smalltalk が無効でも router null からKB経路へ継続する', async () => {
  const ports = createFreeHandlerPorts(
    {
      kbSource: { loadPublicEntries: async () => SAMPLE_KB },
      apiKey: null,
    },
    { enabled: true, smalltalkMode: 'generated' }
  );
  let smalltalkCalls = 0;
  const disabledSmalltalk = ports.smalltalkGeneration;
  ports.smalltalkGeneration = {
    async complete(request) {
      smalltalkCalls += 1;
      return disabledSmalltalk.complete(request);
    },
  };
  __setFaqPortsForTest(ports);

  const { response, body, captured } = await invoke({
    messages: [{ role: 'user', content: '営業時間は何時から何時までですか' }],
  });

  assert.equal(response.statusCode, 200);
  assert.equal(body.responseType, 'kb_answer');
  assert.match(body.answer, /^【ローカル・キーワードモード（AI未使用）】/);
  assert.equal(smalltalkCalls, 1);
  assert.equal(lastFaqMetric(captured).guard_reject_reason, 'router_error');
});

test('free factory は model・grounded/Anthropic・key連動smalltalkをcompositionする', async () => {
  const originalFreeModel = process.env.FAQ_FREE_MODEL;
  try {
    process.env.FAQ_FREE_MODEL = 'custom-free-model';
    const grounded = createFreeFaqPorts({ apiKey: null });
    assert.equal(grounded.defaultModel, 'custom-free-model');
    assert.equal(
      await grounded.smalltalkGeneration.complete({
        system: 'unused',
        messages: [{ role: 'user', content: 'unused' }],
        model: 'unused',
        maxTokens: 1,
      }),
      null
    );
    const demoRow = JSON.stringify({ ref: 'K1', topic: '料金', content: '料金は500円です。' });
    const demoResult = await grounded.answerGeneration.generate({
      system: `<knowledge_base>\n${demoRow}\n</knowledge_base>`,
      messages: [{ role: 'user', content: '料金は？' }],
      model: grounded.defaultModel,
      maxTokens: 100,
    });
    assert.match(JSON.parse(demoResult.text).answer, /ローカル・キーワードモード/);

    delete process.env.FAQ_FREE_MODEL;
    assert.equal(
      createFreeFaqPorts({ apiKey: null }).defaultModel,
      'claude-haiku-4-5-20251001'
    );

    const providerCalls = [];
    const anthropic = createFreeFaqPorts({
      apiKey: 'test-key',
      client: {
        messages: {
          async create(...args) {
            providerCalls.push(args);
            return {
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: '{"provider":"anthropic"}' }],
              usage: { input_tokens: 1, output_tokens: 1 },
            };
          },
        },
      },
    });
    const providerResult = await anthropic.answerGeneration.generate({
      system: 'system',
      messages: [{ role: 'user', content: 'question' }],
      model: anthropic.defaultModel,
      maxTokens: 100,
    });
    assert.equal(providerResult.text, '{"provider":"anthropic"}');
    assert.equal(providerCalls.length, 1);
  } finally {
    if (originalFreeModel === undefined) delete process.env.FAQ_FREE_MODEL;
    else process.env.FAQ_FREE_MODEL = originalFreeModel;
  }
});

test('0ヒット: fallbackMessage の200を返し、モデルを呼ばずログに skipped_model_call=true を残す', async () => {
  const ports = createStubFaqPorts({
    retrieval: 'empty',
    answerGeneration: 'envelope',
    settings: { enabled: true, fallbackMessage: 'スタブ固定フォールバック' },
  });
  __setFaqPortsForTest(ports);

  const { response, body, captured } = await invoke({
    messages: [{ role: 'user', content: '該当しない質問です' }],
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(body, {
    answer: 'スタブ固定フォールバック',
    answerable: false,
    sources: [],
    responseType: 'refuse',
  });
  assert.equal(Object.hasOwn(body, 'skipped_model_call'), false);
  assert.equal(ports.answerGeneration.calls.length, 0);
  assert.equal(ports.smalltalkGeneration.calls.length, 0);
  assert.equal(lastFaqMetric(captured).skipped_model_call, true);
  assert.equal(ports.storage.qaLogs.length, 1);
});

test('生成 null: API障害として503 SERVICE_UNAVAILABLEを返す', async () => {
  const ports = createStubFaqPorts({
    entries: [NORMAL_ENTRY],
    retrieval: 'normal',
    answerGeneration: 'null',
  });
  __setFaqPortsForTest(ports);

  const { response, body } = await invoke({
    messages: [{ role: 'user', content: '料金について知りたいです' }],
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(body, {
    error: SERVICE_UNAVAILABLE_MESSAGE,
    responseType: 'refuse',
  });
  assert.equal(ports.answerGeneration.calls.length, 1);
  assert.equal(ports.storage.qaLogs.length, 0);
});

test('max_tokens 切断: 現行分岐の200・generation_incompleteを固定する', async () => {
  const ports = createStubFaqPorts({
    entries: [NORMAL_ENTRY],
    retrieval: 'normal',
    answerGeneration: 'max_tokens',
  });
  __setFaqPortsForTest(ports);

  const { response, body } = await invoke({
    messages: [{ role: 'user', content: '料金について知りたいです' }],
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(body, {
    answer: TECHNICAL_FALLBACK_MESSAGE,
    answerable: false,
    sources: [],
    responseType: 'refuse',
    failureKind: 'generation_incomplete',
    retryable: true,
  });
  assert.equal(ports.storage.qaLogs.length, 1);
  assert.equal(ports.storage.qaLogs[0].route, 'refuse_truncated');
});

test('不正 envelope: 現行ガードの200・envelope_invalidを固定する', async () => {
  const ports = createStubFaqPorts({
    entries: [NORMAL_ENTRY],
    retrieval: 'normal',
    answerGeneration: 'invalid_json',
  });
  __setFaqPortsForTest(ports);

  const { response, body } = await invoke({
    messages: [{ role: 'user', content: '料金について知りたいです' }],
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(body, {
    answer: TECHNICAL_FALLBACK_MESSAGE,
    answerable: false,
    sources: [],
    responseType: 'refuse',
    failureKind: 'envelope_invalid',
    retryable: true,
  });
  assert.equal(ports.storage.qaLogs.length, 1);
  assert.equal(ports.storage.qaLogs[0].guardDetail, 'envelope_parse_failed');
});

test('無効化: enabled=false は503 dark shipでadapterを呼ばない', async () => {
  const ports = createStubFaqPorts({
    retrieval: 'throw',
    answerGeneration: 'max_tokens',
    smalltalkGeneration: 'max_tokens',
    settings: { enabled: false },
  });
  __setFaqPortsForTest(ports);

  const { response, body } = await invoke({
    messages: [{ role: 'user', content: '料金について知りたいです' }],
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(body, { error: 'FAQ chat is not available' });
  assert.equal(ports.retrieval.calls.length, 0);
  assert.equal(ports.answerGeneration.calls.length, 0);
  assert.equal(ports.smalltalkGeneration.calls.length, 0);
  assert.equal(ports.storage.qaLogs.length, 0);
});

test('Settings未設定: loadSettings null は503 dark shipでadapterを呼ばない', async () => {
  const ports = createStubFaqPorts({
    retrieval: 'throw',
    settings: null,
  });
  __setFaqPortsForTest(ports);

  const { response, body } = await invoke({
    messages: [{ role: 'user', content: '料金について知りたいです' }],
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(body, { error: 'FAQ chat is not available' });
  assert.equal(ports.retrieval.calls.length, 0);
  assert.equal(ports.storage.qaLogs.length, 0);
});

test('Q&A書込失敗: 応答を壊さずwarnだけを残す', async () => {
  const ports = createStubFaqPorts({
    retrieval: 'empty',
    settings: { enabled: true, fallbackMessage: '固定回答' },
  });
  ports.storage.putQaLog = async () => {
    throw new Error('synthetic write failure');
  };
  __setFaqPortsForTest(ports);

  const { response, body, captured } = await invoke({
    messages: [{ role: 'user', content: '該当しない質問です' }],
  });

  assert.equal(response.statusCode, 200);
  assert.equal(body.answer, '固定回答');
  assert.ok(
    captured.warn.some((args) => String(args[0]).includes('qa log write failed'))
  );
});

test('Q&A書込予算なし: Putを開始せず即応答する', async () => {
  const ports = createStubFaqPorts({
    retrieval: 'empty',
    settings: { enabled: true, fallbackMessage: '固定回答' },
  });
  __setFaqPortsForTest(ports);

  const { response, captured } = await invoke(
    { messages: [{ role: 'user', content: '該当しない質問です' }] },
    { getRemainingTimeInMillis: () => 800 }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(ports.storage.qaLogs.length, 0);
  assert.ok(
    captured.warn.some((args) => String(args[0]).includes('qa log write skipped'))
  );
});

test('Q&A書込timeout: 遅いPutを待ち切らず応答する', async () => {
  const ports = createStubFaqPorts({
    retrieval: 'empty',
    settings: { enabled: true, fallbackMessage: '固定回答' },
  });
  let writeStarted = false;
  ports.storage.putQaLog = () => {
    writeStarted = true;
    return new Promise(() => {});
  };
  __setFaqPortsForTest(ports);

  const { response, captured } = await invoke(
    { messages: [{ role: 'user', content: '該当しない質問です' }] },
    { getRemainingTimeInMillis: () => 820 }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(writeStarted, true);
  assert.ok(
    captured.warn.some((args) => String(args[0]).includes('qa log write timed out'))
  );
});

test('入力検証: messages 空は400を返す', async () => {
  const { response, body } = await invoke({ messages: [] });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(body, { error: 'messages must be a non-empty array' });
  assert.equal(defaultPorts.storage.qaLogs.length, 0);
});

test('入力検証: 65,536文字超bodyは現行どおり413を返す', async () => {
  const { response, body } = await invoke({ rawBody: 'x'.repeat(65_537) });

  assert.equal(response.statusCode, 413);
  assert.deepEqual(body, { error: 'Request body too large' });
  assert.equal(defaultPorts.storage.qaLogs.length, 0);
});

test('smalltalkMode 未設定の template_only では smalltalkGeneration を呼ばない', async () => {
  const ports = createStubFaqPorts({
    entries: [NORMAL_ENTRY],
    retrieval: 'normal',
    answerGeneration: 'envelope',
    smalltalkGeneration: 'max_tokens',
  });
  __setFaqPortsForTest(ports);

  const { response } = await invoke({
    messages: [{ role: 'user', content: '料金の詳細を確認したいです' }],
  });

  assert.equal(response.statusCode, 200);
  assert.equal(ports.answerGeneration.calls.length, 1);
  assert.equal(ports.smalltalkGeneration.calls.length, 0);
});

test('retrieval throw: handler はクラッシュせず現行の503を返す', async () => {
  const ports = createStubFaqPorts({ retrieval: 'throw' });
  __setFaqPortsForTest(ports);

  const { response, body } = await invoke({
    messages: [{ role: 'user', content: '料金について知りたいです' }],
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(body, {
    error: SERVICE_UNAVAILABLE_MESSAGE,
    responseType: 'refuse',
  });
  assert.equal(ports.retrieval.calls.length, 1);
  assert.equal(ports.answerGeneration.calls.length, 0);
  assert.equal(ports.storage.qaLogs.length, 0);
});

// ---- PR#122 レビュー対応: 構造化出力・stop_reason 全分岐・generated smalltalk の hints 伝播 ----

test('構造化出力: 対応モデル(Settings.model)では jsonSchema が生成ポートへ渡り、fallback 通知がメトリクスに載る', async () => {
  const ports = createStubFaqPorts({
    entries: [NORMAL_ENTRY],
    retrieval: 'normal',
    answerGeneration: 'envelope',
    simulateStructuredOutputFallback: true,
    settings: { enabled: true, model: 'claude-sonnet-5' },
  });
  __setFaqPortsForTest(ports);

  const { response, captured } = await invoke({
    messages: [{ role: 'user', content: '料金を教えてください' }],
  });

  assert.equal(response.statusCode, 200);
  const call = ports.answerGeneration.calls[0];
  assert.equal(call.model, 'claude-sonnet-5');
  assert.equal(typeof call.jsonSchema, 'object');
  assert.deepEqual(call.jsonSchema.required, ['responseType', 'answer', 'clarifyingQuestion', 'sourceRefs']);
  const metric = lastFaqMetric(captured);
  assert.equal(metric.structured_output_used, true);
  assert.equal(metric.structured_output_fallback, true);
});

test('構造化出力: 非対応モデルでは jsonSchema を渡さず structured_output_used=false', async () => {
  const ports = createStubFaqPorts({
    entries: [NORMAL_ENTRY],
    retrieval: 'normal',
    answerGeneration: 'envelope',
    settings: { enabled: true, model: 'some-unknown-model' },
  });
  __setFaqPortsForTest(ports);

  const { captured } = await invoke({ messages: [{ role: 'user', content: '料金を教えてください' }] });
  assert.equal(ports.answerGeneration.calls[0].jsonSchema, undefined);
  const metric = lastFaqMetric(captured);
  assert.equal(metric.structured_output_used, false);
});

test('refusal: 200 model_refusal・再試行を促さない（retryable=false・fallbackMessage）', async () => {
  const ports = createStubFaqPorts({
    entries: [NORMAL_ENTRY],
    retrieval: 'normal',
    answerGeneration: { stopReason: 'refusal' },
    settings: { enabled: true, fallbackMessage: 'スタブ固定フォールバック' },
  });
  __setFaqPortsForTest(ports);

  const { response, body } = await invoke({ messages: [{ role: 'user', content: '料金について' }] });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(body, {
    answer: 'スタブ固定フォールバック',
    answerable: false,
    sources: [],
    responseType: 'refuse',
    failureKind: 'model_refusal',
    retryable: false,
  });
  assert.equal(ports.storage.qaLogs[0].route, 'refuse_stop_other');
});

test('pause_turn: 200 generation_incomplete（再試行を促す）', async () => {
  const ports = createStubFaqPorts({
    entries: [NORMAL_ENTRY],
    retrieval: 'normal',
    answerGeneration: { stopReason: 'pause_turn' },
  });
  __setFaqPortsForTest(ports);
  const { body } = await invoke({ messages: [{ role: 'user', content: '料金について' }] });
  assert.equal(body.failureKind, 'generation_incomplete');
  assert.equal(body.retryable, true);
  assert.equal(ports.storage.qaLogs[0].route, 'refuse_stop_other');
});

test('未知の stop_reason (stop_sequence): 200 generation_other・fail closed', async () => {
  const ports = createStubFaqPorts({
    entries: [NORMAL_ENTRY],
    retrieval: 'normal',
    answerGeneration: { stopReason: 'stop_sequence' },
  });
  __setFaqPortsForTest(ports);
  const { body } = await invoke({ messages: [{ role: 'user', content: '料金について' }] });
  assert.equal(body.responseType, 'refuse');
  assert.equal(body.failureKind, 'generation_other');
  assert.equal(body.retryable, false);
});

test('end_turn で本文空: production は stop_reason 通知後に null を返すため 200 generation_other（現挙動を固定）', async () => {
  // llm-provider は onStopReason('end_turn') を呼んでから本文空で null を返す。handler は
  // stop_reason が非 null なので「API障害(503)」ではなく「停止理由あり(generation_other)」に分類する
  const ports = createStubFaqPorts({
    entries: [NORMAL_ENTRY],
    retrieval: 'normal',
    answerGeneration: { stopReason: 'end_turn', text: '' },
  });
  __setFaqPortsForTest(ports);
  const { response, body, captured } = await invoke({ messages: [{ role: 'user', content: '料金について' }] });
  assert.equal(response.statusCode, 200);
  assert.equal(body.responseType, 'refuse');
  assert.equal(body.failureKind, 'generation_other');
  const metric = lastFaqMetric(captured);
  assert.equal(metric.stop_reason, 'end_turn');
});

test('generated smalltalk: router の search_plan が hints として検索ポートへ渡り、KB経路で回答する', async () => {
  const routerDecision = JSON.stringify({
    route: 'faq_or_action',
    speech_acts: [],
    has_business_topic: true,
    has_information_request: true,
    has_action_request: false,
    has_prompt_injection: false,
    has_sensitive_topic: false,
    search_plan: { lexical_terms: ['料金', '基本料金'], semantic_queries: ['サービスの料金はいくらか'] },
  });
  const ports = createStubFaqPorts({
    entries: [NORMAL_ENTRY],
    retrieval: 'normal',
    answerGeneration: 'envelope',
    smalltalkGeneration: { stopReason: 'end_turn', text: routerDecision },
    settings: { enabled: true, smalltalkMode: 'generated' },
  });
  __setFaqPortsForTest(ports);

  const { response, body, captured } = await invoke({
    messages: [{ role: 'user', content: '料金を教えてください' }],
  });

  assert.equal(response.statusCode, 200);
  assert.equal(body.responseType, 'kb_answer');
  // ルーター（smalltalk ポート）は1回だけ呼ばれ、jsonSchema 付き・temperature=0 の契約
  assert.equal(ports.smalltalkGeneration.calls.length, 1);
  assert.equal(ports.smalltalkGeneration.calls[0].temperature, 0);
  assert.equal(typeof ports.smalltalkGeneration.calls[0].jsonSchema, 'object');
  // hints 伝播（ports 抽出 #121 の契約）
  assert.equal(ports.retrieval.calls.length, 1);
  assert.deepEqual(ports.retrieval.calls[0].hints, {
    lexicalTerms: ['料金', '基本料金'],
    semanticQueries: ['サービスの料金はいくらか'],
  });
  const metric = lastFaqMetric(captured);
  assert.equal(metric.router_plan_invalid ?? false, false);
});

// ---- PR#125 レビュー対応 ----

test('guardVocabulary: ポート注入語は決定的フォールバックの has_business_topic と雑談 post-guard の両方に効く', async () => {
  // router が不正 JSON を返す → 決定的リスク判定（inspectDeterministicInputRisk）で業務話題と判定され KB 経路へ
  const ports = createStubFaqPorts({
    entries: [NORMAL_ENTRY],
    retrieval: 'normal',
    answerGeneration: 'envelope',
    smalltalkGeneration: 'invalid_json',
    guardBusinessTerms: ['acmebot'],
    settings: { enabled: true, smalltalkMode: 'generated' },
  });
  __setFaqPortsForTest(ports);

  const { response, body, captured } = await invoke({
    messages: [{ role: 'user', content: 'AcmeBot って何？' }],
  });
  // 注入語で業務話題と判定 → 雑談固定文ではなく KB 経路へ（検索 0 ヒットなので refuse_no_hit の 200）
  assert.equal(response.statusCode, 200);
  assert.equal(body.responseType, 'refuse');
  assert.equal(lastFaqMetric(captured).risk_has_business_topic, true);
  assert.equal(ports.retrieval.calls.length, 1, 'KB 経路に到達する');

  // 注入語なしなら同じ入力は業務話題と判定されない（汎用語彙だけ）
  const plain = createStubFaqPorts({
    entries: [NORMAL_ENTRY],
    retrieval: 'normal',
    answerGeneration: 'envelope',
    smalltalkGeneration: 'invalid_json',
    settings: { enabled: true, smalltalkMode: 'generated' },
  });
  __setFaqPortsForTest(plain);
  const second = await invoke({ messages: [{ role: 'user', content: 'AcmeBot って何？' }] });
  assert.equal(lastFaqMetric(second.captured).risk_has_business_topic, false);
});

test('router_structured_output_fallback: ルーター段の jsonSchema 再試行がメトリクスに載る', async () => {
  const routerDecision = JSON.stringify({
    route: 'faq_or_action',
    speech_acts: [],
    has_business_topic: true,
    has_information_request: true,
    has_action_request: false,
    has_prompt_injection: false,
    has_sensitive_topic: false,
    search_plan: { lexical_terms: ['料金'], semantic_queries: [] },
  });
  const ports = createStubFaqPorts({
    entries: [NORMAL_ENTRY],
    retrieval: 'normal',
    answerGeneration: 'envelope',
    smalltalkGeneration: { stopReason: 'end_turn', text: routerDecision },
    simulateStructuredOutputFallback: true,
    settings: { enabled: true, smalltalkMode: 'generated' },
  });
  __setFaqPortsForTest(ports);

  const { response, captured } = await invoke({ messages: [{ role: 'user', content: '料金を教えてください' }] });
  assert.equal(response.statusCode, 200);
  const metric = lastFaqMetric(captured);
  assert.equal(metric.router_structured_output_used, true);
  assert.equal(metric.router_structured_output_fallback, true);
});

test('guardVocabulary: 非ラテン（カタカナ）の注入語は生成済み雑談文の post-guard で forbidden_term_businessDomain になる', async () => {
  const routerDecision = JSON.stringify({
    route: 'smalltalk_only',
    speech_acts: ['GREETING'],
    has_business_topic: false,
    has_information_request: false,
    has_action_request: false,
    has_prompt_injection: false,
    has_sensitive_topic: false,
    search_plan: null,
  });
  const generated = JSON.stringify({ decision: 'reply', text: 'こんにちは！アクメボットをよろしくお願いします。' });
  let call = 0;
  const ports = createStubFaqPorts({
    entries: [NORMAL_ENTRY],
    retrieval: 'normal',
    answerGeneration: 'envelope',
    smalltalkGeneration: { stopReason: 'end_turn', text: routerDecision },
    guardBusinessTerms: ['アクメボット'],
    settings: { enabled: true, smalltalkMode: 'generated' },
  });
  // 1 回目 = router、2 回目 = generator（注入語を含む文を返す）
  const inner = ports.smalltalkGeneration;
  ports.smalltalkGeneration = {
    calls: inner.calls,
    supportsStructuredOutput: inner.supportsStructuredOutput,
    async complete(request) {
      call += 1;
      if (call === 2) {
        request.onStopReason?.('end_turn');
        return { text: generated, inputTokens: 1, outputTokens: 1, stopReason: 'end_turn' };
      }
      return inner.complete(request);
    },
  };
  __setFaqPortsForTest(ports);

  const { response, captured } = await invoke({ messages: [{ role: 'user', content: 'やあ、今日もいい天気ですね' }] });
  assert.equal(response.statusCode, 200);
  const m = lastFaqMetric(captured);
  assert.equal(m.guard_reject_reason, 'forbidden_term_businessDomain', JSON.stringify({ route: m.route, smalltalk: m.smalltalk_route, shape: m.model_reply_shape, calls: call, reason: m.guard_reject_reason, src: m.smalltalk_response_source }));
});

test('free ports: allowlist モデルでも supportsStructuredOutput=false なら jsonSchema を渡さず structured_output_used=false', async () => {
  // free の既定モデル（haiku 4.5）は構造化出力 allowlist に含まれるが、汎用 adapter は jsonSchema を使わない。
  // capability を AND で見ないと free 側だけ偽陽性になり eval 比較が歪む（PR#124 レビュー指摘）
  const ports = createFreeHandlerPorts({
    kbSource: { loadPublicEntries: async () => SAMPLE_KB },
    apiKey: null,
  });
  const calls = [];
  const inner = ports.answerGeneration;
  ports.answerGeneration = {
    supportsStructuredOutput: inner.supportsStructuredOutput,
    async generate(request) {
      calls.push(request);
      return inner.generate(request);
    },
  };
  __setFaqPortsForTest(ports);

  const { response, captured } = await invoke({
    messages: [{ role: 'user', content: '営業時間は何時から何時までですか' }],
  });

  assert.equal(response.statusCode, 200);
  assert.equal(inner.supportsStructuredOutput, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].jsonSchema, undefined);
  assert.equal(lastFaqMetric(captured).structured_output_used, false);
});

test('free ports: smalltalk ポートの supportsStructuredOutput=false で router_structured_output_used=false', async () => {
  const ports = createFreeHandlerPorts(
    { kbSource: { loadPublicEntries: async () => SAMPLE_KB }, apiKey: null },
    { enabled: true, smalltalkMode: 'generated' }
  );
  __setFaqPortsForTest(ports);
  const { response, captured } = await invoke({ messages: [{ role: 'user', content: '営業時間は何時から何時までですか' }] });
  assert.equal(response.statusCode, 200);
  assert.equal(lastFaqMetric(captured).router_structured_output_used, false);
});

test('remote profile: retrieve -> generate の公開 kb_answer を既存形状で返す', async () => {
  const ports = createStubFaqPorts({ retrieval: 'empty', settings: { enabled: true } });
  const calls = { retrieve: [], generate: [] };
  const remoteRag = {
    async retrieve(request) {
      calls.retrieve.push(request);
      return {
        contractVersion: 'remote-v1',
        ok: true,
        sessionToken: '7f4c3e1a-9b62-4d85-a137-5c8e2f9046bd',
        expiresAtEpochMs: Date.now() + 30_000,
      };
    },
    async generate(request) {
      calls.generate.push(request);
      return {
        contractVersion: 'remote-v1',
        ok: true,
        response: {
          answer: '平日の営業時間は9時から17時です。',
          answerable: true,
          sources: [
            {
              entryId: 'faq-hours',
              topic: '営業時間',
              url: 'https://example.com/hours',
            },
          ],
          responseType: 'kb_answer',
        },
      };
    },
  };
  __setFaqPortsForTest(ports, remoteRag);

  const question = '営業時間を教えてください';
  const { response, body, captured } = await invoke({
    messages: [{ role: 'user', content: question }],
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(body, {
    answer: '平日の営業時間は9時から17時です。',
    answerable: true,
    sources: [
      {
        entryId: 'faq-hours',
        topic: '営業時間',
        url: 'https://example.com/hours',
      },
    ],
    responseType: 'kb_answer',
  });
  assert.equal(ports.retrieval.calls.length, 0, 'local retrieval must stay bypassed');
  assert.equal(ports.answerGeneration.calls.length, 0, 'local answer generation must stay bypassed');
  assert.equal(calls.retrieve.length, 1);
  assert.equal(calls.retrieve[0].question, question);
  assert.equal(calls.retrieve[0].remainingMs, 22_500);
  assert.equal(calls.generate.length, 1);
  assert.match(calls.generate[0].idempotencyKey, /^[0-9a-f-]{36}$/u);
  assert.equal(calls.generate[0].currentQuestion, question);
  assert.deepEqual(calls.generate[0].messages, [{ role: 'user', content: question }]);
  assert.equal(calls.generate[0].remainingMs, 27_500);
  assert.equal(ports.storage.qaLogs.length, 1);
  assert.deepEqual(ports.storage.qaLogs[0].sources, ['営業時間']);
  const metric = lastFaqMetric(captured);
  assert.equal(metric.model, null);
  assert.equal(metric.remote_error_code, null);
});

test('remote profile: generated smalltalk の検索 hints を retrieve DTO へ引き継ぐ', async () => {
  const routerDecision = JSON.stringify({
    route: 'faq_or_action',
    speech_acts: [],
    has_business_topic: true,
    has_information_request: true,
    has_action_request: false,
    has_prompt_injection: false,
    has_sensitive_topic: false,
    search_plan: {
      lexical_terms: ['料金', '基本料金'],
      semantic_queries: ['サービスの料金はいくらか'],
    },
  });
  const ports = createStubFaqPorts({
    retrieval: 'empty',
    smalltalkGeneration: { stopReason: 'end_turn', text: routerDecision },
    settings: { enabled: true, smalltalkMode: 'generated' },
  });
  let retrieveRequest;
  __setFaqPortsForTest(ports, {
    async retrieve(request) {
      retrieveRequest = request;
      return {
        contractVersion: 'remote-v1',
        ok: false,
        error: { code: 'no_match', retryable: false },
      };
    },
    async generate() {
      throw new Error('generate must not run after no_match');
    },
  });

  const { response } = await invoke({
    messages: [{ role: 'user', content: '料金を教えてください' }],
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(retrieveRequest.hints, {
    lexicalTerms: ['料金', '基本料金'],
    semanticQueries: ['サービスの料金はいくらか'],
  });
  assert.equal(ports.retrieval.calls.length, 0);
});

test('remote profile: 上限超過の検索 plan を code point 単位で有界化して retrieve へ渡す', async () => {
  const lexicalTerms = [
    'ＡＢＣ',
    'abc',
    ...Array.from({ length: 8 }, (_, index) => `検索語${index + 1}`),
  ];
  const overlongSemanticQuery = '😀'.repeat(65);
  const routerDecision = JSON.stringify({
    route: 'faq_or_action',
    speech_acts: [],
    has_business_topic: true,
    has_information_request: true,
    has_action_request: false,
    has_prompt_injection: false,
    has_sensitive_topic: false,
    search_plan: {
      lexical_terms: lexicalTerms,
      semantic_queries: [overlongSemanticQuery, '第2の意味検索', '第3の意味検索'],
    },
  });
  const ports = createStubFaqPorts({
    retrieval: 'empty',
    smalltalkGeneration: { stopReason: 'end_turn', text: routerDecision },
    settings: { enabled: true, smalltalkMode: 'generated' },
  });
  let retrieveRequest;
  __setFaqPortsForTest(ports, {
    async retrieve(request) {
      retrieveRequest = parseRemoteV1RetrieveRequest(request);
      return {
        contractVersion: 'remote-v1',
        ok: false,
        error: { code: 'no_match', retryable: false },
      };
    },
    async generate() {
      throw new Error('generate must not run after no_match');
    },
  });

  const { response, body, captured } = await invoke({
    messages: [{ role: 'user', content: '料金プランを検索してください' }],
  });

  assert.equal(response.statusCode, 200);
  assert.equal(body.responseType, 'refuse');
  assert.equal('failureKind' in body, false);
  assert.deepEqual(retrieveRequest.hints, {
    lexicalTerms: ['ＡＢＣ', ...lexicalTerms.slice(2, 9)],
    semanticQueries: ['😀'.repeat(64), '第2の意味検索'],
  });
  assert.equal(Array.from(retrieveRequest.hints.semanticQueries[0]).length, 64);
  assert.equal(lastFaqMetric(captured).remote_error_code, 'no_match');
  // 有界化の観測: 字句は dedup 後9件中8件採用(1 drop)・意味は3件中2件採用(1 drop)。
  // truncate で残った要素は drop に数えない
  assert.equal(lastFaqMetric(captured).remote_plan_dropped, 2);
  assert.equal(lastFaqMetric(captured).remote_plan_raw_count, 12);
  assert.doesNotMatch(captured.error.flat().map(String).join('\n'), /invalid_contract/u);
});

test('remote profile: 有界化後に空の検索 plan は retrieve DTO の hints を省略する', async () => {
  const routerDecision = JSON.stringify({
    route: 'faq_or_action',
    speech_acts: [],
    has_business_topic: true,
    has_information_request: true,
    has_action_request: false,
    has_prompt_injection: false,
    has_sensitive_topic: false,
    search_plan: {
      lexical_terms: ['長'.repeat(17), '😀'.repeat(17)],
      semantic_queries: [],
    },
  });
  const ports = createStubFaqPorts({
    retrieval: 'empty',
    smalltalkGeneration: { stopReason: 'end_turn', text: routerDecision },
    settings: { enabled: true, smalltalkMode: 'generated' },
  });
  let retrieveRequest;
  __setFaqPortsForTest(ports, {
    async retrieve(request) {
      retrieveRequest = parseRemoteV1RetrieveRequest(request);
      return {
        contractVersion: 'remote-v1',
        ok: false,
        error: { code: 'no_match', retryable: false },
      };
    },
    async generate() {
      throw new Error('generate must not run after no_match');
    },
  });

  const { response, captured } = await invoke({
    messages: [{ role: 'user', content: '料金プランを検索してください' }],
  });

  assert.equal(response.statusCode, 200);
  assert.equal('hints' in retrieveRequest, false);
  // hints 省略でも「plan なし(raw=0)」と「有界化で全滅(raw>0)」をメトリクスで区別できる
  assert.equal(lastFaqMetric(captured).remote_plan_dropped, 2);
  assert.equal(lastFaqMetric(captured).remote_plan_raw_count, 2);
});

test('remote profile: generate 最低枠を引いた retrieve 予算が0なら deadline 経路へ倒す', async () => {
  const ports = createStubFaqPorts({ retrieval: 'empty', settings: { enabled: true } });
  let retrieveCalls = 0;
  let generateCalls = 0;
  __setFaqPortsForTest(ports, {
    async retrieve() {
      retrieveCalls += 1;
      throw new Error('retrieve must not run without a positive budget');
    },
    async generate() {
      generateCalls += 1;
      throw new Error('generate must not run after retrieve deadline');
    },
  });

  const { response, body, captured } = await invoke(
    { messages: [{ role: 'user', content: '料金を教えてください' }] },
    { getRemainingTimeInMillis: () => 7_500 }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(body.responseType, 'refuse');
  assert.equal(body.failureKind, 'envelope_invalid');
  assert.equal(body.retryable, true);
  assert.equal(retrieveCalls, 0);
  assert.equal(generateCalls, 0);
  const metric = lastFaqMetric(captured);
  assert.equal(metric.route, 'refuse_time_budget');
  assert.equal(metric.remote_error_code, 'deadline_exceeded');
});

test('remote profile: no_match は既存の KB 該当なし refuse へ写像する', async () => {
  const ports = createStubFaqPorts({ retrieval: 'empty', settings: { enabled: true } });
  let generateCalls = 0;
  __setFaqPortsForTest(ports, {
    async retrieve() {
      return {
        contractVersion: 'remote-v1',
        ok: false,
        error: { code: 'no_match', retryable: false },
      };
    },
    async generate() {
      generateCalls += 1;
      throw new Error('generate must not run after no_match');
    },
  });

  const { response, body, captured } = await invoke({
    messages: [{ role: 'user', content: '対象外の質問です' }],
  });

  assert.equal(response.statusCode, 200);
  assert.equal(body.responseType, 'refuse');
  assert.equal(body.answerable, false);
  assert.deepEqual(body.sources, []);
  assert.equal('failureKind' in body, false);
  assert.equal('retryable' in body, false);
  assert.equal(generateCalls, 0);
  assert.equal(lastFaqMetric(captured).route, 'refuse_no_hit');
  assert.equal(lastFaqMetric(captured).remote_error_code, 'no_match');
});

test('remote profile: kill_switch は再試行可能な既存技術系 refuse へ写像する', async () => {
  const ports = createStubFaqPorts({ retrieval: 'empty', settings: { enabled: true } });
  __setFaqPortsForTest(ports, {
    async retrieve() {
      return {
        contractVersion: 'remote-v1',
        ok: false,
        error: { code: 'kill_switch', retryable: true },
      };
    },
    async generate() {
      throw new Error('generate must not run while the remote kill switch is active');
    },
  });

  const { response, body, captured } = await invoke({
    messages: [{ role: 'user', content: '料金を教えてください' }],
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(body, {
    answer: TECHNICAL_FALLBACK_MESSAGE,
    answerable: false,
    sources: [],
    responseType: 'refuse',
    failureKind: 'envelope_invalid',
    retryable: true,
  });
  assert.equal(lastFaqMetric(captured).remote_error_code, 'kill_switch');
});

test('remote profile: invalid_contract は技術系 refuse と値を含まない切り分けログへ写像する', async () => {
  const ports = createStubFaqPorts({ retrieval: 'empty', settings: { enabled: true } });
  const secretQuestion = 'LEAK_CANARY_126 の料金を教えてください';
  __setFaqPortsForTest(ports, {
    async retrieve() {
      return {
        contractVersion: 'remote-v1',
        ok: true,
        sessionToken: '7f4c3e1a-9b62-4d85-a137-5c8e2f9046bd',
        expiresAtEpochMs: Date.now() + 30_000,
      };
    },
    async generate() {
      return {
        contractVersion: 'remote-v1',
        ok: false,
        error: { code: 'invalid_contract', retryable: false },
      };
    },
  });

  const { response, body, captured } = await invoke({
    messages: [{ role: 'user', content: secretQuestion }],
  });

  assert.equal(response.statusCode, 200);
  assert.equal(body.responseType, 'refuse');
  assert.equal(body.failureKind, 'envelope_invalid');
  assert.equal(body.retryable, true);
  const errors = captured.error.flat().map(String).join('\n');
  assert.match(errors, /operation=generate code=invalid_contract/u);
  assert.doesNotMatch(errors, /LEAK_CANARY_126/u);
  assert.equal(lastFaqMetric(captured).remote_error_code, 'invalid_contract');
});
