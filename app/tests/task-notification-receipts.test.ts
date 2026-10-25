import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskNotificationReceipts } from '../src/main/persistence/task-notification-receipts';

const directories: string[] = [];
const reference = (runId = 'run-a') => ({ runId, workspaceId: 'workspace-a', sessionId: 'session-a', version: 8,
  state: 'completed' as const, sourceStatus: 'completed' });
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() { const directory = await mkdtemp(join(tmpdir(), 'Ariadne-task-receipts-')); directories.push(directory); return join(directory, 'notifications.db'); }

describe('Main-owned native task display bookkeeping', () => {
  it('retains enabling boundaries across restart and re-enables without historical replay', async () => {
    const path = await fixture(); let clock = Date.parse('2026-10-06T00:00:00Z');
    let store = new TaskNotificationReceipts(path, () => clock); await store.initialize();
    expect(store.configure({ completed: false, failed: false })).toEqual({});
    expect(store.configure({ completed: true, failed: false })).toEqual({ completed: '2026-10-06T00:00:00.000Z' });
    store.close(); clock += 60_000; store = new TaskNotificationReceipts(path, () => clock); await store.initialize();
    expect(store.configure({ completed: true, failed: false }).completed).toBe('2026-10-06T00:00:00.000Z');
    store.configure({ completed: false, failed: false }); clock += 60_000;
    expect(store.configure({ completed: true, failed: true })).toEqual({ completed: '2026-10-06T00:02:00.000Z', failed: '2026-10-06T00:02:00.000Z' });
    store.close();
  });
  it('records only observed delivery; unknown attempts retry, failures back off and shown history never expires', async () => {
    const path = await fixture(); let clock = 1_000_000;
    let store = new TaskNotificationReceipts(path, () => clock); await store.initialize();
    store.requested(reference()); expect(store.eligible(reference())).toBe(false);
    clock += 30_000; expect(store.eligible(reference())).toBe(true);
    store.failed(reference()); clock += 59_999; expect(store.eligible(reference())).toBe(false);
    clock++; expect(store.eligible(reference())).toBe(true); store.shown(reference()); store.close();
    clock += 365 * 86400_000; store = new TaskNotificationReceipts(path, () => clock); await store.initialize();
    expect(store.eligible(reference())).toBe(false);
    expect(store.eligible({ ...reference(), version: 9 })).toBe(true); store.close();
  });
  it('indexes more than the old receipt ceiling without evicting early delivered runs', async () => {
    const path = await fixture(); const store = new TaskNotificationReceipts(path); await store.initialize();
    for (let index = 0; index < 2100; index++) store.shown(reference(`run-${index}`));
    store.close(); const reopened = new TaskNotificationReceipts(path); await reopened.initialize();
    expect(reopened.eligible(reference('run-0'))).toBe(false); expect(reopened.eligible(reference('run-2099'))).toBe(false);
    reopened.close();
  }, 15_000); // 2,100 separately durable disk commits also run under full-suite I/O contention.
  it('preserves unknown schemas byte for byte and fails closed for task reminders', async () => {
    const path = await fixture(); const database = new DatabaseSync(path);
    database.exec("CREATE TABLE private_owner (content TEXT); INSERT INTO private_owner VALUES ('retained'); PRAGMA user_version=9"); database.close();
    const before = await readFile(path); const store = new TaskNotificationReceipts(path); await store.initialize();
    expect(store.configure({ completed: true, failed: true })).toEqual({}); expect(store.eligible(reference())).toBe(false);
    store.shown(reference()); store.close(); expect(await readFile(path)).toEqual(before);
  });
});
