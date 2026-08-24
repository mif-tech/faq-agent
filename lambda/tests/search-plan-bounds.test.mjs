#!/usr/bin/env node
/** Shared search-plan bounds の正規化・overflow 契約。 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(HERE, '..', 'shared', 'search-plan-bounds.ts');
const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'search-plan-bounds-test-'));
const output = path.join(outputRoot, 'search-plan-bounds.mjs');

after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));

await build({
  entryPoints: [source],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: output,
  logLevel: 'silent',
});

const { boundPlanTexts } = await import(pathToFileURL(output).href);

test('NFKC・大小文字を無視して重複除去し、先頭表記を保つ', () => {
  assert.deepEqual(boundPlanTexts([' ＡＢＣ ', 'abc'], 8, 16, 'drop'), {
    texts: ['ＡＢＣ'],
    droppedCount: 0,
    rawCount: 1,
  });
});

test('drop policy は code point 上限超過だけを除外件数に数える', () => {
  assert.deepEqual(boundPlanTexts(['A😀B', 'ok'], 2, 2, 'drop'), {
    texts: ['ok'],
    droppedCount: 1,
    rawCount: 2,
  });
});

test('truncate policy は surrogate pair を分割せず code point 境界で切る', () => {
  const result = boundPlanTexts(['A😀B'], 1, 2, 'truncate');
  assert.deepEqual(result, {
    texts: ['A😀'],
    droppedCount: 0,
    rawCount: 1,
  });
  assert.equal(Array.from(result.texts[0]).length, 2);
});
