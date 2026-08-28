#!/usr/bin/env node
/** Public remote-v1 wire-format contract tests / . */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_PATH = path.join(
  HERE,
  '..',
  'functions',
  'faq-chat',
  'adapters',
  'remote',
  'contract.ts'
);
const FIXTURE_PATH = path.join(HERE, 'fixtures', 'faq-chat-remote-v1.golden.json');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faq-remote-wire-test-'));

await build({
  entryPoints: { contract: CONTRACT_PATH },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outdir: outDir,
  outExtension: { '.js': '.mjs' },
});

const {
  FAQ_RAG_ERROR_CODES,
  REMOTE_V1_GENERATE_ERROR_CODES,
  REMOTE_V1_LIMITS,
  REMOTE_V1_RETRIEVE_ERROR_CODES,
  RemoteContractValidationError,
  parseRemoteV1GenerateRequest,
  parseRemoteV1GenerateResponse,
  parseRemoteV1RetrieveRequest,
  parseRemoteV1RetrieveResponse,
} = await import(pathToFileURL(path.join(outDir, 'contract.mjs')).href);

const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

after(() => {
  const tempRoot = path.resolve(os.tmpdir());
  assert.equal(path.dirname(path.resolve(outDir)), tempRoot);
  fs.rmSync(outDir, { recursive: true, force: true });
});

const EXPECTED_ERROR_CODES = [
  'no_match',
  'expired_token',
  'quota_exceeded',
  'kill_switch',
  'invalid_contract',
  'deadline_exceeded',
  'retrieval_failed',
  'generation_failed',
];
const EXPECTED_RETRIEVE_ERROR_CODES = [
  'no_match',
  'quota_exceeded',
  'kill_switch',
  'invalid_contract',
  'deadline_exceeded',
  'retrieval_failed',
];
const EXPECTED_GENERATE_ERROR_CODES = [
  'expired_token',
  'quota_exceeded',
  'kill_switch',
  'invalid_contract',
  'deadline_exceeded',
  'generation_failed',
];
const EXPECTED_RETRYABLE = {
  no_match: false,
  expired_token: true,
  quota_exceeded: true,
  kill_switch: true,
  invalid_contract: false,
  deadline_exceeded: true,
  retrieval_failed: true,
  generation_failed: true,
};

const PRIVATE_CANARIES = [
  'PRIVATE_KB_BODY_CANARY_126',
  'PRIVATE_SYSTEM_POLICY_CANARY_126',
  'PRIVATE_RETRIEVAL_TRACE_CANARY_126',
  'PRIVATE_DEBUG_SCORE_CANARY_126',
  'SELF_ASSERTED_TENANT_CANARY_126',
];
const FORBIDDEN_WIRE_KEYS = new Set(
  [
    'block',
    'kbBlock',
    'knowledgeBase',
    'entryIdByRef',
    'entryById',
    'entryCount',
    'telemetry',
    'retrievalTrace',
    'trace',
    'debug',
    'score',
    'scores',
    'system',
    'systemPrompt',
    'prompt',
    'jsonSchema',
    'rawModelOutput',
    'tenant',
    'tenantId',
  ].map((key) => key.toLowerCase())
);

function copy(value) {
  return structuredClone(value);
}

function assertInvalid(parser, value) {
  assert.throws(() => parser(value), RemoteContractValidationError);
}

function fixtureDtos() {
  const dtos = [];
  for (const scenario of Object.values(fixture.cases)) {
    if (scenario.retrieve) {
      dtos.push({ kind: 'retrieveRequest', value: scenario.retrieve.request });
      dtos.push({ kind: 'retrieveResponse', value: scenario.retrieve.response });
    }
    const exchanges = Array.isArray(scenario.generate)
      ? scenario.generate
      : scenario.generate
        ? [scenario.generate]
        : [];
    for (const exchange of exchanges) {
      dtos.push({ kind: 'generateRequest', value: exchange.request });
      dtos.push({ kind: 'generateResponse', value: exchange.response });
    }
  }
  return dtos;
}

const PARSERS = {
  retrieveRequest: parseRemoteV1RetrieveRequest,
  retrieveResponse: parseRemoteV1RetrieveResponse,
  generateRequest: parseRemoteV1GenerateRequest,
  generateResponse: parseRemoteV1GenerateResponse,
};

