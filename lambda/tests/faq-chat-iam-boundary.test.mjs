#!/usr/bin/env node
/** faq-chat の最小 IAM 境界を canonical / public lite の両形式で固定する。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CURRENT_TEMPLATE = path.join(HERE, '..', 'template.yaml');
const PUBLIC_LITE_TEMPLATE = path.join(
  HERE,
  '..',
  '..',
  'tools',
  'public-sync',
  'overlay',
  'lambda',
  'template.yaml'
);

function templateContract(label, file, kind) {
  return { label, source: fs.readFileSync(file, 'utf8'), kind };
}

const currentSource = fs.readFileSync(CURRENT_TEMPLATE, 'utf8');
const contracts = /^  FaqTableNamespace:\s*$/mu.test(currentSource)
  ? [{ label: 'public lite', source: currentSource, kind: 'public' }]
  : [
      { label: 'canonical', source: currentSource, kind: 'canonical' },
      ...(fs.existsSync(PUBLIC_LITE_TEMPLATE)
        ? [templateContract('public lite', PUBLIC_LITE_TEMPLATE, 'public')]
        : []),
    ];

function resourceBlock(source, logicalId) {
  const startMarker = `  ${logicalId}:`;
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${logicalId} must exist`);
  const rest = source.slice(start + startMarker.length);
  const nextResource = rest.search(/^  [A-Za-z][A-Za-z0-9]+:\r?$/m);
  return nextResource === -1
    ? source.slice(start)
    : source.slice(start, start + startMarker.length + nextResource);
}

function policyCode(source) {
  const faqChat = resourceBlock(source, 'FaqChatFunction');
  const policiesStart = faqChat.indexOf('\n      Policies:');
  const metadataStart = faqChat.indexOf('\n    Metadata:');
  assert.notEqual(policiesStart, -1, 'FaqChatFunction Policies must exist');
  assert.notEqual(metadataStart, -1, 'FaqChatFunction Metadata must exist');
  return faqChat
    .slice(policiesStart, metadataStart)
    .split(/\r?\n/u)
    .filter((line) => !/^\s*#/u.test(line))
    .join('\n');
}

function actions(code) {
  return [
    ...new Set([
      ...[...code.matchAll(/^\s+Action:\s*([a-z0-9-]+:[A-Za-z0-9*]+)\s*$/gmu)].map(
        (match) => match[1]
      ),
      ...[...code.matchAll(/^\s+-\s+([a-z0-9-]+:[A-Za-z0-9*]+)\s*$/gmu)].map(
        (match) => match[1]
      ),
    ]),
  ].sort();
}

function statementForAction(code, action) {
  const statements = code.split(/(?=^\s+- Effect:\s*Allow\s*$)/gmu);
  const matches = statements.filter((statement) =>
    new RegExp(`(?:Action:\\s*|^\\s+-\\s+)${action}\\s*$`, 'mu').test(
      statement
    )
  );
  assert.equal(matches.length, 1, `${action} must have exactly one statement`);
  return matches[0];
}

const dataContracts = [
  ['dynamodb:Scan', 'KnowledgeEntries', 'KnowledgeEntriesTable'],
  ['dynamodb:GetItem', 'Settings', 'SettingsTable'],
  ['dynamodb:PutItem', 'FaqQaLogs', 'FaqQaLogsTable'],
];

for (const contract of contracts) {
  test(`${contract.label}: faq-chat IAM is limited to exact data and remote-auth actions`, () => {
    const code = policyCode(contract.source);
    const expectedActions = [
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:Scan',
      'sts:AssumeRole',
      ...(contract.kind === 'canonical' ? ['execute-api:Invoke'] : []),
    ].sort();

    assert.deepEqual(actions(code), expectedActions);
    assert.doesNotMatch(code, /\b(?:DeleteItem|UpdateItem|BatchWriteItem)\b/u);
    assert.doesNotMatch(code, /\*/u);
    if (contract.kind === 'canonical') {
      assert.doesNotMatch(code, /\bAgentConfig(?:Table)?\b/u);
    }

    for (const [action, suffix, logicalId] of dataContracts) {
      const statement = statementForAction(code, action);
      if (contract.kind === 'canonical') {
        assert.match(
          statement,
          new RegExp(
            `Resource:\\s*\\n\\s+- !Sub 'arn:\\$\\{AWS::Partition\\}:dynamodb:` +
              `\\$\\{AWS::Region\\}:\\$\\{AWS::AccountId\\}:table/` +
              `\\$\\{TenantSlug\\}-\\$\\{DeploymentStage\\}-${suffix}'`,
            'u'
          )
        );
        assert.doesNotMatch(statement, /!GetAtt\s+[A-Za-z][A-Za-z0-9]*Table\.Arn/u);
      } else {
        if (action === 'dynamodb:GetItem') {
          assert.match(
            statement,
            /Resource:\s*\n\s+- !GetAtt SettingsTable\.Arn\s*\n\s+- !GetAtt AgentConfigTable\.Arn/u
          );
        } else {
          assert.match(statement, new RegExp(`Resource: !GetAtt ${logicalId}\\.Arn`, 'u'));
        }
        assert.doesNotMatch(
          statement,
          /table\/\$\{TenantSlug\}-\$\{DeploymentStage\}-/u
        );
      }
    }

    const assumeRole = statementForAction(code, 'sts:AssumeRole');
    assert.match(assumeRole, /Resource: !Ref FaqRemoteRagRoleArn/u);

    if (contract.kind === 'canonical') {
      const directInvoke = statementForAction(code, 'execute-api:Invoke');
      const directInvokeResources = [
        ...directInvoke.matchAll(
          /^\s+- !Sub (arn:\$\{AWS::Partition\}:execute-api:[^\r\n]+)$/gmu
        ),
      ].map((match) => match[1]);
      assert.deepEqual(directInvokeResources.sort(), [
        'arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${FaqRemoteRagApiId}/api/POST/v1/generate',
        'arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${FaqRemoteRagApiId}/api/POST/v1/retrieve',
      ]);
    } else {
      assert.doesNotMatch(code, /execute-api:Invoke/u);
      assert.doesNotMatch(code, /arn:aws:dynamodb:/u);
    }
  });
}
