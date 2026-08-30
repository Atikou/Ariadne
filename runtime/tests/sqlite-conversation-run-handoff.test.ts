import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import {
  type ConversationRunHandoffCommand,
  type ConversationRunHandoffSaga
} from '../src/conversation/ConversationRunHandoffSaga.js';
import type {
  AcceptConversationUserMessageCommand,
  CreateConversationSessionCommand
} from '../src/conversation/ConversationAuthority.js';
import { ConversationAuthorityService } from '../src/control/conversation/ConversationAuthorityService.js';
import { ConversationRunHandoffSagaService } from '../src/control/conversation/ConversationRunHandoffSagaService.js';
import {
  CONVERSATION_DB_SCHEMA_VERSION,
  openConversationDatabase,
  resolveConversationDatabasePath
} from '../src/adapters/persistence/ConversationDbSchema.js';
import {
  ConversationOutboxClaimError,
  SqliteConversationRunHandoffUnitOfWork,
  type ConversationPersistenceClock,
  type ConversationPersistenceFaultInjector,
  type ConversationShutdownContext
} from '../src/adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';

const roots = new Set<string>();
const units = new Set<SqliteConversationRunHandoffUnitOfWork>();

afterEach(async () => {
  for (const unit of [...units]) await closeUnit(unit);
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  units.clear();
  roots.clear();
});

