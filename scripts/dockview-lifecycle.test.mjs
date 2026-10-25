import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { onDidWindowResizeEnd } = require('../node_modules/dockview-core/dist/cjs/dom.js');

test('closing a resized window cancels its pending callback and listener', async () => {
  const window = new EventTarget();
  let calls = 0;
  const owner = onDidWindowResizeEnd(window, () => { calls++; });
  window.dispatchEvent(new Event('resize'));
  owner.dispose();
  owner.dispose();
  window.dispatchEvent(new Event('resize'));
  await delay(150);
  assert.equal(calls, 0);
});

test('a live window still receives one settled resize callback', async () => {
  const window = new EventTarget();
  let calls = 0;
  const owner = onDidWindowResizeEnd(window, () => { calls++; });
  try {
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('resize'));
    await delay(150);
    assert.equal(calls, 1);
    window.dispatchEvent(new Event('resize'));
  } finally {
    owner.dispose();
  }
  await delay(150);
  assert.equal(calls, 1);
});
