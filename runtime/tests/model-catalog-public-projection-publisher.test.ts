import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  SqlitePublicProjectionStore,
  type PublicProjectionPersistenceFaultInjector
} from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import type {
  ModelCatalogProjectionEntry,
  ModelCatalogProjectionSource
} from '../src/projection/ModelCatalogProjectionPorts.js';
import {
  ModelCatalogPublicProjectionPublisher
} from '../src/projection/ModelCatalogPublicProjectionPublisher.js';

const roots = new Set<string>();
const stores = new Set<SqlitePublicProjectionStore>();

afterEach(async () => {
  await Promise.all([...stores].map(async (store) => {
    try { await store.close(); } catch { /* best-effort cleanup */ }
  }));
  stores.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe('ModelCatalogPublicProjectionPublisher', () => {
  it('reconciles model additions, health changes, deletion, and re-enable deterministically', async () => {
    const source = new MutableModelCatalogSource([
      modelEntry('model-b', 'checking'),
      modelEntry('model-a', 'ready')
    ]);
    const store = track(new SqlitePublicProjectionStore(tempRoot()));
    const publisher = new ModelCatalogPublicProjectionPublisher(source, store, {
      now: sequenceClock()
    });

    const first = publisher.publishPending();
    expect(publisher.publishPending()).toBe(first);
    await expect(first).resolves.toEqual({
      observedModels: 2,
      publishedChanges: 2,
      sourceCursor: 1
    });
    expect((await store.snapshot()).models.map((model) => ({
      id: model.modelId,
      version: model.version,
      availability: model.availability
    }))).toEqual([
      { id: 'model-a', version: 1, availability: 'ready' },
      { id: 'model-b', version: 1, availability: 'checking' }
    ]);
    await expect(publisher.publishPending()).resolves.toEqual({
      observedModels: 2,
      publishedChanges: 0,
      sourceCursor: 1
    });

    source.replace([
      modelEntry('model-a', 'ready'),
      modelEntry('model-b', 'ready')
    ]);
    await expect(publisher.publishPending()).resolves.toMatchObject({
      publishedChanges: 1,
      sourceCursor: 2
    });
    expect((await store.snapshot()).models).toMatchObject([
      { modelId: 'model-a', version: 1, availability: 'ready' },
      { modelId: 'model-b', version: 2, availability: 'ready' }
    ]);

    source.replace([modelEntry('model-b', 'ready')]);
    await expect(publisher.publishPending()).resolves.toMatchObject({
      publishedChanges: 1,
      sourceCursor: 3
    });
    const deleted = await store.snapshot();
    expect(deleted.models).toMatchObject([
      { modelId: 'model-b', version: 2, availability: 'ready' }
    ]);
    expect(deleted.tombstones).toEqual([{
      feature: 'models',
      aggregateId: 'model-a',
      aggregateVersion: 2,
      projectedAt: at(2)
    }]);

    source.replace([
      modelEntry('model-a', 'ready'),
      modelEntry('model-b', 'ready')
    ]);
    await expect(publisher.publishPending()).resolves.toMatchObject({
      publishedChanges: 1,
      sourceCursor: 4
    });
    const reEnabled = await store.snapshot();
    expect(reEnabled.tombstones).toEqual([]);
    expect(reEnabled.models).toMatchObject([
      { modelId: 'model-a', version: 3, availability: 'ready' },
      { modelId: 'model-b', version: 2, availability: 'ready' }
    ]);
  });

  it('retries the exact pending commit after a lost acknowledgement before observing newer state', async () => {
    const source = new MutableModelCatalogSource([
      modelEntry('model-a', 'checking')
    ]);
    const store = track(new SqlitePublicProjectionStore(
      tempRoot(),
      undefined,
      new OneShotAfterCommitFault()
    ));
    const publisher = new ModelCatalogPublicProjectionPublisher(source, store, {
      now: sequenceClock()
    });

    await expect(publisher.publishPending()).rejects.toThrow('kill_after_commit');
    source.replace([modelEntry('model-a', 'ready')]);

    await expect(publisher.publishPending()).resolves.toEqual({
      observedModels: 1,
      publishedChanges: 1,
      sourceCursor: 1
    });
    expect(await store.snapshot()).toMatchObject({
      cursor: 1,
      models: [{
        modelId: 'model-a',
        version: 1,
        availability: 'checking'
      }]
    });

    await expect(publisher.publishPending()).resolves.toMatchObject({
      publishedChanges: 1,
      sourceCursor: 2
    });
    expect(await store.snapshot()).toMatchObject({
      cursor: 2,
      models: [{
        modelId: 'model-a',
        version: 2,
        availability: 'ready'
      }]
    });
  });

  it('pins the exact commit until its projection wake is acknowledged', async () => {
    const source = new MutableModelCatalogSource([
      modelEntry('model-a', 'checking')
    ]);
    const store = track(new SqlitePublicProjectionStore(tempRoot()));
    const wakeAttempts: unknown[] = [];
    let rejectWake = true;
    const publisher = new ModelCatalogPublicProjectionPublisher(
      source,
      store,
      { now: sequenceClock() },
      async (commit) => {
        wakeAttempts.push(structuredClone(commit));
        if (rejectWake) {
          rejectWake = false;
          throw new Error('wake_ack_lost');
        }
      }
    );

    await expect(publisher.publishPending()).rejects.toThrow('wake_ack_lost');
    source.replace([modelEntry('model-a', 'ready')]);

    await expect(publisher.publishPending()).resolves.toEqual({
      observedModels: 1,
      publishedChanges: 1,
      sourceCursor: 1
    });
    expect(wakeAttempts).toHaveLength(2);
    expect(wakeAttempts[1]).toEqual(wakeAttempts[0]);
    expect(await store.snapshot()).toMatchObject({
      cursor: 1,
      models: [{ availability: 'checking', version: 1 }]
    });

    await expect(publisher.publishPending()).resolves.toMatchObject({
      publishedChanges: 1,
      sourceCursor: 2
    });
    expect(wakeAttempts).toHaveLength(3);
    expect(wakeAttempts[2]).toMatchObject({ sourceCursor: 2 });
  });

  it('fails closed before persistence when public model metadata contains private paths', async () => {
    const source = new MutableModelCatalogSource([{
      ...modelEntry('model-a', 'ready'),
      label: 'Model C:\\private\\weights'
    }]);
    const store = track(new SqlitePublicProjectionStore(tempRoot()));
    const publisher = new ModelCatalogPublicProjectionPublisher(source, store);

    await expect(publisher.publishPending()).rejects.toThrow(
      'public_projection_absolute_path_forbidden'
    );
    expect((await store.snapshot()).cursor).toBe(0);
  });
});

class MutableModelCatalogSource implements ModelCatalogProjectionSource {
  public constructor(private entries: readonly ModelCatalogProjectionEntry[]) {}

  public snapshot(): readonly ModelCatalogProjectionEntry[] {
    return structuredClone(this.entries);
  }

  public replace(entries: readonly ModelCatalogProjectionEntry[]): void {
    this.entries = structuredClone(entries);
  }
}

class OneShotAfterCommitFault implements PublicProjectionPersistenceFaultInjector {
  private armed = true;

  public afterCommit(): void {
    if (!this.armed) return;
    this.armed = false;
    throw new Error('kill_after_commit');
  }
}

function modelEntry(
  id: string,
  availability: ModelCatalogProjectionEntry['availability']
): ModelCatalogProjectionEntry {
  return {
    id,
    label: `Model ${id}`,
    location: 'remote',
    availability,
    supportsAgent: true,
    supportsVision: false
  };
}

function sequenceClock(): () => Date {
  let offset = 0;
  return () => new Date(Date.UTC(2032, 0, 1, 0, 0, offset++));
}

function at(offsetSeconds: number): string {
  return new Date(Date.UTC(2032, 0, 1, 0, 0, offsetSeconds)).toISOString();
}

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-model-catalog-projection-'));
  roots.add(root);
  return root;
}

function track(store: SqlitePublicProjectionStore): SqlitePublicProjectionStore {
  stores.add(store);
  return store;
}
