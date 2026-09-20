import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const canonicalPath = path.join(HERE, '..', 'template.yaml');
const overlayPath = path.join(HERE, '../../tools/public-sync/overlay/lambda/template.yaml');
const remotePath = path.join(HERE, '../stacks/remote-rag/template.yaml');
const read = (file) => fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
const current = read(canonicalPath);
const adapter = read(path.join(HERE, '../functions/faq-chat/adapters/inflight.ts'));
const slotKeyPrefix = adapter.match(/const key = \{ key: `([^`$]+)\$\{slot\}` \}/)?.[1];
const templates = [{ label: 'current', source: current }];
if (fs.existsSync(overlayPath)) templates.push({ label: 'public lite', source: read(overlayPath) });

function entry(source, name) {
  const start = source.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `${name} must exist`);
  const rest = source.slice(start + 1);
  const end = rest.slice(1).search(/^  [A-Za-z][A-Za-z0-9]+:\s*$|^[A-Za-z][A-Za-z0-9]+:\s*$/m);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

function assertDisabledIntegerLimit(source, name) {
  const parameter = entry(source, name);
  assert.match(parameter, /Type: Number\n/);
  assert.match(parameter, /Default: 0\n/);
  assert.match(parameter, /MinValue: 0\n/);
  assert.match(parameter, /MaxValue: 10\n/);
  assert.match(parameter, /AllowedValues: \[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10\]/);
}

for (const { label, source } of templates) {
  test(`${label}: IAM processing-slot key condition matches the adapter prefix`, () => {
    assert.equal(slotKeyPrefix, 'faq_inflight_slot#');
    const handler = entry(source, 'FaqChatFunction');
    const updateStatements = handler.split(/(?=^\s+- Effect: Allow\s*$)/mu)
      .filter((statement) => /dynamodb:UpdateItem\n/.test(statement));
    assert.equal(updateStatements.length, 1);
    const leadingKeys = updateStatements[0].match(
      /Condition:\n\s+ForAllValues:StringLike:\n\s+dynamodb:LeadingKeys:\n\s+- '([^']+)'/
    );
    assert.equal(leadingKeys?.[1], `${slotKeyPrefix}*`);
  });

  test(`${label}: FAQ processing slots default to zero and admit only integers through ten`, () => {
    assertDisabledIntegerLimit(source, 'FaqMaxInflight');
    assert.match(entry(source, 'FaqChatFunction'), /FAQ_MAX_INFLIGHT: !Ref FaqMaxInflight/);
    // Settings remains the existing key-only table, without a TTL added for leases.
    if (/^  SettingsTable:/m.test(source)) {
      const settings = entry(source, 'SettingsTable');
      assert.match(settings, /AttributeName: key\n\s+KeyType: HASH/);
      assert.doesNotMatch(settings, /TimeToLiveSpecification:|KeyType: RANGE/);
    }
    assert.doesNotMatch(source, /^  (?:FaqInflight|InflightSlots|ProcessingSlots)Table:/m);
  });
}

if (fs.existsSync(remotePath)) {
  const source = read(remotePath);
  test('private v1 processing slots reuse RemoteRagState and its existing UpdateItem grant and ttl', () => {
    assertDisabledIntegerLimit(source, 'RemoteRagMaxInflightTotal');
    const handler = entry(source, 'RemoteRagFunction');
    assert.match(handler, /REMOTE_RAG_MAX_INFLIGHT_TOTAL: !Ref RemoteRagMaxInflightTotal/);
    assert.match(handler, /dynamodb:UpdateItem\n\s+Resource: !GetAtt RemoteRagState\.Arn/);
    const state = entry(source, 'RemoteRagState');
    assert.match(state, /AttributeName: pk\n\s+KeyType: HASH/);
    assert.match(state, /AttributeName: sk\n\s+KeyType: RANGE/);
    assert.match(state, /TimeToLiveSpecification:\n\s+AttributeName: ttl\n\s+Enabled: true/);
    assert.doesNotMatch(source, /^  (?:RemoteRagInflight|InflightSlots|ProcessingSlots)Table:/m);
    assert.doesNotMatch(entry(source, 'RemoteRagV2SearchFunction'), /REMOTE_RAG_MAX_INFLIGHT_TOTAL/);
  });
}
