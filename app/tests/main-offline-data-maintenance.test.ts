import { expect, it } from 'vitest';
import { MainOfflineDataMaintenance } from '../src/main/data-management/main-offline-data-maintenance';
import { MainMaintenanceGate } from '../src/main/data-management/main-maintenance-gate';
import type { RuntimeMaintenanceBoundary } from '../src/main/runtime/runtime-maintenance-boundary';

const boundary: RuntimeMaintenanceBoundary = { runtimeInstanceId: '11111111-1111-4111-8111-111111111111',
  storageSchemas: {}, quiescedAt: '2032-01-01T00:00:00.000Z', shutdownAcknowledged: true };
function fixture(failure?: string) {
  const gate = new MainMaintenanceGate(), trace: string[] = [];
  const hook = async (name: string) => { trace.push(name); if (name === failure) throw new Error('Synthetic ' + name); };
  const maintenance = new MainOfflineDataMaintenance({ gate,
    runtime: { withOfflineMaintenance: async operation => {
      await hook('runtime-stopped'); try { return await operation(boundary); } finally { trace.push('runtime-resumed'); }
    } }, prepareRendererDrafts: () => hook('renderer-prepared'), resumeRendererDrafts: () => hook('renderer-resumed'),
    pauseNotifications: () => hook('notifications-paused'), resumeNotifications: () => hook('notifications-resumed'),
    beforeFreeze: () => hook('window-flushed'), stopMainRuntimeProducers: () => hook('producers-stopped'), flushMainOwners: () => hook('owners-flushed') });
  return { gate, trace, maintenance };
}
it('uses the original write gate, rejects concurrent maintenance and resumes after post-capture publishing', async () => {
  const f = fixture();
  await f.maintenance.withOperation(async capture => {
    await expect(f.maintenance.withOperation(async () => {})).rejects.toThrow('data_management_busy');
    await capture(async proof => {
      expect(proof.shutdownAcknowledged).toBe(true);
      expect(() => f.gate.writeSync(() => {})).toThrow('main_data_maintenance'); f.trace.push('captured');
    });
    f.gate.writeSync(() => f.trace.push('published-after-runtime-resume'));
    expect(f.maintenance.busy).toBe(true);
  });
  expect(f.trace).toEqual(['renderer-prepared', 'notifications-paused', 'window-flushed', 'runtime-stopped',
    'producers-stopped', 'owners-flushed', 'captured', 'runtime-resumed', 'published-after-runtime-resume', 'notifications-resumed', 'renderer-resumed']);
  expect(f.maintenance.busy).toBe(false); expect(f.gate.busy).toBe(false);
});
it.each(['renderer-prepared', 'notifications-paused', 'owners-flushed'])('resumes every partially prepared owner after failure at %s', async failure => {
  const f = fixture(failure);
  await expect(f.maintenance.withOperation(capture => capture(async () => {}))).rejects.toThrow('Synthetic ' + failure);
  expect(f.trace.at(-1)).toBe('renderer-resumed');
  if (failure !== 'renderer-prepared') expect(f.trace).toContain('notifications-resumed');
  if (failure === 'owners-flushed') expect(f.trace).toContain('runtime-resumed');
  f.gate.writeSync(() => {}); expect(f.maintenance.busy).toBe(false);
});
it('waits for an early-returned capture before owner resumption and rejects a retained callback', async () => {
  const f = fixture(); let release!: () => void, captured!: () => void;
  const started = new Promise<void>(resolve => { captured = resolve; }), pending = new Promise<void>(resolve => { release = resolve; });
  let retained: Parameters<MainOfflineDataMaintenance['withOperation']>[0] extends (capture: infer C) => unknown ? C : never;
  const result = f.maintenance.withOperation(async capture => {
    retained = capture; void capture(async () => { captured(); await pending; }); return 'caller-returned';
  });
  await started; expect(f.maintenance.busy).toBe(true); expect(f.trace).not.toContain('runtime-resumed');
  let idle = false; void f.maintenance.waitForIdle().then(() => { idle = true; });
  await Promise.resolve(); expect(idle).toBe(false); release(); expect(await result).toBe('caller-returned');
  expect(f.trace.slice(-3)).toEqual(['runtime-resumed', 'notifications-resumed', 'renderer-resumed']);
  await expect(retained!(async () => {})).rejects.toThrow('data_maintenance_capture_invalid');
});