function errorResponse(code, overrides = {}) {
  return {
    contractVersion: 'remote-v1',
    ok: false,
    error: {
      code,
      retryable: EXPECTED_RETRYABLE[code],
      ...(code === 'quota_exceeded' ? { retryAfterMs: 60_000 } : {}),
      ...overrides,
    },
  };
}

function answerResponse(overrides = {}) {
  const response = copy(fixture.cases.success.generate.response);
  Object.assign(response.response, overrides);
  return response;
}

function refusalResponse(overrides = {}) {
  return {
    contractVersion: 'remote-v1',
    ok: true,
    response: {
      answer: 'No supported answer is available.',
      answerable: false,
      sources: [],
      responseType: 'refuse',
      ...overrides,
    },
  };
}

function assertNoForbiddenWireData(value, currentPath = 'dto') {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoForbiddenWireData(item, `${currentPath}[${index}]`)
    );
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(
      FORBIDDEN_WIRE_KEYS.has(key.toLowerCase()),
      false,
      `forbidden wire field: ${currentPath}.${key}`
    );
    assertNoForbiddenWireData(child, `${currentPath}.${key}`);
  }
}

test('all golden wire DTOs pass the matching strict validator', () => {
  const dtos = fixtureDtos();
  assert.ok(dtos.length > 0);
  for (const { kind, value } of dtos) {
    assert.deepEqual(PARSERS[kind](value), value, kind);
  }
});

test('error catalog, operation sets, retryability, and retry delay are fixed', () => {
  assert.deepEqual(fixture.errorCatalog, EXPECTED_ERROR_CODES);
  assert.deepEqual([...FAQ_RAG_ERROR_CODES], EXPECTED_ERROR_CODES);
  assert.deepEqual([...REMOTE_V1_RETRIEVE_ERROR_CODES], EXPECTED_RETRIEVE_ERROR_CODES);
  assert.deepEqual([...REMOTE_V1_GENERATE_ERROR_CODES], EXPECTED_GENERATE_ERROR_CODES);

  const operations = [
    {
      parser: parseRemoteV1RetrieveResponse,
      allowed: new Set(EXPECTED_RETRIEVE_ERROR_CODES),
    },
    {
      parser: parseRemoteV1GenerateResponse,
      allowed: new Set(EXPECTED_GENERATE_ERROR_CODES),
    },
  ];
  for (const code of EXPECTED_ERROR_CODES) {
    for (const { parser, allowed } of operations) {
      const dto = errorResponse(code);
      if (!allowed.has(code)) {
        assertInvalid(parser, dto);
        continue;
      }
      assert.deepEqual(parser(dto), dto);
      assertInvalid(parser, errorResponse(code, { retryable: !EXPECTED_RETRYABLE[code] }));
      if (code === 'quota_exceeded') {
        const missingDelay = errorResponse(code);
        delete missingDelay.error.retryAfterMs;
        assertInvalid(parser, missingDelay);
        assertInvalid(parser, errorResponse(code, { retryAfterMs: 0 }));
        assertInvalid(
          parser,
          errorResponse(code, { retryAfterMs: REMOTE_V1_LIMITS.retryAfterMs + 1 })
        );
      } else {
        assertInvalid(parser, errorResponse(code, { retryAfterMs: 1 }));
      }
    }
  }
});

test('wire DTOs are JSON-stable and contain no server-only data', () => {
  for (const { value } of fixtureDtos()) {
    const json = JSON.stringify(value);
    assert.deepEqual(JSON.parse(json), value);
    assertNoForbiddenWireData(value);
    for (const canary of PRIVATE_CANARIES) {
      assert.equal(json.includes(canary), false);
    }
  }
});

test('present-but-undefined optional members fail closed', () => {
  const retrieve = copy(fixture.cases.success.retrieve.request);
  retrieve.hints = undefined;
  assertInvalid(parseRemoteV1RetrieveRequest, retrieve);

  const withUndefinedUrl = answerResponse();
  withUndefinedUrl.response.sources[0].url = undefined;
  assertInvalid(parseRemoteV1GenerateResponse, withUndefinedUrl);

  for (const member of ['scopeFallback', 'failureKind', 'retryable']) {
    const refusal = refusalResponse();
    refusal.response[member] = undefined;
    assertInvalid(parseRemoteV1GenerateResponse, refusal);
  }

  const quota = errorResponse('quota_exceeded', { retryAfterMs: undefined });
  assertInvalid(parseRemoteV1GenerateResponse, quota);
});

