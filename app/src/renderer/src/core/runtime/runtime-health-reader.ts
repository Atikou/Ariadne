import { runtimeHealthSchema, type RuntimeHealth, type RuntimeStatus } from '@ariadne/protocol/public';
import type { AriadneApi } from '@shared/contract';
import { unwrapPublicResult } from './public-result';

export interface RuntimeHealthReadSnapshot {
  readonly state: 'unknown' | 'ready' | 'error';
  readonly health: RuntimeHealth | null;
  readonly errorCode: 'runtime_health_unavailable' | 'invalid_health_response' | null;
}
const UNKNOWN: RuntimeHealthReadSnapshot = Object.freeze({ state: 'unknown', health: null, errorCode: null });

/** Independent of Projection polling and its failure latch. One physical read
 * remains reserved across Runtime transitions; old responses cannot replace
 * the current generation or resurrect health after dispose. */
export class RuntimeHealthReader {
  private snapshot = UNKNOWN;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private enabled = false;
  private availability: RuntimeStatus['availability'] | null = null;
  private disposed = false;
  private pending: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  public constructor(private readonly request: AriadneApi['runtime']['request'], private readonly intervalMs = 2_000) {}
  public getSnapshot = (): RuntimeHealthReadSnapshot => this.snapshot;
  public subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  };

  public acceptStatus(status: RuntimeStatus): void {
    if (this.disposed) return;
    const enabled = ['ready', 'crashed', 'disabled'].includes(status.availability);
    if (status.availability === this.availability) return;
    this.availability = status.availability;
    this.enabled = enabled; this.generation++; this.stopTimer(); this.publish(UNKNOWN);
    if (enabled) void this.refresh();
  }
  public dispose(): void {
    this.disposed = true;
    this.enabled = false; this.generation++; this.stopTimer(); this.publish(UNKNOWN);
  }
  public refresh(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (this.pending !== null) return this.pending;
    this.stopTimer(); const generation = this.generation;
    const task = Promise.resolve().then(async () => {
      let invalid = false;
      try {
        const result = unwrapPublicResult(await this.request({ kind: 'runtime.health.get' }));
        invalid = true;
        if (result.kind !== 'runtime.health') throw new Error('invalid_health_response');
        const health = runtimeHealthSchema.parse(result.health);
        if (generation === this.generation && this.enabled) this.publish({ state: 'ready', health, errorCode: null });
      } catch {
        if (generation === this.generation && this.enabled) this.publish({ state: 'error', health: null,
          errorCode: invalid ? 'invalid_health_response' : 'runtime_health_unavailable' });
      }
    }).finally(() => {
      if (this.pending === task) this.pending = null;
      if (this.enabled) this.schedule(generation === this.generation ? this.intervalMs : 0);
    });
    this.pending = task; return task;
  }
  private schedule(delayMs: number): void {
    this.stopTimer();
    this.timer = setTimeout(() => { this.timer = null; void this.refresh(); }, delayMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }
  private stopTimer(): void { if (this.timer !== null) clearTimeout(this.timer); this.timer = null; }
  private publish(snapshot: RuntimeHealthReadSnapshot): void {
    if (snapshot === this.snapshot) return;
    this.snapshot = Object.freeze(snapshot); for (const listener of this.listeners) listener();
  }
}
