import type { RuntimeStatus, TraceEntry } from '@ariadne/protocol/public';
import type { SnapshotSource } from './feature-snapshot-store';

export interface DiagnosticsFeatureSnapshot {
  readonly initialized: boolean;
  readonly status: RuntimeStatus;
  readonly projectionStreamId: string | null;
  readonly projectionCursor: number;
  readonly projectionIntegrityError: string | null;
  readonly trace: readonly TraceEntry[];
  readonly lastError: string | null;
}

export class DiagnosticsFeatureStore {
  constructor(
    readonly view: SnapshotSource<DiagnosticsFeatureSnapshot>,
    private readonly refreshRuntime: () => Promise<void>
  ) {}

  refresh(): Promise<void> {
    return this.refreshRuntime();
  }
}
