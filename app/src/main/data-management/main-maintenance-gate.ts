import { AsyncLocalStorage } from 'node:async_hooks';

export interface MainWriteAdmission {
  write<T>(operation: () => T | PromiseLike<T>): Promise<T>;
  writeDeferred<T>(operation: () => T | PromiseLike<T>): Promise<T>;
}
export interface MainPersistenceAdmission extends MainWriteAdmission {
  writeSync<T>(operation: () => T): T;
}
/** Owners can run independently in tests and isolated validation. Production
 * supplies the Application's shared gate to every Main persistence owner. */
export const unrestrictedMainWrites: MainPersistenceAdmission = Object.freeze({
  write: async <T>(operation: () => T | PromiseLike<T>): Promise<T> => operation(),
  writeDeferred: async <T>(operation: () => T | PromiseLike<T>): Promise<T> => operation(),
  writeSync: <T>(operation: () => T): T => operation()
});
export interface MainMaintenanceCapture {
  drain(signal?: AbortSignal): Promise<void>;
  capture<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}
interface WriteTicket { readonly gate: MainMaintenanceGate; active: boolean }

/** Main persistence admission, not business state. An already admitted async
 * operation may finish its nested writes while draining; a later callback using
 * an expired ticket cannot bypass the freeze. Main must stop background producers
 * and the Runtime before invoking the capture supplied to its coordinator. */
export class MainMaintenanceGate implements MainPersistenceAdmission {
  private readonly context = new AsyncLocalStorage<WriteTicket>();
  private phase: 'idle' | 'draining' | 'frozen' | 'shutting-down' | 'closed' = 'idle';
  private writes = 0;
  private readonly drained = new Set<() => void>();
  private readonly reopened = new Set<() => void>();
  get busy(): boolean { return this.phase !== 'idle'; }

  async write<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    this.assertAdmission();
    return this.acceptedWrite(operation);
  }

  private async acceptedWrite<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    this.writes++;
    const ticket: WriteTicket = { gate: this, active: true };
    try { return await this.context.run(ticket, operation); }
    finally {
      ticket.active = false; this.writes--;
      if (this.writes === 0) for (const resolve of [...this.drained]) resolve();
    }
  }

  writeSync<T>(operation: () => T): T {
    this.assertAdmission();
    const ticket: WriteTicket = { gate: this, active: true };
    try { return this.context.run(ticket, operation); }
    finally { ticket.active = false; }
  }

  /** Background facts such as an already running PTY's exit must survive a
   * snapshot, but cannot alter its boundary. They commit after admission reopens. */
  async writeDeferred<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    while (this.busy) {
      if (this.phase === 'closed') throw new Error('main_data_owners_closed');
      // Only original background-fact owners use this entry. A PTY exit or
      // final window fact must finish while its producer is being disposed.
      if (this.phase === 'shutting-down') return this.acceptedWrite(operation);
      const parent = this.context.getStore();
      if (this.phase === 'draining' && parent?.gate === this && parent.active) break;
      await new Promise<void>(resolve => this.reopened.add(resolve));
    }
    return this.write(operation);
  }

  private assertAdmission(): void {
    const parent = this.context.getStore();
    if (this.phase !== 'idle' && !((this.phase === 'draining' || this.phase === 'shutting-down') && parent?.gate === this && parent.active))
      throw new Error('main_data_maintenance');
  }

  async withMaintenance<T>(coordinate: (boundary: MainMaintenanceCapture) => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('main_data_maintenance');
    const parent = this.context.getStore();
    if (parent?.gate === this && parent.active) throw new Error('main_maintenance_from_active_writer');
    this.phase = 'draining';
    let captured = false;
    let active = true;
    let capturePromise: Promise<unknown> | undefined;
    const boundary: MainMaintenanceCapture = Object.freeze({
      drain: async (signal?: AbortSignal): Promise<void> => {
        if (!active || captured || this.phase !== 'draining') throw new Error('main_maintenance_capture_invalid');
        await this.awaitWriters(signal);
        if (!active || captured || this.phase !== 'draining') throw new Error('main_maintenance_capture_invalid');
      },
      capture: <Result>(operation: () => Promise<Result>, signal?: AbortSignal): Promise<Result> => {
        if (!active || captured || this.phase !== 'draining') return Promise.reject(new Error('main_maintenance_capture_invalid'));
        captured = true;
        const pending = (async () => {
          await this.awaitWriters(signal);
          if (signal?.aborted) throw new Error('main_maintenance_cancelled');
          this.phase = 'frozen';
          return operation();
        })();
        capturePromise = pending;
        // Keep ownership until the operation settles even when a coordinator
        // accidentally neglects to await the capability it invoked.
        void pending.catch(() => undefined);
        return pending;
      }
    });
    try {
      const result = await coordinate(boundary);
      active = false;
      await capturePromise;
      return result;
    } finally {
      active = false;
      try { await capturePromise; }
      finally {
        this.phase = 'idle';
        for (const resolve of this.reopened) resolve();
        this.reopened.clear();
      }
    }
  }

  /** Renderer draft barriers must finish before this boundary. Reject new IPC
   * writes, drain accepted work, then let the original disposal/flush path and
   * its background facts settle. Success permanently closes admission. */
  async withOwnerShutdown<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy || this.context.getStore()?.active) throw new Error('main_data_maintenance');
    this.phase = 'draining';
    const ticket: WriteTicket = { gate: this, active: true };
    let completed = false;
    try {
      await this.awaitWriters();
      this.phase = 'shutting-down';
      for (const resolve of this.reopened) resolve(); this.reopened.clear();
      const result = await this.context.run(ticket, operation);
      ticket.active = false;
      await this.awaitWriters(); completed = true;
      return result;
    } finally {
      ticket.active = false;
      await this.awaitWriters();
      this.phase = completed ? 'closed' : 'idle';
      for (const resolve of this.reopened) resolve(); this.reopened.clear();
    }
  }

  private awaitWriters(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error('main_maintenance_cancelled'));
    if (this.writes === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = (): void => { this.drained.delete(done); signal?.removeEventListener('abort', cancel); };
      const done = (): void => { cleanup(); resolve(); };
      const cancel = (): void => { cleanup(); reject(new Error('main_maintenance_cancelled')); };
      this.drained.add(done); signal?.addEventListener('abort', cancel, { once: true });
    });
  }
}
