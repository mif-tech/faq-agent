#!/usr/bin/env node
/** Public multi-agent contracts for the lite AgentConfig, KB source, and CLI. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAMBDA_ROOT = path.resolve(HERE, '..');
const OVERLAY_ROOT = path.resolve(LAMBDA_ROOT, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'faq-lite-multi-agent-test-'));

after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

async function bundle(entryPoint, outfile, setup = () => {}) {
  await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outfile,
    logLevel: 'silent',
    plugins: [{ name: 'faq-lite-multi-agent-stub', setup }],
  });
  return import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);
}

test('AgentConfig adapter normalizes valid rows, caches by agentId, and fails closed', async () => {
  const valid = {
    agentId: 'sales',
    enabled: true,
    systemPrompt: '  public sales assistant  ',
    model: ' claude-sonnet-5 ',
    maxOutputTokens: 600,
    fallbackMessage: '  no answer  ',
    kbAgentId: 'sales-kb',
    logPolicy: 'redacted_full',
  };
  const state = {
    calls: [],
    rows: new Map([
      ['sales', valid],
      ['disabled', { agentId: 'disabled', enabled: false }],
      ['wrong-pk', { agentId: 'other', enabled: true }],
      ['unknown-field', { agentId: 'unknown-field', enabled: true, access: 'internal' }],
      ['bad-enabled', { agentId: 'bad-enabled', enabled: 'true' }],
      ['bad-model', { agentId: 'bad-model', enabled: true, model: 'claude-unknown' }],
      ['bad-tokens', { agentId: 'bad-tokens', enabled: true, maxOutputTokens: 1501 }],
      ['bad-kb', { agentId: 'bad-kb', enabled: true, kbAgentId: '../internal' }],
      ['bad-log-policy', { agentId: 'bad-log-policy', enabled: true, logPolicy: 'full' }],
    ]),
  };
  globalThis.__faqLiteAgentConfigState = state;

  const module = await bundle(
    path.join(
      LAMBDA_ROOT,
      'functions',
      'faq-chat',
      'adapters',
      'free',
      'agent-config.ts'
    ),
    path.join(tempRoot, 'agent-config.mjs'),
    (esbuild) => {
      esbuild.onResolve({ filter: /infra[\\/]lite-dynamodb\.js$/ }, () => ({
        path: 'lite-dynamodb',
        namespace: 'lite-test',
      }));
      esbuild.onLoad({ filter: /^lite-dynamodb$/, namespace: 'lite-test' }, () => ({
        contents: `
          export const LiteTableNames = { AgentConfig: 'candidate-AgentConfig' };
          export async function getItem(table, key) {
            globalThis.__faqLiteAgentConfigState.calls.push({ table, key });
            return globalThis.__faqLiteAgentConfigState.rows.get(key.agentId) ?? null;
          }
        `,
        loader: 'js',
      }));
    }
  );

  assert.deepEqual(await module.resolveAgentProfile('sales'), {
    agentId: 'sales',
    enabled: true,
    systemPrompt: 'public sales assistant',
    model: 'claude-sonnet-5',
    maxOutputTokens: 600,
    fallbackMessage: 'no answer',
    kbAgentId: 'sales-kb',
    logPolicy: 'redacted_full',
  });
  assert.equal(Object.isFrozen(await module.resolveAgentProfile('sales')), true);
  assert.deepEqual(state.calls, [
    { table: 'candidate-AgentConfig', key: { agentId: 'sales' } },
  ], 'the second request must use the agent-scoped cache');

  assert.deepEqual(await module.resolveAgentProfile('disabled'), {
    agentId: 'disabled',
    enabled: false,
  });
  for (const agentId of [
    'wrong-pk',
    'unknown-field',
    'bad-enabled',
    'bad-model',
    'bad-tokens',
    'bad-kb',
    'bad-log-policy',
    'missing',
  ]) {
    assert.equal(await module.resolveAgentProfile(agentId), null, agentId);
  }

  const callsBeforeInvalidId = state.calls.length;
  assert.equal(await module.resolveAgentProfile('../internal'), null);
  assert.equal(state.calls.length, callsBeforeInvalidId, 'invalid IDs must not reach DynamoDB');

  assert.equal(
    module.normalizeFaqAgentProfile({ agentId: 'x', enabled: true, fallbackMessage: 'x'.repeat(4001) }),
    null
  );
  assert.equal(
    module.normalizeFaqAgentProfile({ agentId: 'x', enabled: true, systemPrompt: 'x'.repeat(32001) }),
    null
  );
  assert.deepEqual(
    module.normalizeFaqAgentProfile({
      agentId: 'x',
      enabled: true,
      model: 'claude-haiku-4-5-20251001',
      maxOutputTokens: 100,
      logPolicy: 'metadata_only',
    }),
    {
      agentId: 'x',
      enabled: true,
      model: 'claude-haiku-4-5-20251001',
      maxOutputTokens: 100,
      logPolicy: 'metadata_only',
    }
  );
  for (const logPolicy of ['off', 'metadata_only', 'redacted_full']) {
    assert.equal(
      module.normalizeFaqAgentProfile({ agentId: 'x', enabled: true, logPolicy })
        .logPolicy,
      logPolicy
    );
  }
});

test('named KB scope requires exact agentId in both DynamoDB and JavaScript filters', async () => {
  const state = {
    calls: [],
    rows: [
      { entryId: 'legacy', topic: 'Legacy', answer: 'Legacy', status: 'active', visibility: 'public' },
      { entryId: 'default', topic: 'Default', answer: 'Default', status: 'active', visibility: 'public', agentId: 'default' },
      { entryId: 'sales', topic: 'Sales', answer: 'Sales', status: 'active', visibility: 'public', agentId: 'sales' },
      { entryId: 'other', topic: 'Other', answer: 'Other', status: 'active', visibility: 'public', agentId: 'other' },
      { entryId: 'private', topic: 'Private', answer: 'Private', status: 'active', visibility: 'internal', agentId: 'sales' },
      { entryId: 'inactive', topic: 'Inactive', answer: 'Inactive', status: 'inactive', visibility: 'public', agentId: 'sales' },
    ],
  };
  globalThis.__faqLiteNamedKbState = state;

  const module = await bundle(
    path.join(
      LAMBDA_ROOT,
      'functions',
      'faq-chat',
      'adapters',
      'free',
      'dynamodb-entries.ts'
    ),
    path.join(tempRoot, 'named-kb.mjs'),
    (esbuild) => {
      esbuild.onResolve({ filter: /infra[\\/]lite-dynamodb\.js$/ }, () => ({
        path: 'lite-dynamodb',
        namespace: 'lite-test',
      }));
      esbuild.onLoad({ filter: /^lite-dynamodb$/, namespace: 'lite-test' }, () => ({
        contents: `
          export const LiteTableNames = { KnowledgeEntries: 'candidate-KnowledgeEntries' };
          export async function scanAll(table, options) {
            globalThis.__faqLiteNamedKbState.calls.push({ table, options });
            return globalThis.__faqLiteNamedKbState.rows;
          }
        `,
        loader: 'js',
      }));
    }
  );

  assert.deepEqual(await module.loadPublicKnowledgeEntries(), [
    { id: 'legacy', topic: 'Legacy', content: 'Legacy' },
    { id: 'default', topic: 'Default', content: 'Default' },
  ]);
  assert.deepEqual(await module.loadPublicKnowledgeEntries('sales'), [
    { id: 'sales', topic: 'Sales', content: 'Sales' },
  ]);

  const namedCall = state.calls[1];
  assert.equal(namedCall.options.filterExpression,
    '#status = :active AND #visibility = :public AND #agentId = :kbAgentId');
  assert.deepEqual(namedCall.options.expressionAttributeValues, {
    ':active': 'active',
    ':public': 'public',
    ':kbAgentId': 'sales',
  });
  assert.equal(
    Object.hasOwn(namedCall.options.expressionAttributeValues, ':defaultAgentId'),
    false,
    'named scope must not include the legacy/default selector'
  );
});

test('CLI validate rejects invalid profiles and upsert never writes them', async () => {
  const state = { commands: [] };
  const module = await bundle(
    path.join(OVERLAY_ROOT, 'scripts', 'agent-config-cli.ts'),
    path.join(tempRoot, 'agent-config-cli.mjs'),
    (esbuild) => {
      esbuild.onResolve({ filter: /^@aws-sdk\/client-dynamodb$/ }, () => ({
        path: 'client-dynamodb',
        namespace: 'lite-test',
      }));
      esbuild.onResolve({ filter: /^@aws-sdk\/lib-dynamodb$/ }, () => ({
        path: 'lib-dynamodb',
        namespace: 'lite-test',
      }));
      esbuild.onLoad({ filter: /^client-dynamodb$/, namespace: 'lite-test' }, () => ({
        contents: 'export class DynamoDBClient { destroy() {} }',
        loader: 'js',
      }));
      esbuild.onLoad({ filter: /^lib-dynamodb$/, namespace: 'lite-test' }, () => ({
        contents: `
          class Command { constructor(input) { this.input = input; } }
          export class GetCommand extends Command {}
          export class PutCommand extends Command {}
          export class ScanCommand extends Command {}
          export class UpdateCommand extends Command {}
          export class DynamoDBDocumentClient { static from() { return { send() {} }; } }
        `,
        loader: 'js',
      }));
    }
  );

  const client = {
    async send(command) {
      state.commands.push(command);
      return {};
    },
  };
  const environment = {
    FAQ_TABLE_NAME_PREFIX: 'candidate',
    FAQ_AGENT_CONFIG_TABLE_NAME: 'candidate-AgentConfig',
  };

  assert.throws(
    () => module.resolveAgentConfigTableName({
      FAQ_AGENT_CONFIG_TABLE_NAME: 'candidate-AgentConfig',
    }),
    /FAQ_TABLE_NAME_PREFIX/
  );
  assert.throws(
    () => module.resolveAgentConfigTableName({
      FAQ_TABLE_NAME_PREFIX: 'candidate',
      FAQ_AGENT_CONFIG_TABLE_NAME: 'other-AgentConfig',
    }),
    /must exactly match/
  );
  assert.equal(module.resolveDynamoDbEndpoint({}), undefined);
  assert.equal(
    module.resolveDynamoDbEndpoint({ DYNAMODB_ENDPOINT: 'http://localhost:8000' }),
    'http://localhost:8000'
  );
  assert.throws(
    () => module.resolveDynamoDbEndpoint({ DYNAMODB_ENDPOINT: 'localhost:8000' }),
    /valid http\(s\) URL/
  );

  const validOut = [];
  assert.equal(await module.runAgentConfigCli(['validate', 'valid.json'], {
    environment: {},
    readTextFile: async () => JSON.stringify({
      agentId: 'sales',
      enabled: true,
      model: 'claude-sonnet-5',
      maxOutputTokens: 1500,
      logPolicy: 'metadata_only',
    }),
    stdout: (line) => validOut.push(line),
    stderr: assert.fail,
  }), 0);
  assert.equal(JSON.parse(validOut[0]).agentId, 'sales');
  assert.equal(JSON.parse(validOut[0]).logPolicy, 'metadata_only');
  assert.equal(state.commands.length, 0, 'validate must not initialize or write DynamoDB');

  const invalidErrors = [];
  const invalidProfile = {
    agentId: 'Sales',
    enabled: 'true',
    model: 'not-allowed',
    maxOutputTokens: 1501,
    logPolicy: 'full',
  };
  assert.equal(await module.runAgentConfigCli(['validate', 'invalid.json'], {
    environment: {},
    readTextFile: async () => JSON.stringify(invalidProfile),
    stdout: assert.fail,
    stderr: (line) => invalidErrors.push(line),
  }), 1);
  assert.match(invalidErrors.join('\n'), /agentId/);
  assert.match(invalidErrors.join('\n'), /enabled/);
  assert.match(invalidErrors.join('\n'), /model/);
  assert.match(invalidErrors.join('\n'), /maxOutputTokens/);
  assert.match(invalidErrors.join('\n'), /logPolicy/);

  assert.equal(await module.runAgentConfigCli(['upsert', 'invalid.json'], {
    environment,
    documentClient: client,
    readTextFile: async () => JSON.stringify(invalidProfile),
    stdout: assert.fail,
    stderr: () => {},
  }), 1);
  assert.equal(state.commands.length, 0, 'invalid upsert must perform no write');

  assert.equal(await module.runAgentConfigCli(['upsert', 'valid.json'], {
    environment,
    documentClient: client,
    readTextFile: async () => JSON.stringify({
      agentId: 'sales',
      enabled: true,
      logPolicy: 'redacted_full',
    }),
    stdout: () => {},
    stderr: assert.fail,
  }), 0);
  // upsertは既存行のGet（共用行の消失ガード）→Putの2コマンド。
  assert.equal(state.commands.length, 2);
  assert.deepEqual(state.commands[0].input, {
    TableName: 'candidate-AgentConfig',
    Key: { agentId: 'sales' },
    ConsistentRead: true,
  });
  assert.deepEqual(state.commands[1].input, {
    TableName: 'candidate-AgentConfig',
    Item: { agentId: 'sales', enabled: true, logPolicy: 'redacted_full' },
  });

  // 既存行にあるフィールドを落とすupsertは--replaceなしでは拒否し、書き込みも行わない。
  state.commands.length = 0;
  const guardedClient = {
    async send(command) {
      state.commands.push(command);
      if (command.constructor.name === 'GetCommand') {
        return {
          Item: {
            agentId: 'sales',
            enabled: true,
            systemPrompt: 'slack用の共用プロンプト',
            logPolicy: 'redacted_full',
          },
        };
      }
      return {};
    },
  };
  const guardErrors = [];
  assert.equal(await module.runAgentConfigCli(['upsert', 'partial.json'], {
    environment,
    documentClient: guardedClient,
    readTextFile: async () => JSON.stringify({ agentId: 'sales', enabled: true }),
    stdout: assert.fail,
    stderr: (line) => guardErrors.push(line),
  }), 1);
  assert.match(guardErrors.join('\n'), /--replace/);
  assert.match(guardErrors.join('\n'), /logPolicy/);
  assert.equal(state.commands.length, 1, 'guarded upsert must stop before PutCommand');

  state.commands.length = 0;
  assert.equal(await module.runAgentConfigCli(['upsert', 'partial.json', '--replace'], {
    environment,
    documentClient: guardedClient,
    readTextFile: async () => JSON.stringify({ agentId: 'sales', enabled: true }),
    stdout: () => {},
    stderr: assert.fail,
  }), 0);
  assert.equal(state.commands.length, 2);
  assert.deepEqual(state.commands[1].input, {
    TableName: 'candidate-AgentConfig',
    Item: { agentId: 'sales', enabled: true },
  });
});
