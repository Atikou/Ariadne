import { describe, expect, it } from 'vitest';
import {
  PUBLIC_PROJECTION_GENESIS_DIGEST,
  type PublicProjectionReadBatchV3
} from '@ariadne/protocol/public';
import {
  ProjectionCache,
  ProjectionIntegrityError
} from '../src/renderer/src/core/runtime/projection/projection-cache';
import {
  model,
  projectionCommit,
  projectionSnapshot,
  readBatch,
  run,
  session,
  upsertChange
} from './projection-v3-fixture';

describe('ProjectionCache', () => {
  it('isolates feature slices and preserves explicit v3 run states', async () => {
    const cache = new ProjectionCache();
    cache.replaceSnapshot(projectionSnapshot({
      sessions: [session('session-a')],
      models: [model('model-a')],
      runs: [run('run-a', 'waiting_children'), run('run-b', 'cancelling')]
    }));
    const modelsBefore = cache.models.getSnapshot();
    const runsBefore = cache.runs.getSnapshot();
    const updated = { ...session('session-a', 2), title: 'Updated session' };
    const batch = readBatch(0, PUBLIC_PROJECTION_GENESIS_DIGEST, [
      projectionCommit('event-session-2', [
        upsertChange('sessions', updated, updated.sessionId)
      ])
    ]);

    await expect(cache.applyBatch(batch)).resolves.toEqual({ status: 'applied' });

    expect(cache.sessions.getSnapshot()).toEqual([updated]);
    expect(cache.models.getSnapshot()).toBe(modelsBefore);
    expect(cache.runs.getSnapshot()).toBe(runsBefore);
    expect(cache.runs.getSnapshot().map((candidate) => candidate.status)).toEqual([
      'waiting_children',
      'cancelling'
    ]);
  });

  it('treats repeated event batches and identical aggregate versions as idempotent', async () => {
    const cache = new ProjectionCache();
    cache.replaceSnapshot(projectionSnapshot());
    const entity = session('session-a');
    const first = readBatch(0, PUBLIC_PROJECTION_GENESIS_DIGEST, [
      projectionCommit('event-1', [upsertChange('sessions', entity, entity.sessionId)])
    ]);
    await cache.applyBatch(first);

    await expect(cache.applyBatch(first)).resolves.toEqual({ status: 'stale' });

    const second = readBatch(first.nextCursor, first.nextDigest, [
      projectionCommit('event-2', [upsertChange('sessions', entity, entity.sessionId)], 2)
    ]);
    await expect(cache.applyBatch(second)).resolves.toEqual({ status: 'applied' });
    expect(cache.sessions.getSnapshot()).toEqual([entity]);
    expect(cache.getSnapshot()).toMatchObject({ cursor: 2, integrityError: null });
  });

  it('continues aggregate versions from a deleted head restored by snapshot', async () => {
    const cache = new ProjectionCache();
    const cursorDigest = `sha256:${'a'.repeat(64)}`;
    cache.replaceSnapshot(projectionSnapshot({
      cursor: 2,
      cursorDigest,
      models: [],
      tombstones: [{
        feature: 'models',
        aggregateId: 'model-a',
        aggregateVersion: 2,
        projectedAt: '2026-07-31T00:00:00.000Z'
      }]
    }));
    const restored = model('model-a', 3);
    const batch = readBatch(2, cursorDigest, [
      projectionCommit('event-model-re-enabled', [
        upsertChange('models', restored, restored.modelId)
      ], 3)
    ]);

    await expect(cache.applyBatch(batch)).resolves.toEqual({ status: 'applied' });
    expect(cache.models.getSnapshot()).toEqual([restored]);
    expect(cache.getSnapshot()).toMatchObject({ cursor: 3, integrityError: null });
  });

  it('requests a snapshot reset for a cursor gap without mutating feature state', async () => {
    const cache = new ProjectionCache();
    cache.replaceSnapshot(projectionSnapshot());
    const entity = session('session-a');
    const valid = readBatch(0, PUBLIC_PROJECTION_GENESIS_DIGEST, [
      projectionCommit('event-gap', [upsertChange('sessions', entity, entity.sessionId)])
    ]);
    const gap = {
      ...valid,
      nextCursor: 2,
      commits: [{ ...valid.commits[0]!, cursor: 2 }]
    } as unknown as PublicProjectionReadBatchV3;

    await expect(cache.applyBatch(gap)).resolves.toEqual({
      status: 'reset_required',
      reason: 'cursor_gap'
    });
    expect(cache.sessions.getSnapshot()).toEqual([]);
    expect(cache.getSnapshot().integrityError).toBeNull();
  });

  it('requests a snapshot reset when a stale response forks known cursor history', async () => {
    const cache = new ProjectionCache();
    cache.replaceSnapshot(projectionSnapshot());
    const original = session('session-a');
    const first = readBatch(0, PUBLIC_PROJECTION_GENESIS_DIGEST, [
      projectionCommit('event-original', [
        upsertChange('sessions', original, original.sessionId)
      ])
    ]);
    await cache.applyBatch(first);
    const forked = { ...original, title: 'Forked history' };
    const staleFork = readBatch(0, PUBLIC_PROJECTION_GENESIS_DIGEST, [
      projectionCommit('event-fork', [
        upsertChange('sessions', forked, forked.sessionId)
      ])
    ]);

    await expect(cache.applyBatch(staleFork)).resolves.toEqual({
      status: 'reset_required',
      reason: 'history_mismatch'
    });
    expect(cache.sessions.getSnapshot()).toEqual([original]);
    expect(cache.getSnapshot().integrityError).toBeNull();
  });

  it('latches an out-of-order aggregate version as a stable integrity failure', async () => {
    const cache = new ProjectionCache();
    cache.replaceSnapshot(projectionSnapshot({ sessions: [session('session-a')] }));
    const skipped = session('session-a', 3);
    const batch = readBatch(0, PUBLIC_PROJECTION_GENESIS_DIGEST, [
      projectionCommit('event-version-3', [
        upsertChange('sessions', skipped, skipped.sessionId)
      ])
    ]);

    const first = await cache.applyBatch(batch).catch((error: unknown) => error);
    const second = await cache.applyBatch(batch).catch((error: unknown) => error);

    expect(first).toBeInstanceOf(ProjectionIntegrityError);
    expect(second).toBe(first);
    expect(cache.getSnapshot().integrityError).toBe((first as Error).message);
    expect(cache.sessions.getSnapshot()).toEqual([session('session-a')]);
  });

  it('latches a computed history digest drift and never accepts a later snapshot silently', async () => {
    const cache = new ProjectionCache();
    cache.replaceSnapshot(projectionSnapshot());
    const entity = session('session-a');
    const valid = readBatch(0, PUBLIC_PROJECTION_GENESIS_DIGEST, [
      projectionCommit('event-drift', [upsertChange('sessions', entity, entity.sessionId)])
    ]);
    const forgedDigest = `sha256:${'f'.repeat(64)}`;
    const drifted = {
      ...valid,
      nextDigest: forgedDigest,
      commits: [{ ...valid.commits[0]!, cursorDigest: forgedDigest }]
    };

    const first = await cache.applyBatch(drifted).catch((error: unknown) => error);
    const second = (() => {
      try {
        cache.replaceSnapshot(projectionSnapshot());
      } catch (error) {
        return error;
      }
      return null;
    })();

    expect(first).toBeInstanceOf(ProjectionIntegrityError);
    expect(second).toBe(first);
    expect(cache.getSnapshot().integrityError).toBe((first as Error).message);
  });
});
