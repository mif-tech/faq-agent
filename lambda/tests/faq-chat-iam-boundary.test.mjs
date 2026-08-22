#!/usr/bin/env node
/** faq-chat の最小 IAM 境界を固定する構造テスト / issue #120 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(HERE, '..', 'template.yaml');
const templateSource = fs.readFileSync(TEMPLATE, 'utf8');

function resourceBlock(logicalId) {
  const startMarker = `  ${logicalId}:`;
  const start = templateSource.indexOf(startMarker);
  assert.notEqual(start, -1, `${logicalId} must exist`);
  const rest = templateSource.slice(start + startMarker.length);
  const nextResource = rest.search(/^  [A-Za-z][A-Za-z0-9]+:\r?$/m);
  return nextResource === -1
    ? templateSource.slice(start)
    : templateSource.slice(start, start + startMarker.length + nextResource);
}

test('FaqChatFunction は KnowledgeEntries / Settings / FaqQaLogs 以外へ権限を持たない', () => {
  const faqChat = resourceBlock('FaqChatFunction');
  const policiesStart = faqChat.indexOf('\n      Policies:');
  const metadataStart = faqChat.indexOf('\n    Metadata:');
  assert.notEqual(policiesStart, -1, 'FaqChatFunction Policies must exist');
  assert.notEqual(metadataStart, -1, 'FaqChatFunction Metadata must exist');
  const policies = faqChat.slice(policiesStart, metadataStart);
  const policyCode = policies
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  const tableNames = [
    ...new Set(
      [...policyCode.matchAll(/table\/\$\{Environment\}-([A-Za-z][A-Za-z0-9]*)/g)].map(
        (match) => match[1]
      )
    ),
  ].sort();

  assert.deepEqual(tableNames, ['FaqQaLogs', 'KnowledgeEntries', 'Settings']);
  assert.doesNotMatch(policyCode, /\bAgentConfig(?:Table)?\b/);
});
