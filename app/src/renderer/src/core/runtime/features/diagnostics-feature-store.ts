import type { RuntimeStatus, TraceEntry } from '@ariadne/protocol/public';
import type { AriadneApi } from '@shared/contract';
import type { SnapshotSource } from './feature-snapshot-store';
import { RuntimeHealthReader, type RuntimeHealthReadSnapshot } from '../runtime-health-reader';

export interface DiagnosticsFeatureSnapshot {
  readonly initialized: boolean;
  readonly status: RuntimeStatus;
  readonly projectionStreamId: string | null;
  readonly projectionCursor: number;
  readonly projectionIntegrityError: string | null;
  readonly trace: readonly TraceEntry[];
  readonly lastError: string | null;
  readonly domainHealth: RuntimeHealthReadSnapshot;
}

export class DiagnosticsFeatureStore {
  public readonly view: SnapshotSource<DiagnosticsFeatureSnapshot>;
  private readonly health: RuntimeHealthReader;
  constructor(
    base: SnapshotSource<Omit<DiagnosticsFeatureSnapshot, 'domainHealth'>>,
    private readonly refreshRuntime: () => Promise<void>,
    request: AriadneApi['runtime']['request']
  ) {
    this.health = new RuntimeHealthReader(request);
    let previousBase: ReturnType<typeof base.getSnapshot> | undefined;
    let previousHealth: RuntimeHealthReadSnapshot | undefined;
    let snapshot: DiagnosticsFeatureSnapshot;
    const getSnapshot = (): DiagnosticsFeatureSnapshot => {
      const value = base.getSnapshot(), health = this.health.getSnapshot();
      if (value !== previousBase || health !== previousHealth) {
        previousBase = value; previousHealth = health; snapshot = { ...value, domainHealth: health };
      }
      return snapshot;
    };
    this.view = { getSnapshot, subscribe: listener => {
      const removeBase = base.subscribe(listener), removeHealth = this.health.subscribe(listener);
      return () => { removeBase(); removeHealth(); };
    } };
  }

  acceptStatus(status: RuntimeStatus): void { this.health.acceptStatus(status); }
  dispose(): void { this.health.dispose(); }

  refresh(): Promise<void> {
    return Promise.all([this.refreshRuntime(), this.health.refresh()]).then(() => undefined);
  }
}
