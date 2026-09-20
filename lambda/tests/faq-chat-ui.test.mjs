import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const appSource = fs.readFileSync(new URL('../../faq/app.js', import.meta.url), 'utf8');

function submitRequest(config = {}, { complete = false } = {}) {
  function element() {
    return {
      style: {},
      listeners: {},
      value: '',
      offsetHeight: 20,
      clientHeight: 20,
      scrollHeight: 20,
      addEventListener(name, listener) { this.listeners[name] = listener; },
      setAttribute() {},
      appendChild(child) { child.parentNode = this; },
      removeChild(child) { child.parentNode = null; },
      focus() {},
    };
  }
  const elements = new Map();
  const timers = [];
  const clearedTimers = [];
  const requests = [];
  const context = {
    window: {
      FAQ_CONFIG: { apiBaseUrl: 'https://faq.example.test', ...config },
      addEventListener() {},
    },
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      },
      createElement: element,
    },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    AbortController,
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimeout(id) { clearedTimers.push(id); },
    fetch(url, options) {
      requests.push({ url, ...options });
      return complete
        ? Promise.resolve({ status: 200, json: () => Promise.resolve({ answer: 'Answer' }) })
        : new Promise(() => {});
    },
  };
  vm.runInNewContext(appSource, context, { filename: 'faq/app.js' });
  elements.get('input').value = 'Question';
  elements.get('chat-form').listeners.submit({ preventDefault() {} });
  return { timers, requests, clearedTimers, elements };
}

test('FAQ config ships the existing request timeout default', () => {
  const context = { window: {} };
  vm.runInNewContext(
    fs.readFileSync(new URL('../../faq/config.js', import.meta.url), 'utf8'),
    context
  );
  assert.equal(context.window.FAQ_CONFIG.requestTimeoutMs, 40000);
});

for (const requestTimeoutMs of [1, 40000, 60000, 2147483647]) {
  test(`FAQ UI uses configured request timeout ${requestTimeoutMs} and aborts its request`, () => {
    const { timers, requests } = submitRequest({ requestTimeoutMs });
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, requestTimeoutMs);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://faq.example.test/faq-chat');
    assert.equal(requests[0].signal.aborted, false);
    timers[0].callback();
    assert.equal(requests[0].signal.aborted, true);
  });
}

for (const [label, requestTimeoutMs] of [
  ['unset', undefined],
  ['null', null],
  ['zero', 0],
  ['negative', -1],
  ['fraction', 1.5],
  ['numeric string', '60000'],
  ['empty string', ''],
  ['boolean', true],
  ['array', [60000]],
  ['object', {}],
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['timer overflow', 2147483648],
]) {
  test(`FAQ UI falls back to 40000 ms for ${label}`, () => {
    const { timers } = submitRequest({ requestTimeoutMs });
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 40000);
  });
}

test('FAQ UI clears the configured timeout when the request completes', async () => {
  const { timers, clearedTimers, elements } = submitRequest(
    { requestTimeoutMs: 60000 },
    { complete: true }
  );
  await new Promise(setImmediate);
  assert.equal(timers[0].delay, 60000);
  assert.deepEqual(clearedTimers, [1]);
  assert.equal(elements.get('send-btn').disabled, false);
});
