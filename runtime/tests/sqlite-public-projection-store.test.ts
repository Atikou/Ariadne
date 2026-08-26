import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  MAX_PUBLIC_PROJECTION_READ_BATCH_BYTES,
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  PUBLIC_PROJECTION_GENESIS_DIGEST,
  type ProjectionCommitV3,
  type PublicProjectionChangeV3
} from '@ariadne/protocol/public';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PUBLIC_PROJECTION_DB_SCHEMA_VERSION,
  openPublicProjectionDatabase,
  resolvePublicProjectionDatabasePath
} from '../src/adapters/persistence/PublicProjectionDbSchema.js';
import {
  SqlitePublicProjectionStore,
  type PublicProjectionPersistenceFaultInjector
} from '../src/adapters/persistence/SqlitePublicProjectionStore.js';

const roots = new Set<string>();
const stores = new Set<SqlitePublicProjectionStore>();
const BASE_TIME = Date.UTC(2032, 0, 1);

afterEach(async () => {
  await Promise.all([...stores].map(async (store) => {
    try { await store.close(); } catch { /* best-effort cleanup */ }
  }));
  stores.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe('SqlitePublicProjectionStore', () => {
  it('atomically commits all public features and returns one complete snapshot boundary', async () => {
    const root = tempRoot();
    const store = track(new SqlitePublicProjectionStore(root, clockAt(20)));
    const commit = commitWithAllFeatures();
    const result = await store.append(commit);

    expect(result).toEqual({ cursor: 1, streamId: store.streamId, replayed: false });
    const snapshot = await store.snapshot();
    expect(snapshot).toEqual({
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      streamId: store.streamId,
      cursor: 1,
      cursorDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      capturedAt: at(20),
      sessions: [commit.changes[0]!.dto],
      messages: [commit.changes[1]!.dto],
      runs: [commit.changes[2]!.dto],
      decisions: [commit.changes[3]!.dto],
      models: [commit.changes[4]!.dto],
      diagnostics: [commit.changes[5]!.dto],
      tombstones: []
    });

    const database = new DatabaseSync(resolvePublicProjectionDatabasePath(root), {
      readOnly: true
    });
    try {
      expect(rowCounts(database)).toEqual({ commits: 1, versions: 6, heads: 6, sources: 1 });
      expect(readPragmas(database)).toEqual({
        foreignKeys: 1,
        busyTimeout: 0,
        journalMode: 'wal',
        synchronous: 2
      });
    } finally {
      database.close();
    }
  });

  it('preserves deleted model head versions across snapshot, reopen, and re-enable', async () => {
    const root = tempRoot();
    let store = track(new SqlitePublicProjectionStore(root, clockAt(20)));
    await store.append(modelCatalogCommit(1, 'upsert', 1));
    await store.append(modelCatalogCommit(2, 'delete', 2));

    expect(await store.readModelProjectionHeads()).toEqual([{
      aggregateId: 'model-reload',
      aggregateVersion: 2,
      operation: 'delete',
      dto: null
    }]);
    expect(await store.readPublicProjectionSourceCheckpoint('model-catalog-test'))
      .toBe(2);
    expect(await store.snapshot()).toMatchObject({
      cursor: 2,
      models: [],
      tombstones: [{
        feature: 'models',
        aggregateId: 'model-reload',
        aggregateVersion: 2,
        projectedAt: at(2)
      }]
    });

    await closeTracked(store);
    store = track(new SqlitePublicProjectionStore(root, clockAt(30)));
    expect(await store.readModelProjectionHeads()).toEqual([{
      aggregateId: 'model-reload',
      aggregateVersion: 2,
      operation: 'delete',
      dto: null
    }]);

    await store.append(modelCatalogCommit(3, 'upsert', 3));
    const reEnabled = await store.snapshot();
    expect(reEnabled.tombstones).toEqual([]);
    expect(reEnabled.models).toMatchObject([{
      modelId: 'model-reload',
      version: 3,
      availability: 'ready'
    }]);
    expect(await store.readPublicProjectionSourceCheckpoint('model-catalog-test'))
      .toBe(3);
  });

  it('rolls back a commit that would make the complete snapshot exceed its bound', async () => {
    const root = tempRoot();
    const store = track(new SqlitePublicProjectionStore(root, clockAt(20)));
    for (let sourceCursor = 1; sourceCursor <= 8; sourceCursor += 1) {
      await store.append(distinctMessageBatchCommit(
        sourceCursor,
        ((sourceCursor - 1) * 10) + 1,
        10,
        100_000
      ));
    }
    await store.append(distinctMessageBatchCommit(9, 81, 3, 100_000));
    const before = await store.snapshot();
    expect(before).toMatchObject({ cursor: 9 });
    expect(before.messages).toHaveLength(83);

    await expect(store.append(distinctMessageBatchCommit(10, 84, 1, 100_000)))
      .rejects.toThrow('public_projection_snapshot_too_large');

    const after = await store.snapshot();
    expect(after).toEqual(before);
    expect(rowCountsFromRoot(root)).toEqual({
      commits: 9,
      versions: 83,
      heads: 83,
      sources: 1
    });
  });

  it('keeps streamId across ordinary reopen and changes it only for a rebuilt store', async () => {
    const root = tempRoot();
    let store = track(new SqlitePublicProjectionStore(root));
    const firstStreamId = store.streamId;
    await store.append(singleSessionCommit());
    await closeTracked(store);

    store = track(new SqlitePublicProjectionStore(root));
    expect(store.streamId).toBe(firstStreamId);
    expect((await store.snapshot()).cursor).toBe(1);
    await closeTracked(store);

    const databasePath = resolvePublicProjectionDatabasePath(root);
    rmSync(databasePath, { force: true });
    rmSync(`${databasePath}-wal`, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
    store = track(new SqlitePublicProjectionStore(root));
    expect(store.streamId).not.toBe(firstStreamId);
    expect(await store.snapshot()).toMatchObject({
      cursor: 0,
      cursorDigest: PUBLIC_PROJECTION_GENESIS_DIGEST
    });
  });

  it('requires reset when a restored database reuses cursors for a different history', async () => {
    const root = tempRoot();
    const databasePath = resolvePublicProjectionDatabasePath(root);
    const backupPath = path.join(root, 'projection-before-fork.db');
    let store = track(new SqlitePublicProjectionStore(root));
    const streamId = store.streamId;
    await store.append(singleSessionCommit());
    await closeTracked(store);
    copyFileSync(databasePath, backupPath);

    store = track(new SqlitePublicProjectionStore(root));
    await store.append(distinctMessageCommit(2, 10, 'message-original'));
    const originalCursor = await store.snapshot();
    expect(originalCursor.cursor).toBe(2);
    await closeTracked(store);

    copyFileSync(backupPath, databasePath);
    rmSync(`${databasePath}-wal`, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
    store = track(new SqlitePublicProjectionStore(root));
    expect(store.streamId).toBe(streamId);
    await store.append(distinctMessageCommit(2, 10, 'message-restored'));
    await store.append({
      ...singleSessionCommit(),
      eventId: 'event-restored-tail',
      sourceCursor: 3,
      changes: [sessionChange(2, 'restored tail', at(3))]
    });

    await expectReset(
      store,
      request(streamId, 2, 10, originalCursor.cursorDigest),
      'history_mismatch'
    );
    expect((await store.snapshot()).messages.map((message) => message.messageId))
      .toEqual(['message-restored']);
  });

  it('makes exact event replay a no-op and rejects event or version payload drift', async () => {
    const root = tempRoot();
    let store = track(new SqlitePublicProjectionStore(root));
    const commit = singleSessionCommit();
    expect(await store.append(commit)).toMatchObject({ cursor: 1, replayed: false });
    expect(await store.append(structuredClone(commit)))
      .toMatchObject({ cursor: 1, replayed: true });

    await expect(store.append({
      ...commit,
      changes: [{
        ...commit.changes[0]!,
        dto: { ...commit.changes[0]!.dto!, title: 'drifted title' }
      }]
    })).rejects.toThrow('event:event-1:payload_drift');

    await expect(store.append({
      ...commit,
      eventId: 'event-after-drift',
      sourceCursor: 2,
      changes: [sessionChange(2, 'must not commit', at(2))]
    })).rejects.toThrow('public_projection_store_unhealthy');
    await expect(store.snapshot()).rejects.toThrow('public_projection_store_unhealthy');
    await expect(store.read(request(store.streamId, 0, 1)))
      .rejects.toThrow('public_projection_store_unhealthy');
    expect(rowCountsFromRoot(root)).toEqual({ commits: 1, versions: 1, heads: 1, sources: 1 });

    const versionRoot = tempRoot();
    store = track(new SqlitePublicProjectionStore(versionRoot));
    await store.append(commit);

    await expect(store.append({
      ...commit,
      eventId: 'event-2',
      sourceCursor: 2,
      occurredAt: at(2),
      changes: [{
        ...commit.changes[0]!,
        projectedAt: at(2),
        dto: { ...commit.changes[0]!.dto!, title: 'different DTO' }
      }]
    })).rejects.toThrow('version:sessions:session-1:1:payload_drift');
    await expect(store.append({
      ...commit,
      eventId: 'event-after-version-drift',
      sourceCursor: 2,
      changes: [sessionChange(2, 'must not commit', at(2))]
    })).rejects.toThrow('public_projection_store_unhealthy');
    expect(rowCountsFromRoot(versionRoot))
      .toEqual({ commits: 1, versions: 1, heads: 1, sources: 1 });

    const identityRoot = tempRoot();
    store = track(new SqlitePublicProjectionStore(identityRoot));
    await store.append(commit);
    await expect(store.append({
      ...commit,
      eventId: 'event-different-identity',
      sourceCursor: 2
    })).rejects.toThrow('version:sessions:session-1:1:different_event');
    await expect(store.snapshot()).rejects.toThrow('public_projection_store_unhealthy');
  });

  it('preserves ordered changes and enforces contiguous source and aggregate versions', async () => {
    const store = track(new SqlitePublicProjectionStore(tempRoot()));
    const first = singleSessionCommit();
    await store.append({
      ...first,
      changes: [
        first.changes[0]!,
        sessionChange(2, 'second title', at(1))
      ]
    });
    expect((await store.snapshot()).sessions).toMatchObject([{
      sessionId: 'session-1',
      version: 2,
      title: 'second title'
    }]);

    await expect(store.append({
      ...first,
      eventId: 'source-gap',
      sourceCursor: 3,
      occurredAt: at(3),
      changes: [sessionChange(3, 'third title', at(3))]
    })).rejects.toThrow('source:conversation:cursor_expected_2:received_3');

    await expect(store.append({
      ...first,
      eventId: 'after-source-gap',
      sourceCursor: 2,
      changes: [sessionChange(3, 'third title', at(2))]
    })).rejects.toThrow('public_projection_store_unhealthy');

    const aggregateStore = track(new SqlitePublicProjectionStore(tempRoot()));
    await aggregateStore.append({
      ...first,
      changes: [
        first.changes[0]!,
        sessionChange(2, 'second title', at(1))
      ]
    });
    await expect(aggregateStore.append({
      ...first,
      eventId: 'aggregate-gap',
      sourceCursor: 2,
      occurredAt: at(2),
      changes: [sessionChange(4, 'fourth title', at(2))]
    })).rejects.toThrow('version:sessions:session-1:expected_3:received_4');
  });

  it('rolls back a pre-COMMIT kill and replays after a lost post-COMMIT acknowledgement', async () => {
    const beforeFault = new OneShotFault('before');
    let store = track(new SqlitePublicProjectionStore(tempRoot(), undefined, beforeFault));
    await expect(store.append(singleSessionCommit())).rejects.toThrow('kill_before_commit');
    expect((await store.snapshot()).cursor).toBe(0);
    expect(await store.append(singleSessionCommit())).toMatchObject({
      cursor: 1,
      replayed: false
    });

    const afterRoot = tempRoot();
    const afterFault = new OneShotFault('after');
    store = track(new SqlitePublicProjectionStore(afterRoot, undefined, afterFault));
    await expect(store.append(singleSessionCommit())).rejects.toThrow('kill_after_commit');
    expect(await store.append(singleSessionCommit())).toMatchObject({
      cursor: 1,
      replayed: true
    });
    expect(rowCountsFromRoot(afterRoot).commits).toBe(1);
  });

  it('reads cursor batches and requests reset for contract, stream, or cursor gaps', async () => {
    const root = tempRoot();
    const store = track(new SqlitePublicProjectionStore(root));
    await store.append(singleSessionCommit());
    await store.append({
      ...singleSessionCommit(),
      eventId: 'event-2',
      sourceCursor: 2,
      occurredAt: at(2),
      changes: [sessionChange(2, 'second', at(2))]
    });

    const first = await store.read(request(store.streamId, 0, 1));
    expect(first).toMatchObject({
      status: 'ok',
      afterCursor: 0,
      nextCursor: 1,
      hasMore: true,
      commits: [{ cursor: 1 }]
    });
    if (first.status !== 'ok') throw new Error('expected projection batch');
    const second = await store.read(request(
      store.streamId,
      1,
      10,
      first.nextDigest
    ));
    expect(second).toMatchObject({
      status: 'ok',
      nextCursor: 2,
      hasMore: false,
      commits: [{ cursor: 2 }]
    });
    await expectReset(store, { ...request(store.streamId, 0, 10), contractVersion: '4.0' }, 'contract_mismatch');
    await expectReset(store, request('different-stream', 0, 10), 'stream_mismatch');
    await expectReset(
      store,
      request(store.streamId, 1, 10, fakeDigest('a')),
      'history_mismatch'
    );
    await expectReset(
      store,
      request(store.streamId, 3, 10, fakeDigest('3')),
      'cursor_gap'
    );

    const external = new DatabaseSync(resolvePublicProjectionDatabasePath(root));
    try {
      external.exec('PRAGMA foreign_keys = OFF;');
      external.prepare('DELETE FROM projection_commits WHERE cursor=1').run();
    } finally {
      external.close();
    }
    await expectReset(store, request(store.streamId, 0, 10), 'cursor_gap');
  });

  it('streams cursor rows within a total batch byte budget', async () => {
    const store = track(new SqlitePublicProjectionStore(tempRoot()));
    for (let version = 1; version <= 90; version += 1) {
      await store.append(messageVersionCommit(version, 100_000));
    }

    const first = await store.read(request(store.streamId, 0, 2_000));
    if (first.status !== 'ok') throw new Error('expected projection batch');
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeGreaterThan(0);
    expect(first.nextCursor).toBeLessThan(90);
    expect(Buffer.byteLength(JSON.stringify(first), 'utf8'))
      .toBeLessThanOrEqual(MAX_PUBLIC_PROJECTION_READ_BATCH_BYTES);

    const second = await store.read(request(
      store.streamId,
      first.nextCursor,
      2_000,
      first.nextDigest
    ));
    if (second.status !== 'ok') throw new Error('expected projection batch');
    expect(second.nextCursor).toBe(90);
    expect(second.hasMore).toBe(false);
  });

  it('rejects private fields, absolute paths, credentials, and oversized public payloads', async () => {
    const root = tempRoot();
    const store = track(new SqlitePublicProjectionStore(root));
    const base = singleSessionCommit();
    await expect(store.append({ ...base, rawProviderInput: 'hidden' }))
      .rejects.toThrow();
    await expect(store.append({
      ...base,
      changes: [{
        ...base.changes[0]!,
        dto: { ...base.changes[0]!.dto!, title: 'Opened C:\\Users\\Admin\\secret.txt' }
      }]
    })).rejects.toThrow('public_projection_absolute_path_forbidden');
    await expect(store.append({
      ...base,
      changes: [{
        ...base.changes[0]!,
        dto: { ...base.changes[0]!.dto!, title: 'api_key=sk_test_not_public' }
      }]
    })).rejects.toThrow('public_projection_secret_forbidden');
    await expect(store.append({
      ...base,
      changes: [{
        ...base.changes[0]!,
        dto: { ...base.changes[0]!.dto!, title: 'x'.repeat(513) }
      }]
    })).rejects.toThrow();
    expect(rowCountsFromRoot(root).commits).toBe(0);
    await expect(store.append(base)).resolves.toMatchObject({
      cursor: 1,
      replayed: false
    });
  });

  it('holds a shared owner lease, verifies pragmas, and releases fencing on shutdown', async () => {
    const root = tempRoot();
    const store = track(new SqlitePublicProjectionStore(root));
    expect(() => new SqlitePublicProjectionStore(root))
      .toThrow('sqlite_owner_lease_unavailable:public_projection');

    const database = new DatabaseSync(resolvePublicProjectionDatabasePath(root), {
      readOnly: true
    });
    try {
      expect(Number((database.prepare('PRAGMA user_version;').get() as {
        user_version: number
      }).user_version)).toBe(PUBLIC_PROJECTION_DB_SCHEMA_VERSION);
    } finally {
      database.close();
    }

    await closeTracked(store);
    await expect(store.append(singleSessionCommit()))
      .rejects.toThrow('public_projection_store_closed');
    const reopened = track(new SqlitePublicProjectionStore(root));
    expect(reopened.streamId).toBe(store.streamId);
  });

  it('freezes new work while draining an already admitted commit before releasing its fence', async () => {
    const root = tempRoot();
    const store = track(new SqlitePublicProjectionStore(root));
    const admitted = store.append(singleSessionCommit());
    const closing = store.close();
    await expect(store.append({
      ...singleSessionCommit(),
      eventId: 'not-admitted',
      sourceCursor: 2
    })).rejects.toThrow('public_projection_store_closed');
    await expect(admitted).resolves.toMatchObject({ cursor: 1, replayed: false });
    await closing;
    stores.delete(store);

    const reopened = track(new SqlitePublicProjectionStore(root));
    expect((await reopened.snapshot()).cursor).toBe(1);
  });

  it('fails closed on unversioned, newer, structural, ledger, and row drift', async () => {
    const unversionedRoot = tempRoot();
    createRawDatabase(unversionedRoot, (database) => {
      database.exec('CREATE TABLE legacy_projection(id TEXT PRIMARY KEY);');
    });
    expect(() => new SqlitePublicProjectionStore(unversionedRoot))
      .toThrow('public_projection_unversioned_schema_not_empty');

    const newerRoot = tempRoot();
    createRawDatabase(newerRoot, (database) => {
      database.exec(`PRAGMA user_version = ${PUBLIC_PROJECTION_DB_SCHEMA_VERSION + 1};`);
    });
    expect(() => new SqlitePublicProjectionStore(newerRoot))
      .toThrow('public_projection_schema_newer_than_runtime');

    const structureRoot = tempRoot();
    let store = track(new SqlitePublicProjectionStore(structureRoot));
    await closeTracked(store);
    mutateDatabase(structureRoot, (database) => {
      database.exec('CREATE INDEX unexpected_projection_index ON projection_heads(aggregate_version);');
    });
    expect(() => new SqlitePublicProjectionStore(structureRoot))
      .toThrow('public_projection_schema_definition_mismatch');

    const ledgerRoot = tempRoot();
    store = track(new SqlitePublicProjectionStore(ledgerRoot));
    await closeTracked(store);
    mutateDatabase(ledgerRoot, (database) => {
      database.prepare('UPDATE schema_migrations SET applied_at=? WHERE version=?')
        .run('2032-02-30T00:00:00.000Z', PUBLIC_PROJECTION_DB_SCHEMA_VERSION);
    });
    expect(() => new SqlitePublicProjectionStore(ledgerRoot))
      .toThrow('public_projection_schema_migration_ledger_invalid');

    const metadataRoot = tempRoot();
    store = track(new SqlitePublicProjectionStore(metadataRoot));
    await closeTracked(store);
    mutateDatabase(metadataRoot, (database) => {
      database.prepare('UPDATE projection_metadata SET stream_id=? WHERE singleton_id=1')
        .run('silently-replaced-stream');
    });
    expect(() => new SqlitePublicProjectionStore(metadataRoot))
      .toThrow('public_projection_metadata_invalid');

    const historyRoot = tempRoot();
    store = track(new SqlitePublicProjectionStore(historyRoot));
    await store.append(singleSessionCommit());
    await closeTracked(store);
    mutateDatabase(historyRoot, (database) => {
      database.prepare(
        'UPDATE projection_commits SET history_digest=? WHERE cursor=1'
      ).run(fakeDigest('f'));
    });
    expect(() => new SqlitePublicProjectionStore(historyRoot))
      .toThrow('commit:1:history_digest_mismatch');

    const rowRoot = tempRoot();
    store = track(new SqlitePublicProjectionStore(rowRoot));
    await store.append(singleSessionCommit());
    await closeTracked(store);
    mutateDatabase(rowRoot, (database) => {
      database.prepare(
        `UPDATE projection_heads SET projected_at=?
         WHERE feature='sessions' AND aggregate_id='session-1'`
      ).run(at(99));
    });
    expect(() => new SqlitePublicProjectionStore(rowRoot))
      .toThrow('projection_head_mismatch');
  });
});

class OneShotFault implements PublicProjectionPersistenceFaultInjector {
  public constructor(private phase: 'before' | 'after' | 'none') {}
  public beforeCommit(): void {
    if (this.phase !== 'before') return;
    this.phase = 'none';
    throw new Error('kill_before_commit');
  }
  public afterCommit(): void {
    if (this.phase !== 'after') return;
    this.phase = 'none';
    throw new Error('kill_after_commit');
  }
}

function commitWithAllFeatures(): ProjectionCommitV3 {
  return {
    contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
    eventId: 'event-all',
    sourceId: 'composition',
    sourceCursor: 1,
    occurredAt: at(1),
    changes: [
      sessionChange(1, 'Session title', at(1)),
      {
        feature: 'messages',
        operation: 'upsert',
        aggregateId: 'message-1',
        aggregateVersion: 1,
        projectedAt: at(1),
        dto: {
          messageId: 'message-1',
          sessionId: 'session-1',
          runId: 'run-1',
          version: 1,
          role: 'assistant',
          content: 'Safe public answer.',
          status: 'completed',
          createdAt: at(1),
          updatedAt: at(1)
        }
      },
      {
        feature: 'runs',
        operation: 'upsert',
        aggregateId: 'run-1',
        aggregateVersion: 1,
        projectedAt: at(1),
        dto: {
          runId: 'run-1',
          sessionId: 'session-1',
          sourceMessageId: 'message-1',
          version: 1,
          title: 'Run title',
          status: 'running',
          label: 'Working',
          progress: 0.5,
          toolActivities: [],
          updatedAt: at(1),
          startedAt: at(0)
        }
      },
      {
        feature: 'decisions',
        operation: 'upsert',
        aggregateId: 'decision-1',
        aggregateVersion: 1,
        projectedAt: at(1),
        dto: {
          decisionId: 'decision-1',
          runId: 'run-1',
          sessionId: 'session-1',
          version: 1,
          kind: 'permission',
          status: 'pending',
          presentation: {
            contractVersion: '1.0',
            kind: 'permission',
            headline: 'Permission needed',
            summary: 'Allow a bounded public action.',
            toolName: 'tool.safe_action',
            capabilityIds: ['capability.safe_action'],
            scopeIds: ['scope.workspace'],
            resourceSummary: 'One bounded public resource.'
          },
          requestedAt: at(1),
          action: {
            contractVersion: '1.0',
            actionToken: `decision-action.v1:${'a'.repeat(64)}`,
            choices: ['allow_once', 'allow_run', 'deny']
          }
        }
      },
      {
        feature: 'models',
        operation: 'upsert',
        aggregateId: 'model-1',
        aggregateVersion: 1,
        projectedAt: at(1),
        dto: {
          modelId: 'model-1',
          version: 1,
          label: 'Model One',
          location: 'local',
          availability: 'ready',
          supportsAgent: true,
          supportsVision: false,
          updatedAt: at(1)
        }
      },
      {
        feature: 'diagnostics',
        operation: 'upsert',
        aggregateId: 'diagnostic-1',
        aggregateVersion: 1,
        projectedAt: at(1),
        dto: {
          diagnosticId: 'diagnostic-1',
          version: 1,
          severity: 'warning',
          code: 'RUNTIME_DEGRADED',
          message: 'A public diagnostic summary.',
          observedAt: at(1)
        }
      }
    ]
  };
}

function singleSessionCommit(): ProjectionCommitV3 {
  return {
    contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
    eventId: 'event-1',
    sourceId: 'conversation',
    sourceCursor: 1,
    occurredAt: at(1),
    changes: [sessionChange(1, 'first title', at(1))]
  };
}

function modelCatalogCommit(
  sourceCursor: number,
  operation: 'upsert' | 'delete',
  aggregateVersion: number
): ProjectionCommitV3 {
  const projectedAt = at(sourceCursor);
  const change: PublicProjectionChangeV3 = operation === 'delete'
    ? {
        feature: 'models',
        operation: 'delete',
        aggregateId: 'model-reload',
        aggregateVersion,
        projectedAt,
        dto: null
      }
    : {
        feature: 'models',
        operation: 'upsert',
        aggregateId: 'model-reload',
        aggregateVersion,
        projectedAt,
        dto: {
          modelId: 'model-reload',
          version: aggregateVersion,
          label: 'Reloadable model',
          location: 'remote',
          availability: 'ready',
          supportsAgent: true,
          supportsVision: false,
          updatedAt: projectedAt
        }
      };
  return {
    contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
    eventId: `event-model-catalog-${String(sourceCursor)}`,
    sourceId: 'model-catalog-test',
    sourceCursor,
    occurredAt: projectedAt,
    changes: [change]
  };
}

function sessionChange(
  version: number,
  title: string,
  projectedAt: string
): PublicProjectionChangeV3 {
  return {
    feature: 'sessions',
    operation: 'upsert',
    aggregateId: 'session-1',
    aggregateVersion: version,
    projectedAt,
    dto: {
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      version,
      title,
      pinned: false,
      status: 'active',
      createdAt: at(0),
      updatedAt: projectedAt
    }
  };
}

function distinctMessageCommit(
  cursor: number,
  contentLength: number,
  messageId: string = `message-${String(cursor).padStart(3, '0')}`
): ProjectionCommitV3 {
  const projectedAt = at(cursor);
  return {
    contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
    eventId: `event-message-${String(cursor)}`,
    sourceId: 'conversation',
    sourceCursor: cursor,
    occurredAt: projectedAt,
    changes: [{
      feature: 'messages',
      operation: 'upsert',
      aggregateId: messageId,
      aggregateVersion: 1,
      projectedAt,
      dto: {
        messageId,
        sessionId: 'session-1',
        version: 1,
        role: 'assistant',
        content: 'x'.repeat(contentLength),
        status: 'completed',
        createdAt: at(0),
        updatedAt: projectedAt
      }
    }]
  };
}

function distinctMessageBatchCommit(
  sourceCursor: number,
  firstMessageOrdinal: number,
  messageCount: number,
  contentLength: number
): ProjectionCommitV3 {
  const projectedAt = at(sourceCursor);
  return {
    contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
    eventId: `event-message-batch-${String(sourceCursor)}`,
    sourceId: 'conversation',
    sourceCursor,
    occurredAt: projectedAt,
    changes: Array.from({ length: messageCount }, (_, index) => {
      const ordinal = firstMessageOrdinal + index;
      const messageId = `message-${String(ordinal).padStart(3, '0')}`;
      return {
        feature: 'messages' as const,
        operation: 'upsert' as const,
        aggregateId: messageId,
        aggregateVersion: 1,
        projectedAt,
        dto: {
          messageId,
          sessionId: 'session-1',
          version: 1,
          role: 'assistant' as const,
          content: 'x'.repeat(contentLength),
          status: 'completed' as const,
          createdAt: at(0),
          updatedAt: projectedAt
        }
      };
    })
  };
}

function messageVersionCommit(
  version: number,
  contentLength: number
): ProjectionCommitV3 {
  const projectedAt = at(version);
  return {
    contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
    eventId: `event-history-${String(version)}`,
    sourceId: 'conversation',
    sourceCursor: version,
    occurredAt: projectedAt,
    changes: [{
      feature: 'messages',
      operation: 'upsert',
      aggregateId: 'message-history',
      aggregateVersion: version,
      projectedAt,
      dto: {
        messageId: 'message-history',
        sessionId: 'session-1',
        version,
        role: 'assistant',
        content: 'x'.repeat(contentLength),
        status: 'completed',
        createdAt: at(0),
        updatedAt: projectedAt
      }
    }]
  };
}

function request(
  streamId: string,
  afterCursor: number,
  limit: number,
  afterDigest: string = PUBLIC_PROJECTION_GENESIS_DIGEST
) {
  return {
    contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
    streamId,
    afterCursor,
    afterDigest,
    limit
  };
}

function fakeDigest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

async function expectReset(
  store: SqlitePublicProjectionStore,
  value: ReturnType<typeof request>,
  reason: string
): Promise<void> {
  expect(await store.read(value)).toMatchObject({
    status: 'reset_required',
    streamId: store.streamId,
    reason
  });
}

function rowCounts(database: DatabaseSync) {
  return database.prepare(
    `SELECT
       (SELECT COUNT(*) FROM projection_commits) AS commits,
       (SELECT COUNT(*) FROM projection_versions) AS versions,
       (SELECT COUNT(*) FROM projection_heads) AS heads,
       (SELECT COUNT(*) FROM projection_source_checkpoints) AS sources`
  ).get() as Record<'commits' | 'versions' | 'heads' | 'sources', number>;
}

function rowCountsFromRoot(root: string) {
  const database = new DatabaseSync(resolvePublicProjectionDatabasePath(root), {
    readOnly: true
  });
  try { return rowCounts(database); } finally { database.close(); }
}

function readPragmas(database: DatabaseSync) {
  return {
    foreignKeys: Number((database.prepare('PRAGMA foreign_keys;').get() as {
      foreign_keys: number
    }).foreign_keys),
    busyTimeout: Number((database.prepare('PRAGMA busy_timeout;').get() as {
      timeout: number
    }).timeout),
    journalMode: (database.prepare('PRAGMA journal_mode;').get() as {
      journal_mode: string
    }).journal_mode.toLowerCase(),
    synchronous: Number((database.prepare('PRAGMA synchronous;').get() as {
      synchronous: number
    }).synchronous)
  };
}

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-public-projection-'));
  roots.add(root);
  return root;
}

function track(store: SqlitePublicProjectionStore): SqlitePublicProjectionStore {
  stores.add(store);
  return store;
}

async function closeTracked(store: SqlitePublicProjectionStore): Promise<void> {
  await store.close();
  stores.delete(store);
}

function createRawDatabase(root: string, action: (database: DatabaseSync) => void): void {
  const databasePath = resolvePublicProjectionDatabasePath(root);
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try { action(database); } finally { database.close(); }
}

function mutateDatabase(root: string, action: (database: DatabaseSync) => void): void {
  const database = new DatabaseSync(resolvePublicProjectionDatabasePath(root));
  try { action(database); } finally { database.close(); }
}

function clockAt(seconds: number) {
  return { now: () => new Date(BASE_TIME + seconds * 1_000) };
}

function at(seconds: number): string {
  return new Date(BASE_TIME + seconds * 1_000).toISOString();
}
