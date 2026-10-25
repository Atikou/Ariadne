import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MainMaintenanceGate } from '../src/main/data-management/main-maintenance-gate';
import { StateRepository } from '../src/main/persistence/state-repository';
import { TerminalSessionJournal } from '../src/main/persistence/terminal-session-journal';
import { TaskNotificationReceipts } from '../src/main/persistence/task-notification-receipts';
import { AgentPersistenceKeyRingStore } from '../src/main/persistence/agent-persistence-keyring';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) {
  if (!resolve(root).startsWith(join(resolve(tmpdir()), 'AriadneMainMaintenance-'))) throw new Error('Unsafe fixture cleanup.');
  await rm(root, { recursive: true, force: true });
} });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'AriadneMainMaintenance-')); roots.push(root); return root; }
const ref = { runId: 'run-main', workspaceId: 'workspace-main', sessionId: 'session-main', version: 8,
  state: 'completed' as const, sourceStatus: 'completed' };

describe('original Main persistence owners during maintenance', () => {
  it('captures accepted state and prevents later disk and in-memory mutations without poisoning the store', async () => {
    const root = await fixture(), gate = new MainMaintenanceGate(), path = join(root, 'state.json');
    const store = new StateRepository(path, gate); await store.initialize();
    const preferences = { ...store.getPreferences(), theme: 'dark' as const };
    const accepted = store.savePreferences(preferences);
    await gate.withMaintenance(async boundary => {
      await boundary.drain(); await accepted;
      await boundary.capture(async () => {
        const before = await readFile(path);
        await expect(store.savePreferences({ ...preferences, theme: 'light' })).rejects.toThrow('main_data_maintenance');
        expect(await readFile(path)).toEqual(before); expect(store.getPreferences()).toEqual(preferences);
      });
    });
    await store.savePreferences({ ...preferences, theme: 'light' }); expect(store.getPreferences().theme).toBe('light');
  });

  it('retains a PTY exit occurring at the boundary and commits it after the snapshot without replaying commands', async () => {
    const root = await fixture(), gate = new MainMaintenanceGate(), path = join(root, 'terminal-sessions.json');
    const store = new TerminalSessionJournal(path, undefined, gate); await store.initialize();
    const sessionId = randomUUID(); await store.start({ sessionId, workspaceId: 'workspace-main', shell: 'powershell' });
    let finish!: Promise<void>;
    await gate.withMaintenance(boundary => boundary.capture(async () => {
      const before = await readFile(path);
      finish = store.finish(sessionId, { status: 'completed', exitCode: 0 });
      await store.flush(); expect(await readFile(path)).toEqual(before); expect(store.list()[0]?.status).toBe('running');
    }));
    await finish; expect(store.list()[0]).toMatchObject({ status: 'completed', exitCode: 0 });
    const reopened = new TerminalSessionJournal(path); await reopened.initialize(); expect(reopened.list()[0]?.status).toBe('completed');
  });

  it('denies synchronous delivery mutations outside storage-error handling and resumes the same SQLite owner', async () => {
    const root = await fixture(), gate = new MainMaintenanceGate();
    const store = new TaskNotificationReceipts(join(root, 'notification-delivery.db'), undefined, gate); await store.initialize();
    try {
      store.configure({ completed: true, failed: false });
      await gate.withMaintenance(boundary => boundary.capture(async () => {
        expect(() => store.configure({ completed: false, failed: false })).toThrow('main_data_maintenance');
        expect(() => store.shown(ref)).toThrow('main_data_maintenance');
        expect(store.eligible(ref)).toBe(true);
      }));
      store.shown(ref); expect(store.eligible(ref)).toBe(false);
    } finally { store.close(); }
  });

  it('keeps the existing key ring readable for Runtime resume while refusing key rotation', async () => {
    const root = await fixture(), gate = new MainMaintenanceGate();
    // Cipher fixture verifies admission only, not Windows secure-storage recovery.
    const cipher = { encrypt: (value: string) => Buffer.from(value).toString('base64'),
      decrypt: (value: string) => Buffer.from(value, 'base64').toString('utf8') };
    const store = new AgentPersistenceKeyRingStore(join(root, 'agent-persistence-keyring.json'), cipher, undefined, undefined, undefined, gate);
    await store.initialize(); const previous = await store.loadForRuntime();
    await gate.withMaintenance(boundary => boundary.capture(async () => {
      await expect(store.rotate()).rejects.toThrow('main_data_maintenance');
      expect(await store.loadForRuntime()).toEqual(previous);
    }));
    await store.rotate(); expect((await store.loadForRuntime()).generation).toBe(previous.generation + 1);
  });
});
