#!/usr/bin/env node
/** Public-only contract tests for the lite Slack policy, config, and KB adapters. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAMBDA_ROOT = path.resolve(HERE, '..');
const CANONICAL_REPOSITORY_ROOT = path.resolve(HERE, '../../../../..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-lite-adapters-test-'));

after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

function resolvePublicLambdaSource(...segments) {
  const syncedPath = path.join(LAMBDA_ROOT, ...segments);
  if (fs.existsSync(syncedPath)) return syncedPath;
  return path.join(CANONICAL_REPOSITORY_ROOT, 'lambda', ...segments);
}

async function bundle(entryPoint, outputName, { stubDynamo = false } = {}) {
  const outfile = path.join(tempRoot, outputName);
  await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outfile,
    logLevel: 'silent',
    plugins: [
      {
        name: 'slack-lite-adapter-test-dependencies',
        setup(esbuild) {
          esbuild.onResolve(
            { filter: /shared[\\/]public[\\/]slack-agent-ports\.js$/ },
            () => ({
              path: resolvePublicLambdaSource(
                'shared',
                'public',
                'slack-agent-ports.ts'
              ),
            })
          );
          // This file is allowlisted canonical source and exists beside the overlay only
          // after public-sync. Resolve it from the canonical tree in overlay-only tests.
          esbuild.onResolve({ filter: /simple-retrieval\.js$/ }, () => ({
            path: resolvePublicLambdaSource(
              'functions',
              'faq-chat',
              'adapters',
              'free',
              'simple-retrieval.ts'
            ),
          }));

          if (!stubDynamo) return;
          esbuild.onResolve(
            { filter: /infra[\\/]lite-dynamodb\.js$/ },
            () => ({ path: 'lite-dynamodb', namespace: 'slack-lite-test' })
          );
          esbuild.onLoad(
            { filter: /^lite-dynamodb$/, namespace: 'slack-lite-test' },
            () => ({
              contents: `
                export const LiteTableNames = {
                  AgentConfig: 'candidate-AgentConfig',
                  KnowledgeEntries: 'candidate-KnowledgeEntries'
                };
                export async function getItem(table, key) {
                  const state = globalThis.__slackLiteAdapterState;
                  state.getCalls.push({ table, key });
                  return state.profiles[key.agentId] ?? null;
                }
                export async function scanAll(table, options) {
                  const state = globalThis.__slackLiteAdapterState;
                  state.scanCalls.push({ table, options });
                  return state.knowledgeRows;
                }
              `,
              loader: 'js',
            })
          );
        },
      },
    ],
  });
  return import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);
}

function boundary(agentId = 'support') {
  return {
    agentId,
    trustClass: 'slack',
    kbTableName: 'candidate-KnowledgeEntries',
    qaLogTableName: 'candidate-SlackQaLogs',
  };
}

function resolvedConfig(overrides = {}) {
  return {
    agentId: 'support',
    trustClass: 'slack',
    access: 'internal',
    model: 'claude-haiku-4-5-20251001',
    maxOutputTokens: 600,
    systemPrompt: 'system',
    logPolicy: 'metadata_only',
    embeddingPolicy: 'disabled',
    kbTable: 'candidate-KnowledgeEntries',
    qaLogTable: 'candidate-SlackQaLogs',
    enabled: true,
    ...overrides,
  };
}

test('lite Slack policy fixes the single trust class and rejects boundary drift', async () => {
  const module = await bundle(
    path.join(LAMBDA_ROOT, 'shared-lite', 'slack-agent-policy.ts'),
    'slack-agent-policy.mjs'
  );
  const policy = module.liteSlackAgentPolicy;
  const runtime = boundary();

  assert.equal(policy.isTrustClass('slack'), true);
  assert.equal(policy.isTrustClass('other-trust'), false);
  assert.equal(policy.isTrustClass('SLACK'), false);
  assert.equal(policy.inspectJob({ channelType: 'channel' }), 'process');
  assert.equal(policy.selectKbInjectionStrategy('slack'), 'query');
  assert.equal(policy.canSendQaLogNotification(resolvedConfig()), false);

  let notificationSendCalled = false;
  assert.equal(
    await policy.sendQaLogNotification({
      session: null,
      notification: { enabled: true, channelId: 'C-NOTIFY' },
      slackMessageTs: '1.0',
      send: async () => {
        notificationSendCalled = true;
      },
    }),
    false
  );
  assert.equal(notificationSendCalled, false);

  assert.doesNotThrow(() => policy.assertAgentConfigBoundary(resolvedConfig(), runtime));
  assert.throws(
    () => policy.assertAgentConfigBoundary(null, runtime),
    /missing or invalid/
  );
  assert.throws(
    () => policy.assertAgentConfigBoundary(resolvedConfig({ agentId: 'other' }), runtime),
    /agentId mismatch/
  );
  // disabledはworker-coreのname契約（SlackAgentDisabledError）で終端ACKになる。
  // 文字列契約が唯一の接着面のため、nameそのものを固定する（レビュー指摘）。
  assert.throws(
    () => policy.assertAgentConfigBoundary(resolvedConfig({ enabled: false }), runtime),
    (error) => error instanceof Error && error.name === 'SlackAgentDisabledError'
  );
  assert.throws(
    () =>
      policy.assertAgentConfigBoundary(
        resolvedConfig({ trustClass: 'other-trust' }),
        runtime
      ),
    /trust class mismatch/
  );
  assert.throws(
    () => policy.assertAgentConfigBoundary(resolvedConfig({ access: 'public' }), runtime),
    /access mismatch/
  );
  assert.throws(
    () => policy.assertAgentConfigBoundary(resolvedConfig({ kbTable: 'other' }), runtime),
    /KB table mismatch/
  );
  assert.throws(
    () => policy.assertAgentConfigBoundary(resolvedConfig({ qaLogTable: 'other' }), runtime),
    /Q&A log table mismatch/
  );
  assert.throws(
    () =>
      policy.assertAgentConfigBoundary(
        resolvedConfig({ embeddingPolicy: 'enabled' }),
        runtime
      ),
    /embeddingPolicy must be disabled/
  );
  assert.throws(
    () =>
      policy.assertAgentConfigBoundary(
        resolvedConfig({ qaLogNotification: { enabled: true } }),
        runtime
      ),
    /qaLogNotification must not be enabled/
  );
  assert.doesNotThrow(() =>
    policy.assertAgentConfigBoundary(
      resolvedConfig({ qaLogNotification: { enabled: false } }),
      runtime
    )
  );
});

test('lite Slack config normalizes the shared AgentConfig row and fails closed', async () => {
  const state = {
    getCalls: [],
    scanCalls: [],
    knowledgeRows: [],
    profiles: {
      full: {
        agentId: 'full',
        enabled: true,
        systemPrompt: '  custom system  ',
        model: 'claude-sonnet-5',
        maxOutputTokens: 900,
        fallbackMessage: 'HTTP only',
        kbAgentId: 'shared-kb',
        logPolicy: 'redacted_full',
      },
      defaults: { agentId: 'defaults', enabled: true },
      disabled: { agentId: 'disabled', enabled: false },
      unknown: { agentId: 'unknown', enabled: true, internalOnly: true },
      'invalid-log': { agentId: 'invalid-log', enabled: true, logPolicy: 'full' },
      mismatch: { agentId: 'different', enabled: true },
      'env-model': { agentId: 'env-model', enabled: true },
      'invalid-env-model': { agentId: 'invalid-env-model', enabled: true },
    },
  };
  globalThis.__slackLiteAdapterState = state;

  const module = await bundle(
    path.join(LAMBDA_ROOT, 'shared-lite', 'slack-agent-config.ts'),
    'slack-agent-config.mjs',
    { stubDynamo: true }
  );

  const mutableBoundary = boundary('full');
  const fullPort = module.createLiteSlackAgentConfigPort(mutableBoundary);
  mutableBoundary.kbTableName = 'mutated-KnowledgeEntries';
  mutableBoundary.qaLogTableName = 'mutated-SlackQaLogs';
  const full = await fullPort.resolve('full');
  assert.deepEqual(full, {
    agentId: 'full',
    trustClass: 'slack',
    access: 'internal',
    model: 'claude-sonnet-5',
    maxOutputTokens: 900,
    systemPrompt: 'custom system',
    logPolicy: 'redacted_full',
    embeddingPolicy: 'disabled',
    kbTable: 'candidate-KnowledgeEntries',
    qaLogTable: 'candidate-SlackQaLogs',
    enabled: true,
    kbAgentId: 'shared-kb',
  });
  assert.equal(Object.isFrozen(full), true);
  assert.equal(Object.hasOwn(full, 'fallbackMessage'), false, 'HTTP-only field is not used');

  const previousFreeModel = process.env.FAQ_FREE_MODEL;
  try {
    delete process.env.FAQ_FREE_MODEL;
    const defaults = await module
      .createLiteSlackAgentConfigPort(boundary('defaults'))
      .resolve('defaults');
    assert.deepEqual(defaults, {
      agentId: 'defaults',
      trustClass: 'slack',
      access: 'internal',
      model: 'claude-haiku-4-5-20251001',
      maxOutputTokens: 600,
      systemPrompt:
        'あなたは公式サイトのFAQアシスタントです。丁寧な日本語で簡潔に回答してください。',
      logPolicy: 'metadata_only',
      embeddingPolicy: 'disabled',
      kbTable: 'candidate-KnowledgeEntries',
      qaLogTable: 'candidate-SlackQaLogs',
      enabled: true,
    });

    process.env.FAQ_FREE_MODEL = 'claude-opus-5';
    assert.equal(
      (
        await module
          .createLiteSlackAgentConfigPort(boundary('env-model'))
          .resolve('env-model')
      ).model,
      'claude-opus-5'
    );

    process.env.FAQ_FREE_MODEL = 'unapproved-model';
    assert.equal(
      await module
        .createLiteSlackAgentConfigPort(boundary('invalid-env-model'))
        .resolve('invalid-env-model'),
      null
    );
  } finally {
    if (previousFreeModel === undefined) delete process.env.FAQ_FREE_MODEL;
    else process.env.FAQ_FREE_MODEL = previousFreeModel;
  }

  const disabled = await module
    .createLiteSlackAgentConfigPort(boundary('disabled'))
    .resolve('disabled');
  assert.equal(disabled.enabled, false, 'policy owns the enabled boundary rejection');
  assert.equal(
    await module.createLiteSlackAgentConfigPort(boundary('unknown')).resolve('unknown'),
    null
  );
  assert.equal(
    await module
      .createLiteSlackAgentConfigPort(boundary('invalid-log'))
      .resolve('invalid-log'),
    null
  );
  assert.equal(
    await module.createLiteSlackAgentConfigPort(boundary('mismatch')).resolve('mismatch'),
    null
  );

  const beforeCrossBoundaryRead = state.getCalls.length;
  assert.equal(
    await module.createLiteSlackAgentConfigPort(boundary('full')).resolve('defaults'),
    null
  );
  assert.equal(
    state.getCalls.length,
    beforeCrossBoundaryRead,
    'a stack-bound config port must not read another agent row'
  );
});

test('lite Slack KB shares HTTP kbAgentId scope, returns topK block once, and rejects drift', async () => {
  const sharedRows = ['alpha', 'beta', 'delta', 'epsilon', 'gamma', 'zeta'].map(
    (suffix) => ({
      entryId: `shared-${suffix}`,
      topic: `billing ${suffix}`,
      answer: `billing answer ${suffix}`,
      status: 'active',
      visibility: 'public',
      agentId: 'shared-kb',
    })
  );
  const state = {
    getCalls: [],
    scanCalls: [],
    profiles: {
      'slack-main': {
        agentId: 'slack-main',
        enabled: true,
        kbAgentId: 'shared-kb',
      },
      'slack-own': { agentId: 'slack-own', enabled: true },
      'slack-disabled': { agentId: 'slack-disabled', enabled: false },
      'slack-invalid': {
        agentId: 'slack-invalid',
        enabled: true,
        unknownField: true,
      },
    },
    knowledgeRows: [
      ...sharedRows,
      {
        entryId: 'own-entry',
        topic: 'returns policy',
        answer: 'returns policy own answer',
        status: 'active',
        visibility: 'public',
        agentId: 'slack-own',
      },
      {
        entryId: 'wrong-agent',
        topic: 'billing wrong',
        answer: 'must not leak',
        status: 'active',
        visibility: 'public',
        agentId: 'slack-main',
      },
      {
        entryId: 'private-entry',
        topic: 'billing private',
        answer: 'must not leak',
        status: 'active',
        visibility: 'internal',
        agentId: 'shared-kb',
      },
    ],
  };
  globalThis.__slackLiteAdapterState = state;

  const module = await bundle(
    path.join(LAMBDA_ROOT, 'shared-lite', 'slack-kb.ts'),
    'slack-kb.mjs',
    { stubDynamo: true }
  );
  const port = module.liteSlackKbPort;
  const input = {
    agentId: 'slack-main',
    trustClass: 'slack',
    embeddingPolicy: 'disabled',
    question: 'billing',
    strategy: 'query',
  };

  const shared = await port.load(input);
  assert.deepEqual(shared.sourceIds, [
    'shared-alpha',
    'shared-beta',
    'shared-delta',
    'shared-epsilon',
    'shared-gamma',
  ]);
  assert.equal(shared.block.match(/<knowledge_base>/g)?.length, 1);
  assert.equal(shared.block.match(/<\/knowledge_base>/g)?.length, 1);
  assert.match(shared.block, /shared-alpha|billing answer alpha/);
  assert.doesNotMatch(shared.block, /zeta|wrong-agent|private-entry/);
  assert.equal(
    state.scanCalls[0].options.expressionAttributeValues[':kbAgentId'],
    'shared-kb'
  );

  const own = await port.load({
    ...input,
    agentId: 'slack-own',
    question: 'returns policy',
  });
  assert.deepEqual(own.sourceIds, ['own-entry']);
  assert.match(own.block, /returns policy own answer/);
  assert.equal(
    state.scanCalls[1].options.expressionAttributeValues[':kbAgentId'],
    'slack-own'
  );

  const callsBeforeStrategyRejection = state.getCalls.length;
  await assert.rejects(
    () => port.load({ ...input, strategy: 'full' }),
    /supports only the query injection strategy/
  );
  assert.equal(state.getCalls.length, callsBeforeStrategyRejection);
  await assert.rejects(
    () => port.load({ ...input, embeddingPolicy: 'enabled' }),
    /embeddingPolicy must be disabled/
  );
  await assert.rejects(
    () => port.load({ ...input, agentId: 'slack-disabled' }),
    /missing, disabled, or invalid/
  );
  await assert.rejects(
    () => port.load({ ...input, agentId: 'slack-invalid' }),
    /missing, disabled, or invalid/
  );
});
