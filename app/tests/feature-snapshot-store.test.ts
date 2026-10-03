import { describe, expect, it } from 'vitest';
import { FeatureSnapshotStore } from '../src/renderer/src/core/runtime/features/feature-snapshot-store';

describe('FeatureSnapshotStore', () => {
  it('isolates unrelated updates for every subscriber and preserves selected references', () => {
    let source = { sessions: ['a'], token: '' };
    const listeners = new Set<() => void>();
    const store = new FeatureSnapshotStore({ getSnapshot: () => source,
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }
    }, snapshot => ({ sessions: snapshot.sessions }));
    const first = store.getSnapshot();
    const counts = [0, 0];
    const unsubscribe = counts.map((_, index) => store.subscribe(() => { counts[index]! += 1; }));
    for (let token = 0; token < 100; token++) {
      source = { ...source, token: String(token) };
      for (const listener of listeners) listener();
    }
    expect(store.getSnapshot()).toBe(first);
    expect(counts).toEqual([0, 0]);
    source = { ...source, sessions: ['b'] };
    for (const listener of listeners) listener();
    expect(counts).toEqual([1, 1]);
    unsubscribe.forEach(remove => remove());
    expect(listeners.size).toBe(0);
  });
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
