import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faq-transport-test-'));
await build({
  entryPoints: [path.join(HERE, '..', 'functions', 'faq-chat', 'ports', 'remote-transport.ts')],
  bundle: true, format: 'esm', platform: 'node', outdir: outDir, outExtension: { '.js': '.mjs' },
});
const { readRemoteFaqTransport } = await import(pathToFileURL(path.join(outDir, 'remote-transport.mjs')).href);
after(() => {
  assert.equal(path.dirname(path.resolve(outDir)), path.resolve(os.tmpdir()));
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('missing remote transport dark-ships split-v1; explicit deployed transports are accepted', () => {
  assert.equal(readRemoteFaqTransport({}), 'split-v1');
  assert.equal(readRemoteFaqTransport({ FAQ_REMOTE_RAG_TRANSPORT: undefined }), 'split-v1');
  for (const kind of ['split-v1', 'one-shot-v1']) {
    assert.equal(readRemoteFaqTransport({ FAQ_REMOTE_RAG_TRANSPORT: kind }), kind);
  }
});

test('empty, padded, wrong-case and unknown remote transport values fail fast', () => {
  for (const value of ['', ' ', ' split-v1', 'one-shot-v1 ', 'ONE-SHOT-V1', 'remote-v1', 'free', 'SYNTHETIC_SECRET']) {
    assert.throws(() => readRemoteFaqTransport({ FAQ_REMOTE_RAG_TRANSPORT: value }), (error) => {
      assert.match(error.message, /Invalid FAQ_REMOTE_RAG_TRANSPORT/);
      assert.doesNotMatch(error.message, /SYNTHETIC_SECRET/);
      return true;
    });
  }
});