describe('SqliteConversationRunHandoffUnitOfWork', () => {
  it('atomically persists the reference-only four-stage handoff and replays after reopen', async () => {
    const root = tempRoot();
    let unit = track(new SqliteConversationRunHandoffUnitOfWork(root));
    let service = new ConversationRunHandoffSagaService(unit);
    const accepted = await acceptAuthoritatively(unit);
    const requested = await service.execute(requestCommand(accepted.saga));
    const linked = await service.execute(linkCommand(requested.saga));
    const projected = await service.execute(projectCommand(linked.saga));

    expect(projected.saga).toMatchObject({
      version: 4,
      stage: { kind: 'agent_result_projected', resultRunVersion: 7 }
    });
    const database = new DatabaseSync(resolveConversationDatabasePath(root), {
      readOnly: true
    });
    try {
      const counts = database.prepare(
        `SELECT
           (SELECT COUNT(*) FROM conversation_handoff_sagas) AS sagas,
           (SELECT COUNT(*) FROM conversation_handoff_commands) AS commands,
           (SELECT COUNT(*) FROM conversation_handoff_inbox) AS inbox,
           (SELECT COUNT(*) FROM conversation_handoff_events) AS events,
           (SELECT COUNT(*) FROM conversation_handoff_outbox) AS outbox`
      ).get() as Record<string, number>;
      expect(counts).toEqual({ sagas: 1, commands: 4, inbox: 4, events: 4, outbox: 4 });
      const serialized = database.prepare(
        `SELECT group_concat(saga_json || message_json, '') AS serialized
         FROM conversation_handoff_sagas
         CROSS JOIN conversation_handoff_outbox`
      ).get() as { serialized: string };
      expect(serialized.serialized).not.toContain('raw user prompt');
      expect(serialized.serialized).not.toContain('provider-secret');
      expect(serialized.serialized).toContain(accepted.messageVersion.contentDigest);
    } finally {
      database.close();
    }

    await closeUnit(unit);
    units.delete(unit);
    unit = track(new SqliteConversationRunHandoffUnitOfWork(root));
    service = new ConversationRunHandoffSagaService(unit);
    const replay = await service.execute(projectCommand(linked.saga));
    expect(replay.replayed).toBe(true);
    expect(replay.saga).toEqual(projected.saga);
  });

  it('serializes concurrent exact duplicates to one commit and rejects digest drift', async () => {
    const root = tempRoot();
    const unit = track(new SqliteConversationRunHandoffUnitOfWork(root));
    const authority = new ConversationAuthorityService(unit);
    await authority.createSession(createSessionCommand());
    const command = acceptAuthorityCommand();
    const [left, right] = await Promise.all([
      authority.acceptUserMessage(command),
      authority.acceptUserMessage(structuredClone(command))
    ]);
    expect([left.replayed, right.replayed].sort()).toEqual([false, true]);

    await expect(authority.acceptUserMessage({
      ...command,
      content: 'drifted raw user prompt'
    })).rejects.toMatchObject({ code: 'CONVERSATION_COMMAND_CONFLICT' });
    expect(countRows(root, 'conversation_handoff_commands')).toBe(1);
    expect(countRows(root, 'conversation_handoff_outbox')).toBe(1);
  });

  it('snapshots Handoff commands before fingerprinting yields', async () => {
    const root = tempRoot();
    const unit = track(new SqliteConversationRunHandoffUnitOfWork(root));
    const service = new ConversationRunHandoffSagaService(unit);
    const accepted = await acceptAuthoritatively(unit);
    const request = { ...requestCommand(accepted.saga) };
    const requesting = service.execute(request);
    request.commandId = 'mutated-request-command';
    request.inboxEventId = 'mutated-request-inbox';
    request.outboxMessageId = 'mutated-request-outbox';
    request.objectiveDigest = `sha256:${'f'.repeat(64)}`;
    request.runRequestId = 'mutated-run-request';
    request.agentCommandId = 'mutated-agent-command';
    request.occurredAt = at(9);

    const requested = await requesting;
    expect(requested).toMatchObject({
      replayed: false,
      saga: {
        objectiveDigest: accepted.saga.objectiveDigest,
        stage: {
          kind: 'agent_run_requested',
          runRequestId: 'run-request-1',
          agentCommandId: 'agent-command-1',
          requestedAt: at(1)
        }
      },
      outbox: { messageId: 'outbox-run-request' }
    });
    expect((await service.execute(requestCommand(accepted.saga))).replayed).toBe(true);
  });

  it('enforces expectedVersion CAS and rolls back every artifact on global identity conflict', async () => {
    const root = tempRoot();
    const unit = track(new SqliteConversationRunHandoffUnitOfWork(root));
    const service = new ConversationRunHandoffSagaService(unit);
    const accepted = await acceptAuthoritatively(unit);
    await service.execute(requestCommand(accepted.saga));
    await expect(service.execute({
      ...requestCommand(accepted.saga),
      commandId: 'request-stale',
      inboxEventId: 'inbox-stale',
      outboxMessageId: 'outbox-stale'
    })).rejects.toMatchObject({ code: 'HANDOFF_VERSION_CONFLICT' });

    const authority = new ConversationAuthorityService(unit);
    await authority.createSession(createSessionCommand('saga-2', 'second'));
    const second = acceptAuthorityCommand('saga-2', 'second');
    const colliding = {
      ...second,
      handoffOutboxMessageId: 'outbox-message-accepted'
    };
    await expect(authority.acceptUserMessage(colliding))
      .rejects.toMatchObject({ code: 'HANDOFF_COMMAND_CONFLICT' });
    expect(countRows(root, 'conversation_handoff_sagas')).toBe(1);
    expect(countRows(root, 'conversation_handoff_commands')).toBe(2);
    expect(countRows(root, 'conversation_handoff_inbox')).toBe(2);
    expect(countRows(root, 'conversation_handoff_events')).toBe(2);
    expect(countRows(root, 'conversation_handoff_outbox')).toBe(2);

    const recovered = await authority.acceptUserMessage({
      ...second,
      commandId: colliding.commandId,
      handoffOutboxMessageId: 'outbox-second-recovered'
    });
    expect(recovered.replayed).toBe(false);
    expect(recovered.saga.sagaId).toBe('saga-2');
  });

  it('rolls back before COMMIT and replays a durable receipt after post-COMMIT loss', async () => {
    const beforeRoot = tempRoot();
    const beforeFault = new OneShotFault('none');
    let unit = track(new SqliteConversationRunHandoffUnitOfWork(
      beforeRoot,
      undefined,
      beforeFault
    ));
    let authority = new ConversationAuthorityService(unit);
    await authority.createSession(createSessionCommand());
    beforeFault.phase = 'before';
    await expect(authority.acceptUserMessage(acceptAuthorityCommand()))
      .rejects.toThrow('kill_before_conversation_commit');
    beforeFault.phase = 'none';
    const firstCommitted = await authority.acceptUserMessage(acceptAuthorityCommand());
    expect(firstCommitted.replayed).toBe(false);

    const afterRoot = tempRoot();
    const afterFault = new OneShotFault('none');
    unit = track(new SqliteConversationRunHandoffUnitOfWork(
      afterRoot,
      undefined,
      afterFault
    ));
    authority = new ConversationAuthorityService(unit);
    afterFault.phase = 'none';
    await authority.createSession(createSessionCommand());
    afterFault.phase = 'after';
    await expect(authority.acceptUserMessage(acceptAuthorityCommand()))
      .rejects.toThrow('kill_after_conversation_commit');
    afterFault.phase = 'none';
    const replay = await authority.acceptUserMessage(acceptAuthorityCommand());
    expect(replay.replayed).toBe(true);
    expect(countRows(afterRoot, 'conversation_handoff_commands')).toBe(1);
    expect(countRows(afterRoot, 'conversation_handoff_outbox')).toBe(1);
  });

  it('claims durable cursors without overlap, reclaims expired leases, and ACKs exact claims', async () => {
    const clock = new MutableClock(at(10));
    const root = tempRoot();
    let unit = track(new SqliteConversationRunHandoffUnitOfWork(root, clock));
    const service = new ConversationRunHandoffSagaService(unit);
    const accepted = await acceptAuthoritatively(unit);
    const requested = await service.execute(requestCommand(accepted.saga));
    const linked = await service.execute(linkCommand(requested.saga));
    await service.execute(projectCommand(linked.saga));
    expect(await unit.countPendingHandoffOutbox()).toBe(4);

    const claimA = await unit.claimPending({ claimId: 'claim-a', limit: 2, leaseMs: 1_000 });
    const claimAReplay = await unit.claimPending({
      claimId: 'claim-a', limit: 2, leaseMs: 1_000
    });
    const claimB = await unit.claimPending({ claimId: 'claim-b', limit: 2, leaseMs: 1_000 });
    expect(claimA.map((entry) => entry.cursor)).toEqual([1, 2]);
    expect(claimAReplay).toEqual(claimA);
    expect(claimB.map((entry) => entry.cursor)).toEqual([3, 4]);

    clock.set(atMilliseconds(11_000));
    const reclaimed = await unit.claimPending({
      claimId: 'claim-c', limit: 1, leaseMs: 1_000
    });
    expect(reclaimed).toMatchObject([{ cursor: 1, claimAttempts: 2 }]);
    await expect(unit.acknowledgePublished({
      claimId: 'claim-a',
      messages: [{ cursor: claimA[0]!.cursor, messageId: claimA[0]!.message.messageId }]
    })).rejects.toBeInstanceOf(ConversationOutboxClaimError);
    await expect(unit.acknowledgePublished({
      claimId: 'claim-c',
      messages: [{ cursor: 1, messageId: 'wrong-message' }]
    })).rejects.toBeInstanceOf(ConversationOutboxClaimError);
    const exact = [{ cursor: 1, messageId: reclaimed[0]!.message.messageId }];
    await unit.acknowledgePublished({ claimId: 'claim-c', messages: exact });
    await unit.acknowledgePublished({ claimId: 'claim-c', messages: exact });
    expect(await unit.countPendingHandoffOutbox()).toBe(3);

    const rest = await unit.claimPending({ claimId: 'claim-d', limit: 100, leaseMs: 1_000 });
    expect(rest.map((entry) => entry.cursor)).toEqual([2, 3, 4]);
    await unit.acknowledgePublished({
      claimId: 'claim-d',
      messages: rest.map((entry) => ({
        cursor: entry.cursor,
        messageId: entry.message.messageId
      }))
    });
    expect(await unit.countPendingHandoffOutbox()).toBe(0);
    await closeUnit(unit);
    units.delete(unit);
    unit = track(new SqliteConversationRunHandoffUnitOfWork(root, clock));
    expect(await unit.claimPending({ claimId: 'claim-e', limit: 100, leaseMs: 1_000 }))
      .toEqual([]);
    expect(await unit.countPendingHandoffOutbox()).toBe(0);
  });

  it('reclaims the previous Conversation owner claim immediately on takeover', async () => {
    const clock = new MutableClock(at(10));
    const root = tempRoot();
    let unit = track(new SqliteConversationRunHandoffUnitOfWork(root, clock));
    await acceptAuthoritatively(unit);
    await expect(unit.claimPending({
      claimId: 'dead-conversation-owner',
      limit: 10,
      leaseMs: 5 * 60_000
    })).resolves.toMatchObject([{ cursor: 1, claimAttempts: 1 }]);

    await closeUnit(unit);
    units.delete(unit);
    unit = track(new SqliteConversationRunHandoffUnitOfWork(root, clock));
    await expect(unit.claimPending({
      claimId: 'replacement-conversation-owner',
      limit: 10,
      leaseMs: 5 * 60_000
    })).resolves.toMatchObject([{ cursor: 1, claimAttempts: 2 }]);
  });

  it('holds an independent owner lease and applies WAL/FULL/FK/busy_timeout=0', async () => {
    const root = tempRoot();
    const unit = track(new SqliteConversationRunHandoffUnitOfWork(root));
    expect(() => new SqliteConversationRunHandoffUnitOfWork(root))
      .toThrow('sqlite_owner_lease_unavailable:conversation');
    await closeUnit(unit);
    units.delete(unit);
    const opened = openConversationDatabase(root);
    try {
      expect(readPragmas(opened.database)).toEqual({
        foreignKeys: 1,
        busyTimeout: 0,
        journalMode: 'wal',
        synchronous: 2
      });
      expect(Number((opened.database.prepare('PRAGMA user_version;').get() as {
        user_version: number
      }).user_version)).toBe(CONVERSATION_DB_SCHEMA_VERSION);
    } finally {
      closeConversationDatabaseForTest(opened);
    }
    const reopened = track(new SqliteConversationRunHandoffUnitOfWork(root));
    expect(reopened).toBeDefined();
  });

  it('upgrades a populated v1 store through v2/v3 to v4 without losing its handoff', async () => {
    const root = tempRoot();
    const unit = track(new SqliteConversationRunHandoffUnitOfWork(root));
    await acceptAuthoritatively(unit);
    await closeUnit(unit);
    units.delete(unit);
    const legacy = new DatabaseSync(resolveConversationDatabasePath(root));
    downgradeSessionLifecycleSchemaToV1(legacy);
    legacy.close();

    const reopened = track(new SqliteConversationRunHandoffUnitOfWork(root));
    await expect(reopened.transaction(
      (transaction) => transaction.loadSaga('saga-1')
    )).resolves.toMatchObject({
      version: 1,
      stage: { kind: 'message_accepted' }
    });
    const verify = new DatabaseSync(resolveConversationDatabasePath(root), { readOnly: true });
    try {
      expect(verify.prepare('PRAGMA user_version;').get()).toEqual({
        user_version: CONVERSATION_DB_SCHEMA_VERSION
      });
      expect(verify.prepare(
        `SELECT version, title, status FROM conversation_session_versions
         WHERE session_id='session-saga-1' ORDER BY version`
      ).all()).toEqual([
        { version: 1, title: 'Conversation', status: 'active' },
        { version: 2, title: 'Conversation', status: 'active' }
      ]);
    } finally {
      verify.close();
    }
  });

  it('fails closed on unversioned nonempty, newer, and structurally drifted stores', () => {
    const unversionedRoot = tempRoot();
    createRawDatabase(unversionedRoot, (database) => {
      database.exec('CREATE TABLE legacy_messages(id TEXT PRIMARY KEY);');
    });
    expect(() => openConversationDatabase(unversionedRoot))
      .toThrow('conversation_unversioned_schema_not_empty');

    const newerRoot = tempRoot();
    createRawDatabase(newerRoot, (database) => {
      database.exec(`PRAGMA user_version = ${CONVERSATION_DB_SCHEMA_VERSION + 1};`);
    });
    expect(() => openConversationDatabase(newerRoot))
      .toThrow('conversation_schema_newer_than_runtime');

    const driftRoot = tempRoot();
    const opened = openConversationDatabase(driftRoot);
    closeConversationDatabaseForTest(opened);
    const drift = new DatabaseSync(resolveConversationDatabasePath(driftRoot));
    drift.exec('CREATE INDEX unexpected_saga_index ON conversation_handoff_sagas(version);');
    drift.close();
    expect(() => openConversationDatabase(driftRoot))
      .toThrow('conversation_schema_definition_mismatch');

    const ledgerRoot = tempRoot();
    const ledgerOpened = openConversationDatabase(ledgerRoot);
    closeConversationDatabaseForTest(ledgerOpened);
    const ledger = new DatabaseSync(resolveConversationDatabasePath(ledgerRoot));
    ledger.prepare('UPDATE schema_migrations SET applied_at=? WHERE version=?')
      .run('2030-02-30T00:00:00.000Z', CONVERSATION_DB_SCHEMA_VERSION);
    ledger.close();
    expect(() => openConversationDatabase(ledgerRoot))
      .toThrow('conversation_schema_migration_ledger_invalid');
  });

  it('binds Saga objectiveDigest to Message contentDigest on write, read, and reopen', async () => {
    const root = tempRoot();
    const unit = track(new SqliteConversationRunHandoffUnitOfWork(root));
    await acceptAuthoritatively(unit);
    const database = new DatabaseSync(resolveConversationDatabasePath(root));
    const driftDigest = `sha256:${'f'.repeat(64)}`;
    try {
      database.exec('PRAGMA foreign_keys = ON;');
      const row = database.prepare(
        'SELECT saga_json FROM conversation_handoff_sagas WHERE saga_id=?'
      ).get('saga-1') as { saga_json: string };
      const saga = JSON.parse(row.saga_json) as Record<string, unknown>;
      saga.objectiveDigest = driftDigest;
      const update = database.prepare(
        `UPDATE conversation_handoff_sagas
         SET objective_digest=?, saga_json=? WHERE saga_id=?`
      );
      expect(() => update.run(driftDigest, JSON.stringify(saga), 'saga-1'))
        .toThrow(/constraint failed/iu);

      database.exec('PRAGMA foreign_keys = OFF;');
      update.run(driftDigest, JSON.stringify(saga), 'saga-1');
    } finally {
      database.close();
    }

    await expect(unit.readSaga('saga-1'))
      .rejects.toThrow('conversation_storage_corruption');
    await closeUnit(unit);
    units.delete(unit);
    expect(() => new SqliteConversationRunHandoffUnitOfWork(root))
      .toThrow('conversation_schema_integrity_check_failed');
  });

  it('fails closed when persisted Saga columns drift from authority foreign keys', async () => {
    const root = tempRoot();
    let unit = track(new SqliteConversationRunHandoffUnitOfWork(root));
    await acceptAuthoritatively(unit);
    await closeUnit(unit);
    units.delete(unit);

    const database = new DatabaseSync(resolveConversationDatabasePath(root));
    database.exec('PRAGMA foreign_keys = OFF;');
    database.prepare(
      `UPDATE conversation_handoff_sagas SET session_id=? WHERE saga_id=?`
    ).run('session-corrupt', 'saga-1');
    database.close();

    expect(() => new SqliteConversationRunHandoffUnitOfWork(root))
      .toThrow('conversation_schema_integrity_check_failed');
  });

  it('freezes ingress before bounded close and rejects transactions after shutdown', async () => {
    const unit = track(new SqliteConversationRunHandoffUnitOfWork(tempRoot()));
    const authority = new ConversationAuthorityService(unit);
    await authority.createSession(createSessionCommand());
    const started = deferred<void>();
    const release = deferred<void>();
    const active = unit.transaction(async () => {
      started.resolve();
      await release.promise;
    });
    await started.promise;
    const context = createShutdownContext(Date.now() + 5_000);
    try {
      const close = unit.close(context);
      await expect(authority.acceptUserMessage(acceptAuthorityCommand()))
        .rejects.toThrow('conversation_unit_of_work_closed');
      const activeFailure = expect(active)
        .rejects.toThrow('conversation_unit_of_work_shutdown_requested');
      release.resolve();
      await activeFailure;
      await close;
      units.delete(unit);
      await expect(unit.claimPending({ claimId: 'after-close', limit: 1, leaseMs: 10 }))
        .rejects.toThrow('conversation_unit_of_work_closed');
    } finally {
      context.dispose();
    }
  });
});

