import { describe, expect, it } from 'vitest';
import { FeatureSnapshotStore } from '../src/renderer/src/core/runtime/features/feature-snapshot-store';

describe('FeatureSnapshotStore', () => {
  it('keeps feature snapshot identity stable until the authoritative source changes', () => {
    let source = { revision: 1, sessions: ['session-a'], runs: ['run-a'] };
    const listeners = new Set<() => void>();
    const store = new FeatureSnapshotStore(
      {
        getSnapshot: () => source,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }
      },
      (snapshot) => ({ revision: snapshot.revision, sessions: snapshot.sessions })
    );

    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first);

    source = { revision: 2, sessions: ['session-b'], runs: ['run-b'] };
    for (const listener of listeners) listener();
    const second = store.getSnapshot();
    expect(second).not.toBe(first);
    expect(second).toEqual({ revision: 2, sessions: ['session-b'] });
    expect(store.getSnapshot()).toBe(second);
  });
});
