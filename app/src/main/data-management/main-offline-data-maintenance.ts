import type { MainMaintenanceGate } from './main-maintenance-gate';
import type { RuntimeSupervisor } from '../runtime/runtime-supervisor';
import type { RuntimeMaintenanceBoundary } from '../runtime/runtime-maintenance-boundary';

export interface MainOfflineDataMaintenanceDependencies {
  gate: MainMaintenanceGate;
  runtime: Pick<RuntimeSupervisor, 'withOfflineMaintenance'>;
  prepareRendererDrafts(): Promise<void>;
  resumeRendererDrafts(): Promise<void>;
  pauseNotifications(): Promise<void>;
  resumeNotifications(): Promise<void>;
  beforeFreeze(): Promise<void>;
  stopMainRuntimeProducers(): Promise<void>;
  flushMainOwners(): Promise<void>;
}
export type OfflineDataCapture = <T>(operation: (boundary: RuntimeMaintenanceBoundary) => Promise<T>) => Promise<T>;

/** The same original-owner barrier serves snapshots and explicit cleanup.
 * Admission stays exclusive through publication/evidence handling, and even an
 * early-returning caller cannot resume owners before its capture has settled. */
export class MainOfflineDataMaintenance {
  private active = false;
  private idle: Promise<void> = Promise.resolve();
  get busy(): boolean { return this.active; }
  waitForIdle(): Promise<void> { return this.idle; }
  constructor(private readonly dependencies: MainOfflineDataMaintenanceDependencies) {}

  async withOperation<T>(operation: (capture: OfflineDataCapture) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.active) throw new Error('data_management_busy');
    this.active = true;
    let releaseIdle!: () => void;
    this.idle = new Promise(resolve => { releaseIdle = resolve; });
    let open = true, captured = false, rendererPrepared = false, notificationsPaused = false;
    let pending: Promise<unknown> | undefined;
    const source = this.dependencies;
    const capture: OfflineDataCapture = <Result>(work: (boundary: RuntimeMaintenanceBoundary) => Promise<Result>): Promise<Result> => {
      if (!open || captured) return Promise.reject(new Error('data_maintenance_capture_invalid'));
      captured = true;
      const task = (async () => {
        if (signal?.aborted) throw new Error('main_maintenance_cancelled');
        rendererPrepared = true; await source.prepareRendererDrafts();
        notificationsPaused = true; await source.pauseNotifications();
        await source.beforeFreeze();
        return source.gate.withMaintenance(async boundary => {
          await boundary.drain(signal);
          return source.runtime.withOfflineMaintenance(runtimeBoundary => boundary.capture(async () => {
            await source.stopMainRuntimeProducers(); await source.flushMainOwners();
            return work(runtimeBoundary);
          }, signal));
        });
      })();
      pending = task;
      // The owner awaits this even if its caller returns early.
      void task.catch(() => {});
      return task;
    };
    try { return await operation(capture); }
    finally {
      open = false;
      try { await pending; }
      finally {
        try { if (notificationsPaused) await source.resumeNotifications(); }
        finally {
          try { if (rendererPrepared) await source.resumeRendererDrafts(); }
          finally { this.active = false; releaseIdle(); }
        }
      }
    }
  }
}