class MutableClock implements ConversationPersistenceClock {
  public constructor(private value: string) {}
  public now(): Date { return new Date(this.value); }
  public set(value: string): void { this.value = value; }
}

class OneShotFault implements ConversationPersistenceFaultInjector {
  public constructor(public phase: 'before' | 'after' | 'none') {}
  public beforeCommit(): void {
    if (this.phase !== 'before') return;
    this.phase = 'none';
    throw new Error('kill_before_conversation_commit');
  }
  public afterCommit(): void {
    if (this.phase !== 'after') return;
    this.phase = 'none';
    throw new Error('kill_after_conversation_commit');
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function createSessionCommand(
  sagaId = 'saga-1',
  suffix = 'accepted'
): CreateConversationSessionCommand {
  return {
    kind: 'conversation.create_session',
    commandId: `session-command-${suffix}`,
    eventId: `session-event-${suffix}`,
    sessionId: `session-${sagaId}`,
    workspaceId: `workspace-${sagaId}`,
    expectedVersion: null,
    occurredAt: at(0)
  };
}

function acceptAuthorityCommand(
  sagaId = 'saga-1',
  suffix = 'accepted'
): AcceptConversationUserMessageCommand {
  return {
    kind: 'conversation.accept_user_message',
    commandId: `authority-command-${suffix}`,
    eventId: `inbox-${suffix}`,
    sessionId: `session-${sagaId}`,
    workspaceId: `workspace-${sagaId}`,
    expectedSessionVersion: 1,
    messageId: `message-${sagaId}`,
    expectedMessageVersion: null,
    content: `raw user prompt:${sagaId}`,
    sagaId,
    handoffCommandId: `command-${suffix}`,
    handoffOutboxMessageId: `outbox-message-${suffix}`,
    occurredAt: at(0)
  };
}

async function acceptAuthoritatively(
  unit: SqliteConversationRunHandoffUnitOfWork,
  sagaId = 'saga-1',
  suffix = 'accepted'
) {
  const authority = new ConversationAuthorityService(unit);
  await authority.createSession(createSessionCommand(sagaId, suffix));
  return authority.acceptUserMessage(acceptAuthorityCommand(sagaId, suffix));
}

function requestCommand(saga: ConversationRunHandoffSaga): Extract<
  ConversationRunHandoffCommand,
  { kind: 'handoff.request_agent_run' }
> {
  return {
    kind: 'handoff.request_agent_run',
    ...identity(saga),
    sagaId: saga.sagaId,
    commandId: 'command-request',
    expectedVersion: saga.version,
    inboxEventId: 'inbox-request',
    outboxMessageId: 'outbox-run-request',
    occurredAt: at(1),
    runRequestId: 'run-request-1',
    agentCommandId: 'agent-command-1'
  };
}

function linkCommand(saga: ConversationRunHandoffSaga): Extract<
  ConversationRunHandoffCommand,
  { kind: 'handoff.link_agent_run' }
> {
  const stage = saga.stage;
  return {
    kind: 'handoff.link_agent_run',
    ...identity(saga),
    sagaId: saga.sagaId,
    commandId: 'command-link',
    expectedVersion: saga.version,
    inboxEventId: 'inbox-link',
    outboxMessageId: 'outbox-run-linked',
    occurredAt: at(2),
    runRequestId: 'runRequestId' in stage ? stage.runRequestId : 'run-request-1',
    agentCommandId: 'agentCommandId' in stage ? stage.agentCommandId : 'agent-command-1',
    runId: 'run-1',
    admittedRunVersion: 1
  };
}

function projectCommand(saga: ConversationRunHandoffSaga): Extract<
  ConversationRunHandoffCommand,
  { kind: 'handoff.project_agent_result' }
> {
  const stage = saga.stage;
  return {
    kind: 'handoff.project_agent_result',
    ...identity(saga),
    sagaId: saga.sagaId,
    commandId: 'command-project',
    expectedVersion: saga.version,
    inboxEventId: 'inbox-project',
    outboxMessageId: 'outbox-result-projected',
    occurredAt: at(3),
    runRequestId: 'runRequestId' in stage ? stage.runRequestId : 'run-request-1',
    agentCommandId: 'agentCommandId' in stage ? stage.agentCommandId : 'agent-command-1',
    runId: 'runId' in stage ? stage.runId : 'run-1',
    admittedRunVersion: 'admittedRunVersion' in stage ? stage.admittedRunVersion : 1,
    resultRunVersion: 7,
    resultStatus: 'completed',
    sourceRunEventId: 'run-event-7'
  };
}

function identity(saga: ConversationRunHandoffSaga) {
  return {
    sessionId: saga.sessionId,
    workspaceId: saga.workspaceId,
    messageId: saga.messageId,
    messageVersion: saga.messageVersion,
    objectiveDigest: saga.objectiveDigest
  };
}

function countRows(
  root: string,
  table: string
): number {
  const allowed = new Set([
    'conversation_handoff_sagas',
    'conversation_handoff_commands',
    'conversation_handoff_inbox',
    'conversation_handoff_events',
    'conversation_handoff_outbox'
  ]);
  if (!allowed.has(table)) throw new Error('test_table_invalid');
  const database = new DatabaseSync(resolveConversationDatabasePath(root), { readOnly: true });
  try {
    return Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number
    }).count);
  } finally {
    database.close();
  }
}