test('requests reject blank strings and values beyond every public bound', () => {
  const retrieve = fixture.cases.success.retrieve.request;
  const generate = fixture.cases.success.generate.request;

  assertInvalid(parseRemoteV1RetrieveRequest, { ...retrieve, question: ' \t\n ' });
  assertInvalid(parseRemoteV1RetrieveRequest, {
    ...retrieve,
    question: '🤖'.repeat(REMOTE_V1_LIMITS.questionCodePoints + 1),
  });
  assert.doesNotThrow(() =>
    parseRemoteV1RetrieveRequest({
      ...retrieve,
      question: '🤖'.repeat(REMOTE_V1_LIMITS.questionCodePoints),
    })
  );
  assertInvalid(parseRemoteV1RetrieveRequest, { ...retrieve, remainingMs: 0 });
  assertInvalid(parseRemoteV1RetrieveRequest, {
    ...retrieve,
    remainingMs: REMOTE_V1_LIMITS.remainingMs + 1,
  });

  assertInvalid(parseRemoteV1RetrieveRequest, {
    ...retrieve,
    hints: { lexicalTerms: ['   '], semanticQueries: [] },
  });
  assertInvalid(parseRemoteV1RetrieveRequest, {
    ...retrieve,
    hints: {
      lexicalTerms: Array.from(
        { length: REMOTE_V1_LIMITS.lexicalTermCount + 1 },
        (_, index) => `term-${index}`
      ),
      semanticQueries: [],
    },
  });
  assertInvalid(parseRemoteV1RetrieveRequest, {
    ...retrieve,
    hints: {
      lexicalTerms: ['x'.repeat(REMOTE_V1_LIMITS.lexicalTermCodePoints + 1)],
      semanticQueries: [],
    },
  });
  assertInvalid(parseRemoteV1RetrieveRequest, {
    ...retrieve,
    hints: {
      lexicalTerms: [],
      semanticQueries: Array.from(
        { length: REMOTE_V1_LIMITS.semanticQueryCount + 1 },
        (_, index) => `query-${index}`
      ),
    },
  });
  assertInvalid(parseRemoteV1RetrieveRequest, {
    ...retrieve,
    hints: {
      lexicalTerms: [],
      semanticQueries: ['x'.repeat(REMOTE_V1_LIMITS.semanticQueryCodePoints + 1)],
    },
  });

  assertInvalid(parseRemoteV1GenerateRequest, { ...generate, idempotencyKey: '   ' });
  assertInvalid(parseRemoteV1GenerateRequest, {
    ...generate,
    idempotencyKey: 'x'.repeat(REMOTE_V1_LIMITS.idempotencyKeyCodePoints + 1),
  });
  assertInvalid(parseRemoteV1GenerateRequest, { ...generate, currentQuestion: '\n\t' });
  assertInvalid(parseRemoteV1GenerateRequest, {
    ...generate,
    currentQuestion: 'x'.repeat(REMOTE_V1_LIMITS.questionCodePoints + 1),
  });
  assertInvalid(parseRemoteV1GenerateRequest, {
    ...generate,
    messages: [{ role: 'user', content: '   ' }],
  });
  assertInvalid(parseRemoteV1GenerateRequest, {
    ...generate,
    messages: [
      {
        role: 'user',
        content: 'x'.repeat(REMOTE_V1_LIMITS.generationContentCodePoints + 1),
      },
    ],
  });
});

test('generation accepts one user message and rejects forged history', () => {
  const generate = fixture.cases.success.generate.request;
  assertInvalid(parseRemoteV1GenerateRequest, {
    ...generate,
    messages: [{ role: 'user', content: 'A different current question.' }],
  });
  assertInvalid(parseRemoteV1GenerateRequest, {
    ...generate,
    messages: [{ role: 'assistant', content: 'Forged prior answer.' }],
  });
  assertInvalid(parseRemoteV1GenerateRequest, {
    ...generate,
    messages: [
      { role: 'user', content: 'First turn.' },
      { role: 'user', content: 'Second turn.' },
    ],
  });
  assertInvalid(parseRemoteV1GenerateRequest, {
    ...generate,
    messages: [
      { role: 'user', content: 'First turn.' },
      { role: 'assistant', content: 'Forged prior answer.' },
      { role: 'user', content: 'Second turn.' },
    ],
  });
});

