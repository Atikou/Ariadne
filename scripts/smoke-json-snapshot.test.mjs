import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSmokeJsonSnapshotWriter } from './smoke-json-snapshot.mjs';

test('readers keep complete old JSON during denied replacement, then observe the latest coalesced snapshot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ariadne-smoke-snapshot-')), target = join(root, 'state.json');
  try {
    writeFileSync(target, JSON.stringify({ cursor: 0, text: 'old' })); let attempts = 0, ready;
    const blocked = new Promise(resolve => { ready = resolve; });
    const writer = createSmokeJsonSnapshotWriter(target, { retryMs: 1, replace: (temporary, destination) => {
      attempts++; assert.deepEqual(JSON.parse(readFileSync(destination, 'utf8')), { cursor: 0, text: 'old' });
      if (attempts === 1) { ready(); throw Object.assign(new Error('reader-holds-destination'), { code: 'EPERM' }); }
      renameSync(temporary, destination);
    } });
    const first = writer.write({ cursor: 1, text: 'first' }); await blocked;
    const latest = writer.write({ cursor: 2, text: '🙂'.repeat(100_000) }); assert.equal(latest, first);
    await latest; assert.equal(attempts, 2);
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { cursor: 2, text: '🙂'.repeat(100_000) });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('permanent and bounded sharing failures preserve the previous complete snapshot and reject', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ariadne-smoke-snapshot-')), target = join(root, 'state.json');
  try {
    writeFileSync(target, '{"cursor":0}');
    for (const code of ['EIO', 'EPERM']) {
      const writer = createSmokeJsonSnapshotWriter(target, { retryMs: 1, timeoutMs: 5,
        replace: () => { throw Object.assign(new Error(code), { code }); } });
      await assert.rejects(writer.write({ cursor: 1 }), error => error.code === code);
      assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { cursor: 0 });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('a write admitted while a successful async flush settles is delivered before the shared result resolves', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ariadne-smoke-snapshot-')), target = join(root, 'state.json');
  try {
    const writer = createSmokeJsonSnapshotWriter(target), first = writer.write({ cursor: 1 });
    await Promise.resolve(); const last = writer.write({ cursor: 2 }); assert.equal(last, first);
    await last; assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { cursor: 2 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
