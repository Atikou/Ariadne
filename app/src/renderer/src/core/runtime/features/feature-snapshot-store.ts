import { useSyncExternalStore } from 'react';

export interface SnapshotSource<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

export class FeatureSnapshotStore<TSource, TSnapshot> {
  private sourceSnapshot: TSource | undefined;
  private featureSnapshot: TSnapshot | undefined;

  constructor(
    private readonly source: SnapshotSource<TSource>,
    private readonly select: (source: TSource) => TSnapshot
  ) {}

  getSnapshot = (): TSnapshot => {
    const sourceSnapshot = this.source.getSnapshot();
    if (sourceSnapshot !== this.sourceSnapshot || this.featureSnapshot === undefined) {
      this.sourceSnapshot = sourceSnapshot;
      this.featureSnapshot = this.select(sourceSnapshot);
    }
    return this.featureSnapshot;
  };

  subscribe = (listener: () => void): (() => void) => this.source.subscribe(listener);
}

export function useFeatureSnapshot<T>(store: SnapshotSource<T>): T {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