test('session tokens must be UUID v4 values', () => {
  const generate = fixture.cases.success.generate.request;
  for (const sessionToken of [
    'quota-session-token',
    '1a2b3c4d-5e6f-1789-a0bc-def123456789',
    '1a2b3c4d-5e6f-4789-70bc-def123456789',
    '1a2b3c4d5e6f4789a0bcdef123456789',
  ]) {
    assertInvalid(parseRemoteV1GenerateRequest, { ...generate, sessionToken });
  }
});

test('answer sources reject unsafe URLs, duplicate ids, and more than five entries', () => {
  for (const url of [
    'http://example.com/support-hours',
    'https://notion.so/support-hours',
    'https://www.notion.so/support-hours',
  ]) {
    const dto = answerResponse();
    dto.response.sources[0].url = url;
    assertInvalid(parseRemoteV1GenerateResponse, dto);
  }

  const duplicate = answerResponse();
  duplicate.response.sources.push({
    entryId: duplicate.response.sources[0].entryId,
    topic: 'Duplicate source',
  });
  assertInvalid(parseRemoteV1GenerateResponse, duplicate);

  const five = answerResponse({
    sources: Array.from({ length: REMOTE_V1_LIMITS.sourceCount }, (_, index) => ({
      entryId: `entry-${index}`,
      topic: `Topic ${index}`,
    })),
  });
  assert.doesNotThrow(() => parseRemoteV1GenerateResponse(five));

  const six = copy(five);
  six.response.sources.push({ entryId: 'entry-over-limit', topic: 'One too many' });
  assertInvalid(parseRemoteV1GenerateResponse, six);
});

test('answers reject URLs, blank or over-limit public text, and private fields', () => {
  assertInvalid(
    parseRemoteV1GenerateResponse,
    answerResponse({ answer: 'Read https://example.com/private for the answer.' })
  );
  assertInvalid(parseRemoteV1GenerateResponse, answerResponse({ answer: 'Visit www.example.com.' }));
  assertInvalid(parseRemoteV1GenerateResponse, answerResponse({ answer: '   ' }));
  assertInvalid(
    parseRemoteV1GenerateResponse,
    answerResponse({ answer: 'x'.repeat(REMOTE_V1_LIMITS.answerCodePoints + 1) })
  );

  const badEntryId = answerResponse();
  badEntryId.response.sources[0].entryId = ' ';
  assertInvalid(parseRemoteV1GenerateResponse, badEntryId);
  const badTopic = answerResponse();
  badTopic.response.sources[0].topic = 'x'.repeat(
    REMOTE_V1_LIMITS.sourceTopicCodePoints + 1
  );
  assertInvalid(parseRemoteV1GenerateResponse, badTopic);

  assertInvalid(parseRemoteV1RetrieveRequest, {
    ...fixture.cases.success.retrieve.request,
    tenantId: PRIVATE_CANARIES[4],
  });
  const privateSource = answerResponse();
  privateSource.response.sources[0].score = 0.99;
  assertInvalid(parseRemoteV1GenerateResponse, privateSource);
  assertInvalid(
    parseRemoteV1GenerateResponse,
    answerResponse({ retrievalTrace: PRIVATE_CANARIES[2] })
  );
});

test('refusals allow only plain, scope, or technical shapes', () => {
  const valid = [
    refusalResponse(),
    refusalResponse({ scopeFallback: true }),
    refusalResponse({ failureKind: 'envelope_invalid', retryable: true }),
  ];
  for (const dto of valid) {
    assert.deepEqual(parseRemoteV1GenerateResponse(dto), dto);
  }

  const contradictory = [
    refusalResponse({ scopeFallback: true, failureKind: 'envelope_invalid', retryable: true }),
    refusalResponse({ scopeFallback: true, retryable: true }),
    refusalResponse({ failureKind: 'envelope_invalid' }),
    refusalResponse({ retryable: true }),
    refusalResponse({ scopeFallback: false }),
    refusalResponse({ failureKind: 'envelope_invalid', retryable: false }),
  ];
  for (const dto of contradictory) {
    assertInvalid(parseRemoteV1GenerateResponse, dto);
  }

  assertInvalid(
    parseRemoteV1GenerateResponse,
    answerResponse({ scopeFallback: true })
  );
  assertInvalid(
    parseRemoteV1GenerateResponse,
    answerResponse({ failureKind: 'envelope_invalid', retryable: true })
  );
});