function createRawDatabase(root: string, action: (database: DatabaseSync) => void): void {
  const databasePath = resolveConversationDatabasePath(root);
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try { action(database); } finally { database.close(); }
}

function downgradeSessionLifecycleSchemaToV1(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = OFF;');
  database.exec('PRAGMA legacy_alter_table = ON;');
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec('DROP TRIGGER conversation_navigation_commands_no_update;');
    database.exec('DROP TRIGGER conversation_navigation_commands_no_delete;');
    database.exec('DROP TABLE conversation_navigation_commands;');
    database.exec('DROP TRIGGER conversation_session_lineage_no_update;');
    database.exec('DROP TRIGGER conversation_session_lineage_no_delete;');
    database.exec('DROP INDEX idx_conversation_session_lineage_source;');
    database.exec('DROP TABLE conversation_session_lineage;');
    database.exec('DROP TRIGGER conversation_session_versions_no_update;');
    database.exec('DROP TRIGGER conversation_session_versions_no_delete;');
    database.exec('DROP INDEX idx_conversation_session_versions_workspace;');
    database.exec('DROP TABLE conversation_session_versions;');
    database.exec('ALTER TABLE conversation_sessions RENAME TO __v3_conversation_sessions;');
    database.exec(`
      CREATE TABLE conversation_sessions (
        session_id TEXT PRIMARY KEY CHECK(length(session_id) BETWEEN 1 AND 256),
        workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
        version INTEGER NOT NULL CHECK(version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(session_id, workspace_id),
        CHECK(updated_at >= created_at)
      );
      INSERT INTO conversation_sessions(
        session_id, workspace_id, version, created_at, updated_at
      )
      SELECT session_id, workspace_id, version, created_at, updated_at
      FROM __v3_conversation_sessions;
      DROP TABLE __v3_conversation_sessions;
      CREATE INDEX idx_conversation_sessions_workspace
        ON conversation_sessions(workspace_id, updated_at DESC);
    `);
    database.prepare('UPDATE schema_migrations SET version=1, name=?')
      .run('conversation_authority_v1_agent_result_projection');
    database.exec('PRAGMA user_version = 1;');
    database.exec('COMMIT;');
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.exec('PRAGMA legacy_alter_table = OFF;');
    database.exec('PRAGMA foreign_keys = ON;');
  }
}

function closeConversationDatabaseForTest(
  opened: ReturnType<typeof openConversationDatabase>
): void {
  opened.database.close();
  opened.ownerLease.close();
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
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-conversation-'));
  roots.add(root);
  return root;
}

function track(
  unit: SqliteConversationRunHandoffUnitOfWork
): SqliteConversationRunHandoffUnitOfWork {
  units.add(unit);
  return unit;
}

async function closeUnit(unit: SqliteConversationRunHandoffUnitOfWork): Promise<void> {
  const context = createShutdownContext(Date.now() + 5_000);
  try {
    await unit.close(context as ConversationShutdownContext);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('closed')) throw error;
  } finally {
    context.dispose();
  }
}

function at(offsetSeconds: number): string {
  return new Date(Date.UTC(2030, 0, 1, 0, 0, offsetSeconds)).toISOString();
}

function atMilliseconds(offsetMilliseconds: number): string {
  return new Date(Date.UTC(2030, 0, 1, 0, 0, 0) + offsetMilliseconds).toISOString();
}
