import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DataAttachmentCleanupService } from '../src/main/data-management/data-attachment-cleanup-service';
import { MainOfflineDataMaintenance } from '../src/main/data-management/main-offline-data-maintenance';
import { MainMaintenanceGate } from '../src/main/data-management/main-maintenance-gate';

const workers = vi.hoisted(() => ({ inspect: vi.fn(), execute: vi.fn() }));
vi.mock('../src/main/runtime/runtime-storage-maintenance-worker', () => ({
  inspectRuntimeAttachmentCleanupWithWorker: workers.inspect, executeRuntimeAttachmentCleanupWithWorker: workers.execute
}));
const services: DataAttachmentCleanupService[] = [];
const metadata = { maintenance: 'attachment-cleanup-preview', version: 'a'.repeat(64), referencedObjects: 2,
  orphanObjects: 1, orphanBytes: 80, unpublishedObjects: 1, unpublishedBytes: 7 };
const settlement = { maintenance: 'attachment-cleanup-result', operationId: '22222222-2222-4222-8222-222222222222',
  status: 'completed', filesDeleted: 1, bytesDeleted: 80, filesRetained: 0, auditRecorded: true };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime('2032-01-01T00:00:00.000Z');
  workers.inspect.mockReset().mockResolvedValue(metadata); workers.execute.mockReset().mockResolvedValue(settlement); });
afterEach(() => { for (const service of services.splice(0)) service.disposePreview(); vi.useRealTimers(); });
function fixture() {
  const gate = new MainMaintenanceGate(), trace: string[] = [];
  // Explicit lifecycle fixtures; original seven-owner worker acceptance is in
  // runtime-supervisor.test.ts and is not inferred from these mocked responses.
  const maintenance = new MainOfflineDataMaintenance({ gate,
    runtime: { withOfflineMaintenance: async operation => operation({ runtimeInstanceId: '11111111-1111-4111-8111-111111111111',
      storageSchemas: {}, quiescedAt: new Date().toISOString(), shutdownAcknowledged: true }) },
    prepareRendererDrafts: async () => { trace.push('prepared'); }, resumeRendererDrafts: async () => { trace.push('resumed'); },
    pauseNotifications: async () => {}, resumeNotifications: async () => {}, beforeFreeze: async () => {},
    stopMainRuntimeProducers: async () => {}, flushMainOwners: async () => {} });
  const keyId = 'agent-key-33333333-3333-4333-8333-333333333333', keys = { schemaVersion: 1 as const, generation: 1,
    activeKeyId: keyId, keys: [{ keyId, keyMaterialBase64: Buffer.alloc(32, 1).toString('base64') }] };
  const worker = { entry: 'C:\\Ariadne\\worker.js', executablePath: 'C:\\Ariadne\\node.exe', dataRoot: 'C:\\Ariadne\\runtime' };
  const service = new DataAttachmentCleanupService({ maintenance, worker, loadKeys: async () => keys }); services.push(service);
  return { service, maintenance, gate, trace, worker, keys };
}
it('retains one metadata preview and passes only its exact version and selected category to the private worker', async () => {
  const f = fixture(), preview = await f.service.inspect();
  expect(preview).toMatchObject({ version: metadata.version, orphanObjects: 1 }); expect('maintenance' in preview).toBe(false);
  await expect(f.service.inspect()).rejects.toThrow('data_cleanup_preview_exists');
  expect(workers.inspect).toHaveBeenCalledTimes(1);
  const result = await f.service.commit({ ticket: preview.ticket, version: preview.version, selected: ['orphan-attachment'] });
  expect(workers.execute).toHaveBeenCalledWith(f.worker, f.keys, preview.version, ['orphan-attachment']);
  expect(result).toMatchObject({ status: 'completed', filesDeleted: 1 }); expect('maintenance' in result).toBe(false);
  await expect(f.service.commit({ ticket: preview.ticket, version: preview.version, selected: ['orphan-attachment'] })).rejects.toThrow('data_cleanup_preview_missing');
  expect(f.trace).toEqual(['prepared', 'resumed', 'prepared', 'resumed']); expect(f.maintenance.busy).toBe(false);
});
it('rejects foreign tickets and versions without consuming the retained authorized preview', async () => {
  const f = fixture(), preview = await f.service.inspect();
  await expect(f.service.commit({ ticket: '44444444-4444-4444-8444-444444444444', version: preview.version, selected: ['orphan-attachment'] })).rejects.toThrow('data_cleanup_preview_missing');
  await expect(f.service.commit({ ticket: preview.ticket, version: 'b'.repeat(64), selected: ['orphan-attachment'] })).rejects.toThrow('data_cleanup_preview_changed');
  expect(workers.execute).not.toHaveBeenCalled(); f.service.discard(preview.ticket);
  await expect(f.service.inspect()).resolves.toMatchObject({ version: metadata.version });
});
it('consumes a failed commit and resumes original admission without retrying the deletion automatically', async () => {
  const f = fixture(), preview = await f.service.inspect(); workers.execute.mockRejectedValueOnce(new Error('attachment_cleanup_preview_changed'));
  const request = { ticket: preview.ticket, version: preview.version, selected: ['unpublished-attachment' as const] };
  await expect(f.service.commit(request)).rejects.toThrow('attachment_cleanup_preview_changed');
  await expect(f.service.commit(request)).rejects.toThrow('data_cleanup_preview_missing');
  expect(workers.execute).toHaveBeenCalledTimes(1); f.gate.writeSync(() => {});
  expect(f.trace.at(-1)).toBe('resumed'); await expect(f.service.inspect()).resolves.toMatchObject({ version: metadata.version });
});
it('preserves a real interrupted settlement and its operation identity without reporting completion', async () => {
  const f = fixture(), preview = await f.service.inspect(); workers.execute.mockResolvedValueOnce({ ...settlement, status: 'interrupted', filesRetained: 1 });
  await expect(f.service.commit({ ticket: preview.ticket, version: preview.version, selected: ['orphan-attachment', 'unpublished-attachment'] }))
    .resolves.toMatchObject({ operationId: settlement.operationId, status: 'interrupted', filesRetained: 1, auditRecorded: true });
  expect(workers.execute).toHaveBeenCalledTimes(1);
});
it('rejects an expired commit before freezing owners or invoking deletion and permits a fresh preview', async () => {
  const f = fixture(), preview = await f.service.inspect(); vi.setSystemTime('2032-01-01T00:16:00.000Z');
  await expect(f.service.commit({ ticket: preview.ticket, version: preview.version, selected: ['orphan-attachment'] })).rejects.toThrow('data_cleanup_preview_expired');
  expect(workers.execute).not.toHaveBeenCalled(); expect(f.trace).toEqual(['prepared', 'resumed']);
  await expect(f.service.inspect()).resolves.toMatchObject({ version: metadata.version });
});
it('expires abandoned metadata tickets without filesystem work or an automatic cleanup', async () => {
  const f = fixture(), preview = await f.service.inspect(); await vi.advanceTimersByTimeAsync(15 * 60_000);
  expect(() => f.service.discard(preview.ticket)).toThrow('data_cleanup_preview_missing');
  expect(workers.execute).not.toHaveBeenCalled(); expect(f.trace).toEqual(['prepared', 'resumed']);
  await expect(f.service.inspect()).resolves.toMatchObject({ version: metadata.version });
});
