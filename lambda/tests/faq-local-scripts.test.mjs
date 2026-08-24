#!/usr/bin/env node
/** Local FAQ startup-script boundary tests / issue #120 run6a. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, '..', '..');
const SHELL_SCRIPTS = [
  'scripts/preflight.sh',
  'scripts/faq-local-up.sh',
  'scripts/faq-local-down.sh',
];
const LEGACY_EMULATOR = ['local', 'stack'].join('');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, ...relativePath.split('/')), 'utf8');
}

function serviceBlock(composeSource, serviceName) {
  const lines = composeSource.replaceAll('\r\n', '\n').split('\n');
  const start = lines.findIndex((line) => line === `  ${serviceName}:`);
  assert.notEqual(start, -1, `${serviceName} service must exist`);

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\S/.test(lines[index]) || /^  [A-Za-z0-9_.-]+:\s*$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function isExcluded(relativePath, isDirectory) {
  const parts = relativePath.split('/');
  if (parts.includes('.git') || parts.includes('node_modules')) return true;
  if (isDirectory) return false;

  return (
    /^docs\/WORK_LOG_[^/]*$/i.test(relativePath) ||
    relativePath.toLowerCase() === 'docs/lambda_test_checklist.md'
  );
}

function repositoryFiles() {
  const result = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  );
  if (result.error === undefined && result.status === 0) {
    return result.stdout.split('\0').filter(Boolean);
  }

  // Public-sync contract tests run this suite in a generated tree without `.git`.
  // Walk that tree without following dependency links so the same boundary remains testable.
  const files = [];
  const visit = (directory, relativeDirectory = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      if (entry.isDirectory()) {
        if (!isExcluded(relativePath, true)) {
          visit(path.join(directory, entry.name), relativePath);
        }
      } else if (entry.isFile() && !isExcluded(relativePath, false)) {
        files.push(relativePath);
      }
    }
  };
  visit(REPO_ROOT);
  return files.sort();
}

function findForbiddenReferences() {
  const matches = [];
  for (const relativePath of repositoryFiles()) {
    if (isExcluded(relativePath, false)) continue;
    const absolutePath = path.join(REPO_ROOT, ...relativePath.split('/'));
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) continue;
    const source = fs.readFileSync(absolutePath, 'utf8');
    if (source.toLowerCase().includes(LEGACY_EMULATOR)) matches.push(relativePath);
  }
  return matches;
}

test('local FAQ shell scripts pass bash syntax validation', () => {
  for (const script of SHELL_SCRIPTS) {
    const result = spawnSync('bash', ['-n', script], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert.equal(result.error, undefined, `${script}: ${result.error?.message ?? ''}`);
    assert.equal(
      result.status,
      0,
      `${script} failed bash -n:\n${result.stderr || result.stdout}`
    );
  }
});

test('compose keeps a pinned and health-checked DynamoDB Local service only', () => {
  const compose = readRepoFile('docker-compose.yml');
  assert.doesNotMatch(compose, new RegExp(LEGACY_EMULATOR, 'i'));

  const dynamodb = serviceBlock(compose, 'dynamodb-local');
  assert.match(dynamodb, /^\s{4}healthcheck:\s*$/m);

  const image = dynamodb.match(/^\s{4}image:\s*["']?([^"'\s#]+)["']?\s*$/m);
  assert.ok(image, 'dynamodb-local must declare an image');
  assert.match(image[1], /^amazon\/dynamodb-local:[^:@\s]+$/);
  assert.doesNotMatch(image[1], /:latest$/i);
});

test('FAQ seed uses the sample KB and public default-agent records', () => {
  const seed = readRepoFile('scripts/faq-local-seed.ts');
  assert.match(seed, /sample-kb\.json/);
  assert.match(seed, /visibility\s*:\s*['"]public['"]/);
  assert.match(seed, /agentId\s*:\s*['"]default['"]/);
});

test('FAQ startup connects SAM and DynamoDB on the shared network in free mode', () => {
  const startup = readRepoFile('scripts/faq-local-up.sh');
  assert.match(startup, /--docker-network(?:=|\s+)['"]?lambda-local/);
  assert.match(startup, /dynamodb-local:8000/);
  assert.match(startup, /FAQ_PORTS_PROFILE["']?\s*(?::|=)\s*["']?free/);
});

test('FAQ startup injects one exact local table namespace into the lite runtime', () => {
  const startup = readRepoFile('scripts/faq-local-up.sh');
  const environmentBlock = startup.match(
    /const faqEnvironment = \{(?<body>[\s\S]*?)\n\};/u
  )?.groups?.body;
  assert.ok(environmentBlock, 'faqEnvironment object must exist');

  const stringProperty = (name) => {
    const match = environmentBlock.match(
      new RegExp(`^\\s*${name}:\\s*['"]([^'"]+)['"],?\\s*$`, 'mu')
    );
    assert.ok(match, `${name} must be a string literal in faqEnvironment`);
    return match[1];
  };

  const prefix = stringProperty('FAQ_TABLE_NAME_PREFIX');
  assert.equal(prefix, 'dev');
  assert.deepEqual(
    {
      Settings: stringProperty('FAQ_SETTINGS_TABLE_NAME'),
      KnowledgeEntries: stringProperty('FAQ_KNOWLEDGE_ENTRIES_TABLE_NAME'),
      FaqQaLogs: stringProperty('FAQ_QA_LOGS_TABLE_NAME'),
    },
    {
      Settings: `${prefix}-Settings`,
      KnowledgeEntries: `${prefix}-KnowledgeEntries`,
      FaqQaLogs: `${prefix}-FaqQaLogs`,
    }
  );
});

test('deprecated emulator references are absent outside historical documents', () => {
  assert.deepEqual(findForbiddenReferences(), []);
});

test('preflight treats port 8000 held by this project\'s dynamodb-local container as OK (re-run)', () => {
  const preflight = readRepoFile('scripts/preflight.sh');
  assert.match(preflight, /docker ps -q --filter name=.*dynamodb-local.* --filter publish=8000/);
  assert.match(preflight, /re-run is fine/);
});
