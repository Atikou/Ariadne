import { useSyncExternalStore } from 'react';
import { shallowSnapshotEqual } from '../snapshot-equality';

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
      const next = this.select(sourceSnapshot);
      if (!shallowSnapshotEqual(this.featureSnapshot, next)) this.featureSnapshot = next;
    }
    return this.featureSnapshot as TSnapshot;
  };

  subscribe = (listener: () => void): (() => void) => {
    let previous = this.getSnapshot();
    return this.source.subscribe(() => {
      const next = this.getSnapshot();
      if (Object.is(previous, next)) return;
      previous = next;
      listener();
    });
  };
}

export function useFeatureSnapshot<T>(store: SnapshotSource<T>): T {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
