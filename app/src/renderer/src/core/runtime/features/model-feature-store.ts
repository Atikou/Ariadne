import type { ModelSummary } from '@ariadne/protocol/public';
import type { SnapshotSource } from './feature-snapshot-store';

export interface ModelFeatureSnapshot {
  readonly models: readonly ModelSummary[];
}

export class ModelFeatureStore {
  constructor(readonly view: SnapshotSource<ModelFeatureSnapshot>) {}
}
