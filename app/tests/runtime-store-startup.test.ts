import { describe, expect, it, vi } from 'vitest';
import {
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  type PublicProjectionSnapshotV3,
  type RuntimeCommand,
  type RuntimeEventEnvelope,
  type RuntimeResult,
  type RuntimeStatus
} from '@ariadne/protocol/public';
import { RuntimeStore } from '../src/renderer/src/core/runtime/runtime-store';
import { successfulRuntimeApi } from './support/runtime-api';
import { runtimeEnvelope } from './runtime-event-fixture';
import {
  projectionCommit,
  projectionSnapshot,
  readBatch,
  run,
  session,
  upsertChange
} from './projection-v3-fixture';

const READY: RuntimeStatus = {
  availability: 'ready',
  capabilities: [],
  observedAt: '2026-07-31T00:00:00.000Z'
};

describe('RuntimeStore v3 projection startup', () => {
  it('converges on Supervisor ready when an older startup query resolves afterward', async () => {
    let statusListener: ((status: RuntimeStatus) => void) | null = null;
    let resolveStatus: ((status: RuntimeStatus) => void) | null = null;
    const store = new RuntimeStore(successfulRuntimeApi({
      getStatus: () => new Promise<RuntimeStatus>((resolve) => { resolveStatus = resolve; }),
      onStatus: (next) => {
        statusListener = next;
        return () => { statusListener = null; };
      },
      request: async (command) => {
        if (command.kind === 'projection.snapshot.get') {
          return { kind: 'projection.snapshot', snapshot: projectionSnapshot() };
        }
        if (command.kind === 'projection.commits.read') {
          return {
            kind: 'projection.commits',
            batch: readBatch(
              command.request.afterCursor,
              command.request.afterDigest,
              [],
              { streamId: command.request.streamId }
            )
          };
        }
        throw new Error(`Unexpected command: ${command.kind}`);
      },
      onEvent: () => () => undefined
    }));

    const initializing = store.initialize();
    (statusListener as unknown as (status: RuntimeStatus) => void)(READY);
    (resolveStatus as unknown as (status: RuntimeStatus) => void)({
      availability: 'starting',
      capabilities: [],
      observedAt: '2026-07-30T23:59:59.000Z'
    });
    await initializing;

    expect(store.getSnapshot()).toMatchObject({
      initialized: true,
      status: { availability: 'ready' },
      projectionStreamId: 'stream-a',
      lastError: null
    });
  });

  it('subscribes before the cold snapshot and replays from the exact cursor digest', async () => {
    const order: string[] = [];
    const commands: RuntimeCommand[] = [];
    const entity = session('session-a');
    const commit = projectionCommit('event-session-a', [
      upsertChange('sessions', entity, entity.sessionId)
    ]);
    const store = new RuntimeStore(successfulRuntimeApi({
      getStatus: async () => READY,
      request: async (command) => {
        commands.push(command);
        if (command.kind === 'projection.snapshot.get') {
          order.push('snapshot');
          return { kind: 'projection.snapshot', snapshot: projectionSnapshot() };
        }
        if (command.kind === 'projection.commits.read') {
          order.push('replay');
          return {
            kind: 'projection.commits',
            batch: readBatch(
              command.request.afterCursor,
              command.request.afterDigest,
              command.request.afterCursor === 0 ? [commit] : [],
              { streamId: command.request.streamId }
            )
          };
        }
        throw new Error(`Unexpected command: ${command.kind}`);
      },
      onEvent: () => {
        order.push('subscribe');
        return () => undefined;
      }
    }));

    await store.initialize();

    expect(order.slice(0, 3)).toEqual(['subscribe', 'snapshot', 'replay']);
    expect(store.getSnapshot()).toMatchObject({
      initialized: true,
      projectionStreamId: 'stream-a',
      projectionCursor: 1,
      sessions: [{ sessionId: 'session-a' }],
      lastError: null
    });
    expect(commands).not.toContainEqual(expect.objectContaining({ kind: 'runtime.snapshot.get' }));
    expect(commands).not.toContainEqual(expect.objectContaining({ kind: 'events.replay' }));
  });

  it('tails authoritative commits while a run is active even when no wake event arrives', async () => {
    let readCalls = 0;
    const completedRun = run('run-active', 'completed', 2);
    const terminalCommit = projectionCommit('event-run-completed', [
      upsertChange('runs', completedRun, completedRun.runId)
    ]);
    const store = new RuntimeStore(successfulRuntimeApi({
      getStatus: async () => READY,
      request: async (command) => {
        if (command.kind === 'projection.snapshot.get') {
          return {
            kind: 'projection.snapshot',
            snapshot: projectionSnapshot({ runs: [run('run-active')] })
          };
        }
        if (command.kind === 'projection.commits.read') {
          readCalls += 1;
          return {
            kind: 'projection.commits',
            batch: readBatch(
              command.request.afterCursor,
              command.request.afterDigest,
              readCalls === 2 ? [terminalCommit] : [],
              { streamId: command.request.streamId }
            )
          };
        }
        throw new Error(`Unexpected command: ${command.kind}`);
      },
      onEvent: () => () => undefined
    }));

    await store.initialize();
    expect(store.getSnapshot().runs).toEqual([
      expect.objectContaining({ runId: 'run-active', status: 'running' })
    ]);

    await vi.waitFor(() => expect(store.getSnapshot().runs).toEqual([
      expect.objectContaining({ runId: 'run-active', status: 'completed' })
    ]), { timeout: 2_000 });
    expect(readCalls).toBeGreaterThanOrEqual(2);
    store.dispose();
  });

  it('uses an event arriving during snapshot load only as a wake hint and converges by replay', async () => {
    let listener: ((event: RuntimeEventEnvelope) => void) | null = null;
    let resolveSnapshot: ((result: RuntimeResult) => void) | null = null;
    let readCount = 0;
    const entity = session('session-race');
    const commit = projectionCommit('event-session-race', [
      upsertChange('sessions', entity, entity.sessionId)
    ]);
    const store = new RuntimeStore(successfulRuntimeApi({
      getStatus: async () => READY,
      request: (command) => {
        if (command.kind === 'projection.snapshot.get') {
          return new Promise<RuntimeResult>((resolve) => { resolveSnapshot = resolve; });
        }
        if (command.kind === 'projection.commits.read') {
          readCount += 1;
          return Promise.resolve({
            kind: 'projection.commits',
            batch: readBatch(
              command.request.afterCursor,
              command.request.afterDigest,
              command.request.afterCursor === 0 ? [commit] : [],
              { streamId: command.request.streamId }
            )
          });
        }
        throw new Error(`Unexpected command: ${command.kind}`);
      },
      onEvent: (next) => {
        listener = next;
        return () => { listener = null; };
      }
    }));

    const initializing = store.initialize();
    await vi.waitFor(() => expect(resolveSnapshot).not.toBeNull());
    (listener as unknown as (event: RuntimeEventEnvelope) => void)(runtimeEnvelope({
      kind: 'trace.appended',
      entry: {
        traceId: 'legacy-wake-only',
        level: 'error',
        category: 'must.not.apply',
        message: 'v2 payload must stay invisible',
        occurredAt: '2026-07-31T00:00:00.000Z'
      }
    }, 1));
    (resolveSnapshot as unknown as (result: RuntimeResult) => void)({
      kind: 'projection.snapshot',
      snapshot: projectionSnapshot()
    });
    await initializing;

    expect(readCount).toBeGreaterThanOrEqual(2);
    expect(store.getSnapshot().sessions).toEqual([expect.objectContaining({
      sessionId: 'session-race'
    })]);
    expect(store.getSnapshot().trace).toEqual([]);
  });

  it.each(['cursor_gap', 'history_mismatch', 'contract_mismatch'] as const)(
    'recovers %s only through a new full snapshot',
    async (reason) => {
      let snapshotCalls = 0;
      let readCalls = 0;
      const store = new RuntimeStore(successfulRuntimeApi({
        getStatus: async () => READY,
        request: async (command) => {
          if (command.kind === 'projection.snapshot.get') {
            snapshotCalls += 1;
            return {
              kind: 'projection.snapshot',
              snapshot: snapshotCalls === 1
                ? projectionSnapshot()
                : projectionSnapshot({ sessions: [session(`after-${reason}`)] })
            };
          }
          if (command.kind === 'projection.commits.read') {
            readCalls += 1;
            return readCalls === 1
              ? {
                  kind: 'projection.commits',
                  batch: {
                    status: 'reset_required',
                    contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
                    streamId: command.request.streamId,
                    currentCursor: 0,
                    reason
                  }
                }
              : {
                  kind: 'projection.commits',
                  batch: readBatch(
                    command.request.afterCursor,
                    command.request.afterDigest,
                    [],
                    { streamId: command.request.streamId }
                  )
                };
          }
          throw new Error(`Unexpected command: ${command.kind}`);
        },
        onEvent: () => () => undefined
      }));

      await store.initialize();

      expect(snapshotCalls).toBe(2);
      expect(store.getSnapshot()).toMatchObject({
        sessions: [{ sessionId: `after-${reason}` }],
        projectionIntegrityError: null,
        lastError: null
      });
    }
  );

  it('resets on stream rotation and never combines the old and new streams', async () => {
    let snapshotCalls = 0;
    let readCalls = 0;
    const store = new RuntimeStore(successfulRuntimeApi({
      getStatus: async () => READY,
      request: async (command) => {
        if (command.kind === 'projection.snapshot.get') {
          snapshotCalls += 1;
          return {
            kind: 'projection.snapshot',
            snapshot: snapshotCalls === 1
              ? projectionSnapshot({ sessions: [session('old-session')] })
              : projectionSnapshot({
                  streamId: 'stream-b',
                  sessions: [session('new-session')]
                })
          };
        }
        if (command.kind === 'projection.commits.read') {
          readCalls += 1;
          return readCalls === 1
            ? {
                kind: 'projection.commits',
                batch: {
                  status: 'reset_required',
                  contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
                  streamId: 'stream-b',
                  currentCursor: 0,
                  reason: 'stream_mismatch'
                }
              }
            : {
                kind: 'projection.commits',
                batch: readBatch(
                  command.request.afterCursor,
                  command.request.afterDigest,
                  [],
                  { streamId: command.request.streamId }
                )
              };
        }
        throw new Error(`Unexpected command: ${command.kind}`);
      },
      onEvent: () => () => undefined
    }));

    await store.initialize();

    expect(store.getSnapshot()).toMatchObject({
      projectionStreamId: 'stream-b',
      sessions: [{ sessionId: 'new-session' }]
    });
    expect(store.getSnapshot().sessions).not.toContainEqual(
      expect.objectContaining({ sessionId: 'old-session' })
    );
  });

  it('clears the projection on disconnect and takes a new snapshot after runtime restart', async () => {
    let statusListener: ((status: RuntimeStatus) => void) | null = null;
    let snapshotCalls = 0;
    const store = new RuntimeStore(successfulRuntimeApi({
      getStatus: async () => READY,
      request: async (command) => {
        if (command.kind === 'projection.snapshot.get') {
          snapshotCalls += 1;
          return {
            kind: 'projection.snapshot',
            snapshot: projectionSnapshot({
              streamId: snapshotCalls === 1 ? 'stream-before-restart' : 'stream-after-restart',
              sessions: [session(snapshotCalls === 1 ? 'before-restart' : 'after-restart')]
            })
          };
        }
        if (command.kind === 'projection.commits.read') {
          return {
            kind: 'projection.commits',
            batch: readBatch(
              command.request.afterCursor,
              command.request.afterDigest,
              [],
              { streamId: command.request.streamId }
            )
          };
        }
        throw new Error(`Unexpected command: ${command.kind}`);
      },
      onStatus: (next) => {
        statusListener = next;
        return () => { statusListener = null; };
      },
      onEvent: () => () => undefined
    }));
    await store.initialize();

    (statusListener as unknown as (status: RuntimeStatus) => void)({
      ...READY,
      availability: 'restarting',
      observedAt: '2026-07-31T00:00:01.000Z'
    });
    expect(store.getSnapshot()).toMatchObject({
      status: { availability: 'restarting' },
      projectionStreamId: null,
      sessions: []
    });

    (statusListener as unknown as (status: RuntimeStatus) => void)({
      ...READY,
      observedAt: '2026-07-31T00:00:02.000Z'
    });
    await vi.waitFor(() => expect(store.getSnapshot().projectionStreamId)
      .toBe('stream-after-restart'));
    expect(store.getSnapshot().sessions).toEqual([
      expect.objectContaining({ sessionId: 'after-restart' })
    ]);
  });

  it('invalidates an old response across dispose and reinitialize', async () => {
    let snapshotCalls = 0;
    let resolveOld: ((snapshot: PublicProjectionSnapshotV3) => void) | null = null;
    let activeSubscriptions = 0;
    const store = new RuntimeStore(successfulRuntimeApi({
      getStatus: async () => READY,
      request: (command) => {
        if (command.kind === 'projection.snapshot.get') {
          snapshotCalls += 1;
          if (snapshotCalls === 1) {
            return new Promise<RuntimeResult>((resolve) => {
              resolveOld = (snapshot) => resolve({ kind: 'projection.snapshot', snapshot });
            });
          }
          return Promise.resolve({
            kind: 'projection.snapshot',
            snapshot: projectionSnapshot({
              streamId: 'stream-new',
              sessions: [session('new-session')]
            })
          });
        }
        if (command.kind === 'projection.commits.read') {
          return Promise.resolve({
            kind: 'projection.commits',
            batch: readBatch(
              command.request.afterCursor,
              command.request.afterDigest,
              [],
              { streamId: command.request.streamId }
            )
          });
        }
        throw new Error(`Unexpected command: ${command.kind}`);
      },
      onEvent: () => {
        activeSubscriptions += 1;
        return () => { activeSubscriptions -= 1; };
      }
    }));

    const oldInitialization = store.initialize();
    await vi.waitFor(() => expect(resolveOld).not.toBeNull());
    store.dispose();
    const newInitialization = store.initialize();
    await newInitialization;
    (resolveOld as unknown as (snapshot: PublicProjectionSnapshotV3) => void)(projectionSnapshot({
      streamId: 'stream-old',
      sessions: [session('stale-session')]
    }));
    await oldInitialization;

    expect(activeSubscriptions).toBe(1);
    expect(store.getSnapshot()).toMatchObject({
      projectionStreamId: 'stream-new',
      sessions: [{ sessionId: 'new-session' }]
    });
  });

  it('latches a malformed snapshot as a stable integrity error', async () => {
    const malformed = projectionSnapshot({
      sessions: [session('session-b'), session('session-a')]
    }) as unknown as PublicProjectionSnapshotV3;
    const store = new RuntimeStore(successfulRuntimeApi({
      getStatus: async () => READY,
      request: async (command) => {
        if (command.kind === 'projection.snapshot.get') {
          return { kind: 'projection.snapshot', snapshot: malformed };
        }
        throw new Error(`Unexpected command: ${command.kind}`);
      },
      onEvent: () => () => undefined
    }));

    await store.initialize();
    const first = store.getSnapshot().projectionIntegrityError;
    await store.refresh();

    expect(first).toMatch(/^projection_integrity_error:/u);
    expect(store.getSnapshot()).toMatchObject({
      projectionIntegrityError: first,
      lastError: first,
      sessions: []
    });
  });
});
