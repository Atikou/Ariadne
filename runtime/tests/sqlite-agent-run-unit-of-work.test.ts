import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  AgentRunCommandService,
  AgentRunVersionConflictError,
  digestAgentRunCommand,
  type AgentJsonValue,
  type AgentPersistencePayloadCodec,
  type AgentPersistencePayloadContext,
  type EncodedAgentPersistencePayload,
  type AgentRun,
  type AgentRunCommand,
  type AgentRunCommandCommit,
  type AgentRunCommandResult,
  type AgentRunCommitMutation,
  type AgentRunCommitArtifacts,
  type AgentRunBinding,
  type StartAgentRunCommand
} from '@ariadne/agent-core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  SqliteAgentRunUnitOfWork,
  type AgentPersistenceClock
} from '../src/adapters/persistence/SqliteAgentRunUnitOfWork.js';
import { Sha256AgentEffectInputDigester } from '../src/adapters/persistence/Sha256AgentEffectInputDigester.js';
import { StrictJsonAgentPersistencePayloadCodec } from '../src/adapters/persistence/StrictJsonAgentPersistencePayloadCodec.js';
import { closeOwnedSqliteDatabase } from '../src/adapters/persistence/SqliteOwnerLease.js';
import {
  AGENT_CONTROL_DB_SCHEMA_VERSION,
  AGENT_CONTROL_LEDGER_REVISION,
  openAgentControlDatabase,
  resolveAgentControlDatabasePath
} from '../src/adapters/persistence/agentControlDbSchema.js';
import { DatabaseManager } from '../src/context/DatabaseManager.js';
import { MEMORY_DB_MIGRATIONS } from '../src/context/memoryDbMigrations.js';
import { applySqliteMigrations } from '../src/storage/sqliteMigration.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';

interface TestDatabaseConnection {
  readonly connection: DatabaseSync;
  close(): void;
}

interface AgentControlTestDatabase extends TestDatabaseConnection {
  readonly root: string;
  readonly dbPath: string;
  readonly schemaVersion: number;
}

const openDatabases = new Set<TestDatabaseConnection>();
const openUnitOfWorks = new Set<SqliteAgentRunUnitOfWork>();
const temporaryRoots: string[] = [];
const TEST_TOOL_CATALOG = {
  catalogId: 'tool-catalog-test',
  revision: 1,
  digest: `sha256:${'c'.repeat(64)}`
} as const;
const TEST_TOOL_CONTRACT_DIGEST = `sha256:${'d'.repeat(64)}`;

afterEach(async () => {
  await Promise.all([...openUnitOfWorks].map(closeUnitOfWorkWithDeadline));
  openUnitOfWorks.clear();
  for (const database of openDatabases) database.close();
  openDatabases.clear();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('SqliteAgentRunUnitOfWork', () => {
  it('freezes new work atomically and aborts an accepted transaction before close', async () => {
    const database = createDatabase();
    const unitOfWork = createUnitOfWork(database);
    let transactionStarted!: () => void;
    const started = new Promise<void>((resolve) => { transactionStarted = resolve; });
    const pending = unitOfWork.transaction(async (_transaction, shutdownSignal) => {
      transactionStarted();
      await waitForAbort(shutdownSignal);
    });
    await started;

    const context = createShutdownContext(Date.now() + 5_000);
    try {
      unitOfWork.prepareShutdown(context);
      await expect(unitOfWork.transaction(async () => undefined)).rejects.toThrow(
        'agent_v3_unit_of_work_closed'
      );
      await expect(pending).rejects.toThrow('agent_v3_shutdown_requested');
      await unitOfWork.close(context);
    } finally {
      context.dispose();
    }

    openUnitOfWorks.delete(unitOfWork);
    const reopened = new SqliteAgentRunUnitOfWork(database.root);
    await closeUnitOfWorkWithDeadline(reopened);
  });

  it('commits the permission-gated effect lifecycle and recovers it after reopening agent-control.db', async () => {
    const { database, root } = createDatabase();
    const unitOfWork = createUnitOfWork(database);
    const service = new SqliteTestAgentRunCommandService(unitOfWork);

    const started = await service.execute(startCommand('run-persisted'));
    expect(started.run).toMatchObject({ version: 1, state: { status: 'queued' } });

    const begun = await service.execute({
      kind: 'run.begin',
      commandId: 'command-begin',
      runId: 'run-persisted',
      expectedVersion: 1,
      occurredAt: at(1)
    });
    expect(begun.run).toMatchObject({ version: 2, state: { status: 'running' } });

    const registered = await service.execute({
      kind: 'run.register_effect',
      commandId: 'command-register-effect',
      runId: 'run-persisted',
      expectedVersion: 2,
      occurredAt: at(2),
      effect: {
        effectId: 'effect-write-result',
        toolCallId: 'tool-call-write-result',
        tool: testPinnedTool('workspace.write'),
        idempotencyKey: 'run-persisted:tool-call-write-result',
        capabilityIds: ['workspace.write'],
        scope: ['src/result.ts'],
        inputDigest: testEffectInputDigest('run-persisted', 'effect-write-result')
      }
    });
    expect(registered.run.effects[0]?.state.status).toBe('intended');

    const waiting = await service.execute({
      kind: 'run.request_decision',
      commandId: 'command-request-permission',
      runId: 'run-persisted',
      expectedVersion: 3,
      occurredAt: at(3),
      decision: {
        kind: 'permission',
        decisionId: 'decision-write-result',
        requestedAt: at(3),
        effectId: 'effect-write-result',
        toolCallId: 'tool-call-write-result',
        capabilityIds: ['workspace.write'],
        scope: ['src/result.ts']
      }
    });
    expect(waiting.run.state).toMatchObject({
      status: 'waiting',
      reason: 'tool_permission',
      checkpointVersion: 3
    });

    const resolved = await service.execute({
      kind: 'run.resolve_decision',
      commandId: 'command-resolve-permission',
      runId: 'run-persisted',
      expectedVersion: 4,
      occurredAt: at(4),
      resolution: {
        kind: 'permission',
        decisionId: 'decision-write-result',
        checkpoint: { runId: 'run-persisted', version: 3 },
        resolvedAt: at(4),
        effectId: 'effect-write-result',
        outcome: 'allow_once',
        approvedCapabilityIds: ['workspace.write']
      }
    });
    expect(resolved.run.effects[0]?.state).toMatchObject({
      status: 'authorized',
      decisionId: 'decision-write-result',
      attempt: 1
    });

    const effectStarted = await service.execute({
      kind: 'run.start_effect',
      commandId: 'command-start-effect',
      runId: 'run-persisted',
      expectedVersion: 5,
      occurredAt: at(5),
      effectId: 'effect-write-result'
    });
    expect(effectStarted.run.effects[0]?.state.status).toBe('started');

    const effectCompleted = await service.execute({
      kind: 'run.record_effect_result',
      commandId: 'command-record-effect-result',
      runId: 'run-persisted',
      expectedVersion: 6,
      occurredAt: at(6),
      effectId: 'effect-write-result',
      result: {
        status: 'succeeded',
        outputRef: 'resource:result-file'
      }
    });
    expect(effectCompleted.run.effects[0]?.state.status).toBe('succeeded');

    const completeCommand: AgentRunCommand = {
      kind: 'run.complete',
      commandId: 'command-complete',
      runId: 'run-persisted',
      expectedVersion: 7,
      occurredAt: at(7),
      outputRef: 'resource:final-answer'
    };
    const completed = await service.execute(completeCommand);
    expect(completed.run).toMatchObject({
      version: 8,
      state: {
        status: 'completed',
        outputRef: 'resource:final-answer'
      }
    });

    expect(database.schemaVersion).toBe(AGENT_CONTROL_DB_SCHEMA_VERSION);
    expect(AGENT_CONTROL_LEDGER_REVISION).toBe(49);
    expect(countRows(database, 'agent_v3_runs')).toBe(1);
    expect(countRows(database, 'agent_v3_commands')).toBe(8);
    expect(countRows(database, 'agent_v3_events')).toBe(16);
    expect(countRows(database, 'agent_v3_outbox')).toBe(16);
    expect(countRows(database, 'agent_v3_checkpoints')).toBe(6);
    expect(countRows(database, 'agent_v3_effect_payloads')).toBe(1);
    expect(listUserTables(database)).toEqual([
      'agent_control_metadata',
      'agent_v3_budget_entries',
      'agent_v3_budget_grants',
      'agent_v3_checkpoints',
      'agent_v3_child_terminals',
      'agent_v3_command_runs',
      'agent_v3_commands',
      'agent_v3_delegations',
      'agent_v3_directive_payloads',
      'agent_v3_effect_payloads',
      'agent_v3_events',
      'agent_v3_execution_intents',
      'agent_v3_outbox',
      'agent_v3_plan_approvals',
      'agent_v3_plan_versions',
      'agent_v3_runs',
      'agent_v3_turn_inputs',
      'schema_migrations'
    ]);
    expect(orphanedOutboxRows(database)).toBe(0);
    expect(divergentOutboxRows(database)).toBe(0);
    for (const legacyTable of [
      'run_aggregates',
      'run_states',
      'paused_run_snapshots',
      'permission_requests'
    ]) {
      expect(listUserTables(database), legacyTable).not.toContain(legacyTable);
    }
    expect(() => database.connection.prepare(
      'DELETE FROM agent_v3_runs WHERE run_id=?'
    ).run('run-persisted')).toThrow(/FOREIGN KEY constraint failed/);
    expect(countRows(database, 'agent_v3_commands')).toBe(8);

    await closeUnitOfWork(unitOfWork);
    closeDatabase(database);
    const reopened = openDatabase(root);
    const reopenedUnitOfWork = createUnitOfWork(reopened);
    const restored = await reopenedUnitOfWork.transaction((transaction) =>
      transaction.loadRun('run-persisted')
    );
    expect(restored).toEqual(completed.run);

    const replay = await new SqliteTestAgentRunCommandService(reopenedUnitOfWork)
      .execute(completeCommand);
    expect(replay).toMatchObject({
      replayed: true,
      commandId: 'command-complete',
      run: { version: 8, state: { status: 'completed' } }
    });
    expect(replay.events).toEqual(completed.events);
    expect(countRows(reopened, 'agent_v3_commands')).toBe(8);
    expect(countRows(reopened, 'agent_v3_events')).toBe(16);
    expect(countRows(reopened, 'agent_v3_outbox')).toBe(16);
  });

  it('recovers a queued run after reopening without inventing checkpoint zero', async () => {
    const { database, root } = createDatabase();
    const unitOfWork = createUnitOfWork(database);
    await new AgentRunCommandService(unitOfWork).execute(
      startCommand('run-queued-recovery', 'command-start-queued-recovery'),
      { turnInputPayloads: [], effectPayloads: [] }
    );
    expect(countRows(database, 'agent_v3_checkpoints')).toBe(0);

    await closeUnitOfWork(unitOfWork);
    closeDatabase(database);
    const reopened = openDatabase(root);
    const reopenedUnitOfWork = createUnitOfWork(reopened);
    const recovery = await reopenedUnitOfWork.listActiveRuns();

    expect(recovery).toEqual({
      items: [{
        ready: true,
        phase: 'queued',
        run: expect.objectContaining({
          runId: 'run-queued-recovery',
          version: 1,
          state: expect.objectContaining({ status: 'queued', checkpointVersion: 0 })
        }),
      checkpoint: null,
      turnInputPayloads: [],
      effectPayloads: []
      }]
    });
  });

  it('reuses the latest checkpoint across a verified inbox-only Run advance', async () => {
    const { database } = createDatabase();
    const unitOfWork = createUnitOfWork(database);
    const commands = new SqliteTestAgentRunCommandService(unitOfWork);
    await commands.execute(startCommand('run-inbox-checkpoint', 'command-start-inbox-checkpoint'));
    await commands.execute({
      kind: 'run.begin',
      commandId: 'command-begin-inbox-checkpoint',
      runId: 'run-inbox-checkpoint',
      expectedVersion: 1,
      occurredAt: at(1)
    });
    const inboxCommands = new AgentRunCommandService(unitOfWork);
    await inboxCommands.execute({
      kind: 'run.enqueue_inbox_input',
      commandId: 'command-enqueue-inbox-checkpoint',
      runId: 'run-inbox-checkpoint',
      expectedVersion: 2,
      occurredAt: at(2),
      input: {
        inputId: 'input-inbox-checkpoint',
        messageId: 'message-inbox-checkpoint',
        delivery: 'next_turn',
        content: 'Continue this same Run.',
        contentDigest: `sha256:${'e'.repeat(64)}`
      }
    }, { turnInputPayloads: [], effectPayloads: [] });
    await inboxCommands.execute({
      kind: 'run.replace_inbox_input',
      commandId: 'command-replace-inbox-checkpoint',
      runId: 'run-inbox-checkpoint',
      expectedVersion: 3,
      occurredAt: at(3),
      inputId: 'input-inbox-checkpoint',
      expectedInputVersion: 1,
      content: 'Continue this same Run with the revised constraint.',
      contentDigest: `sha256:${'f'.repeat(64)}`
    }, { turnInputPayloads: [], effectPayloads: [] });

    await expect(unitOfWork.listActiveRuns()).resolves.toMatchObject({
      items: [{
        ready: true,
        phase: 'resumable',
        run: { version: 4, inbox: [{ version: 2, state: 'queued' }] },
        checkpoint: { runVersion: 2, checkpointVersion: 1 }
      }]
    });
  });

  it('rejects an active SQLite transition without a checkpoint and rolls back every row', async () => {
    const { database } = createDatabase();
    const unitOfWork = createUnitOfWork(database);
    const service = new AgentRunCommandService(unitOfWork);
    await service.execute(
      startCommand('run-missing-checkpoint', 'command-start-missing-cp'),
      { turnInputPayloads: [], effectPayloads: [] }
    );
    const before = persistedCounts(database);

    await expect(service.execute({
      kind: 'run.begin',
      commandId: 'command-begin-missing-cp',
      runId: 'run-missing-checkpoint',
      expectedVersion: 1,
      occurredAt: at(1)
    }, { turnInputPayloads: [], effectPayloads: [] })).rejects.toMatchObject({
      code: 'AGENT_RUN_RECOVERY_CONFLICT',
      reason: 'checkpoint_mismatch'
    });
    expect(persistedCounts(database)).toEqual(before);
    await expect(unitOfWork.transaction((transaction) =>
      transaction.loadRun('run-missing-checkpoint')
    )).resolves.toMatchObject({
      version: 1,
      state: { status: 'queued' }
    });
  });

  it('reopens a waiting run through metadata-only scan and just-in-time payload reads', async () => {
    const { database, root } = createDatabase();
    const unitOfWork = createUnitOfWork(database);
    const service = new SqliteTestAgentRunCommandService(unitOfWork);
    await service.execute(startCommand('run-waiting-recovery', 'command-start-waiting'));
    await service.execute({
      kind: 'run.begin',
      commandId: 'command-begin-waiting',
      runId: 'run-waiting-recovery',
      expectedVersion: 1,
      occurredAt: at(1)
    });
    const effectId = 'effect-waiting-recovery';
    await service.execute({
      kind: 'run.register_effect',
      commandId: 'command-register-waiting',
      runId: 'run-waiting-recovery',
      expectedVersion: 2,
      occurredAt: at(2),
      effect: {
        effectId,
        toolCallId: 'tool-call-waiting',
        tool: testPinnedTool('workspace.write'),
        idempotencyKey: 'run-waiting-recovery:tool-call-waiting',
        capabilityIds: ['workspace.write'],
        scope: ['src/result.ts'],
        inputDigest: testEffectInputDigest('run-waiting-recovery', effectId)
      }
    });
    await service.execute({
      kind: 'run.request_decision',
      commandId: 'command-request-waiting',
      runId: 'run-waiting-recovery',
      expectedVersion: 3,
      occurredAt: at(3),
      decision: {
        kind: 'permission',
        decisionId: 'decision-waiting',
        requestedAt: at(3),
        effectId,
        toolCallId: 'tool-call-waiting',
        capabilityIds: ['workspace.write'],
        scope: ['src/result.ts']
      }
    });
    expect(countRows(database, 'agent_v3_checkpoints')).toBe(3);

    await closeUnitOfWork(unitOfWork);
    closeDatabase(database);
    const reopened = openDatabase(root);
    const throwingCodecUnitOfWork = new SqliteAgentRunUnitOfWork(
      reopened.root,
      new ThrowOnDecodePayloadCodec()
    );
    openUnitOfWorks.add(throwingCodecUnitOfWork);
    const metadataOnly = await throwingCodecUnitOfWork.listActiveRuns();
    expect(metadataOnly.items).toHaveLength(1);
    expect(metadataOnly.items[0]).toMatchObject({
      ready: true,
      phase: 'resumable',
      run: { runId: 'run-waiting-recovery', state: { status: 'waiting' } },
      checkpoint: { checkpointVersion: 3, runVersion: 4 },
      effectPayloads: [{ effectId, hasResult: false }]
    });

    const ready = metadataOnly.items[0];
    if (ready?.ready !== true || ready.phase !== 'resumable') {
      throw new Error('expected_resumable_fixture');
    }
    await expect(throwingCodecUnitOfWork.loadCheckpoint(ready.checkpoint))
      .rejects.toThrow(/payload_decode_failed/);

    await closeUnitOfWork(throwingCodecUnitOfWork);
    const reopenedUnitOfWork = createUnitOfWork(reopened);
    const recovery = await reopenedUnitOfWork.listActiveRuns();
    const item = recovery.items[0];
    if (item?.ready !== true || item.phase !== 'resumable') {
      throw new Error('expected_resumable_fixture');
    }
    await expect(reopenedUnitOfWork.loadCheckpoint(item.checkpoint))
      .resolves.toMatchObject({
        runId: 'run-waiting-recovery',
        checkpointVersion: 3,
        payload: {
          format: 'ariadne.agent-checkpoint',
          schemaVersion: 1,
          engineContinuation: { commandId: 'command-request-waiting' }
        }
      });
    await expect(reopenedUnitOfWork.loadEffectInput(item.effectPayloads[0]!))
      .resolves.toMatchObject({
        runId: 'run-waiting-recovery',
        effectId,
        input: testEffectInput(effectId)
      });
    await expect(reopenedUnitOfWork.loadEffectExecutionInput(
      'run-waiting-recovery',
      effectId
    )).resolves.toMatchObject({
      runId: 'run-waiting-recovery',
      effectId,
      inputDigest: testEffectInputDigest('run-waiting-recovery', effectId),
      input: testEffectInput(effectId)
    });
  });

  it('rejects an effect input digest mismatch and rolls back checkpoint, effect, and command', async () => {
    const { database } = createDatabase();
    const unitOfWork = createUnitOfWork(database);
    const service = new SqliteTestAgentRunCommandService(unitOfWork);
    await service.execute(startCommand('run-digest-mismatch', 'command-start-digest'));
    await service.execute({
      kind: 'run.begin',
      commandId: 'command-begin-digest',
      runId: 'run-digest-mismatch',
      expectedVersion: 1,
      occurredAt: at(1)
    });
    const before = persistedCounts(database);

    await expect(service.execute({
      kind: 'run.register_effect',
      commandId: 'command-register-bad-digest',
      runId: 'run-digest-mismatch',
      expectedVersion: 2,
      occurredAt: at(2),
      effect: {
        effectId: 'effect-bad-digest',
        toolCallId: 'tool-call-bad-digest',
        tool: testPinnedTool('workspace.write'),
        idempotencyKey: 'run-digest-mismatch:tool-call-bad-digest',
        capabilityIds: ['workspace.write'],
        scope: ['src/result.ts'],
        inputDigest: `sha256:${'0'.repeat(64)}`
      }
    })).rejects.toMatchObject({
      code: 'AGENT_RUN_RECOVERY_CONFLICT',
      reason: 'effect_digest_mismatch'
    });
    expect(persistedCounts(database)).toEqual(before);
    await expect(unitOfWork.transaction((transaction) =>
      transaction.loadRun('run-digest-mismatch')
    )).resolves.toMatchObject({ version: 2, effects: [] });
  });

  it('replays the same command and artifacts but rejects artifact substitution', async () => {
    const { database } = createDatabase();
    const unitOfWork = createUnitOfWork(database);
    const service = new SqliteTestAgentRunCommandService(unitOfWork);
    await service.execute(startCommand('run-artifact-replay', 'command-start-artifact'));
    await service.execute({
      kind: 'run.begin',
      commandId: 'command-begin-artifact',
      runId: 'run-artifact-replay',
      expectedVersion: 1,
      occurredAt: at(1)
    });
    const effectId = 'effect-artifact-replay';
    const command: AgentRunCommand = {
      kind: 'run.register_effect',
      commandId: 'command-register-artifact',
      runId: 'run-artifact-replay',
      expectedVersion: 2,
      occurredAt: at(2),
      effect: {
        effectId,
        toolCallId: 'tool-call-artifact-replay',
        tool: testPinnedTool('workspace.write'),
        idempotencyKey: 'run-artifact-replay:tool-call',
        capabilityIds: ['workspace.write'],
        scope: ['src/result.ts'],
        inputDigest: testEffectInputDigest('run-artifact-replay', effectId)
      }
    };
    const first = await service.execute(command);
    const counts = persistedCounts(database);
    const replay = await service.execute(command);
    expect(replay.replayed).toBe(true);
    expect(replay.run).toEqual(first.run);
    expect(persistedCounts(database)).toEqual(counts);

    const originalArtifacts = sqliteTestRecoveryArtifacts(command);
    await expect(new AgentRunCommandService(unitOfWork).execute(command, {
      ...originalArtifacts,
      effectPayloads: [{
        kind: 'record_input',
        effectId,
        inputDigest: command.effect.inputDigest,
        input: { substituted: 'different ordinary input' },
        recordedAt: command.occurredAt
      }]
    })).rejects.toMatchObject({
      code: 'AGENT_RUN_COMMAND_CONFLICT',
      reason: 'command_mismatch'
    });
    expect(persistedCounts(database)).toEqual(counts);
  });

  it('rolls back the whole command when the payload codec rejects nested authorization material', async () => {
    const { database } = createDatabase();
    const unitOfWork = createUnitOfWork(database);
    const service = new AgentRunCommandService(unitOfWork);
    await service.execute(
      startCommand('run-sensitive-payload', 'command-start-sensitive'),
      { turnInputPayloads: [], effectPayloads: [] }
    );
    const before = persistedCounts(database);
    const tokenFixture = `sk-${'z'.repeat(24)}`;

    await expect(service.execute({
      kind: 'run.begin',
      commandId: 'command-begin-sensitive',
      runId: 'run-sensitive-payload',
      expectedVersion: 1,
      occurredAt: at(1)
    }, {
      checkpoint: {
        checkpointVersion: 1,
        payload: {
          format: 'ariadne.agent-checkpoint',
          schemaVersion: 1,
          engineContinuation: null,
          modelContext: [{ role: 'user', message: `nested ${tokenFixture}` }]
        },
        createdAt: at(1)
      },
      turnInputPayloads: [],
      effectPayloads: []
    })).rejects.toMatchObject({ code: 'AGENT_PERSISTENCE_PAYLOAD_REJECTED' });
    expect(persistedCounts(database)).toEqual(before);
    const leaked = database.connection.prepare(
      `SELECT COUNT(*) AS count
       FROM agent_v3_checkpoints WHERE payload_json LIKE ?`
    ).get(`%${tokenFixture}%`) as { count: number };
    expect(leaked.count).toBe(0);
  });

  it('rejects a stale persistence version without leaving partial command, event, or outbox rows', async () => {
    const { database } = createDatabase();
    const unitOfWork = createUnitOfWork(database);
    const service = new SqliteTestAgentRunCommandService(unitOfWork);
    await service.execute(startCommand('run-stale'));
    const begun = await service.execute({
      kind: 'run.begin',
      commandId: 'command-begin-stale-run',
      runId: 'run-stale',
      expectedVersion: 1,
      occurredAt: at(1)
    });

    const directStaleCommand: AgentRunCommand = {
      kind: 'run.begin',
      commandId: 'command-direct-stale',
      runId: 'run-stale',
      expectedVersion: 1,
      occurredAt: at(1)
    };
    const directStaleDigest = await digestAgentRunCommand(directStaleCommand);
    const staleEvents = begun.events.map((event) => ({
      ...event,
      eventId: `command-direct-stale:${String(event.sequence)}`,
      commandId: 'command-direct-stale'
    }));
    await expect(unitOfWork.transaction((transaction) =>
      transaction.commitCommand({
        commandId: 'command-direct-stale',
        commandDigest: directStaleDigest,
        mutations: [{
          runId: 'run-stale',
          expectedVersion: 1,
          resultingVersion: 2,
          run: begun.run,
          events: staleEvents,
          artifacts: { turnInputPayloads: [], effectPayloads: [] }
        }]
      })
    )).rejects.toMatchObject({
      code: 'AGENT_RUN_VERSION_CONFLICT',
      expectedVersion: 1,
      actualVersion: 2
    });

    expect(database.connection.isTransaction).toBe(false);
    expect(countRows(database, 'agent_v3_runs')).toBe(1);
    expect(countRows(database, 'agent_v3_commands')).toBe(2);
    expect(countRows(database, 'agent_v3_events')).toBe(3);
    expect(countRows(database, 'agent_v3_outbox')).toBe(3);
    expect(commandCount(database, 'command-direct-stale')).toBe(0);

    await expect(service.execute({
      kind: 'run.cancel',
      commandId: 'command-service-stale',
      runId: 'run-stale',
      expectedVersion: 1,
      occurredAt: at(2),
      reason: 'stale_writer'
    })).rejects.toBeInstanceOf(AgentRunVersionConflictError);
    expect(commandCount(database, 'command-service-stale')).toBe(0);
  });

  it('atomically commits one sorted parent and two child Run mutations', async () => {
    const { database } = createDatabase();
    const unitOfWork = createUnitOfWork(database);
    const commit = multiRunStartCommit('command-parent-and-children');

    await unitOfWork.transaction((transaction) => transaction.commitCommand(commit));

    expect(persistedCounts(database)).toEqual({
      runs: 3,
      commands: 1,
      events: 6,
      outbox: 6,
      checkpoints: 0,
      effectPayloads: 0
    });
    expect(countRows(database, 'agent_v3_command_runs')).toBe(3);
    expect(database.connection.prepare(
      `SELECT run_id, ordinal, expected_version, resulting_version
       FROM agent_v3_command_runs ORDER BY ordinal`
    ).all()).toEqual(commit.mutations.map((mutation, ordinal) => ({
      run_id: mutation.runId,
      ordinal,
      expected_version: null,
      resulting_version: 1
    })));
    expect(database.connection.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    await expect(unitOfWork.loadCommittedCommandReceipt(commit.commandId))
      .resolves.toMatchObject({
        commandId: commit.commandId,
        mutations: commit.mutations.map((mutation) => ({
          runId: mutation.runId,
          resultingVersion: 1,
          run: mutation.run,
          events: mutation.events
        }))
      });
    for (const mutation of commit.mutations) {
      await expect(unitOfWork.loadRunVersion(mutation.runId, 1))
        .resolves.toEqual(mutation.run);
    }

    const begin = multiRunBeginCommit(commit, 'command-begin-parent-and-children');
    await unitOfWork.transaction((transaction) => transaction.commitCommand(begin));
    expect(database.connection.prepare(
      `SELECT command_id, run_id, run_version
       FROM agent_v3_checkpoints ORDER BY run_id`
    ).all()).toEqual(begin.mutations.map((mutation) => ({
      command_id: begin.commandId,
      run_id: mutation.runId,
      run_version: 2
    })));
    expect(countRows(database, 'agent_v3_command_runs')).toBe(6);
    expect(database.connection.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('validates every child before writing and rejects unsorted or duplicate mutation sets', async () => {
    const { database } = createDatabase();
    const unitOfWork = createUnitOfWork(database);
    const service = new SqliteTestAgentRunCommandService(unitOfWork);
    await service.execute(startCommand('run-20-child-b', 'command-existing-child'));
    const before = persistedCounts(database);
    const commit = multiRunStartCommit('command-stale-child');

    await expect(unitOfWork.transaction((transaction) =>
      transaction.commitCommand(commit)
    )).rejects.toMatchObject({
      code: 'AGENT_RUN_VERSION_CONFLICT',
      runId: 'run-20-child-b',
      expectedVersion: null,
      actualVersion: 1
    });
    expect(persistedCounts(database)).toEqual(before);
    expect(countRows(database, 'agent_v3_command_runs')).toBe(1);
    expect(await unitOfWork.loadRunVersion('run-00-parent', 1)).toBeNull();
    expect(await unitOfWork.loadRunVersion('run-10-child-a', 1)).toBeNull();

    const freshRoot = createTemporaryRoot();
    const freshDatabase = openDatabase(freshRoot);
    const freshUnit = createUnitOfWork(freshDatabase);
    const valid = multiRunStartCommit('command-order-validation');
    await expect(freshUnit.transaction((transaction) =>
      transaction.commitCommand({
        ...valid,
        mutations: [...valid.mutations].reverse()
      })
    )).rejects.toThrow(/strict code-unit order/);
    await expect(freshUnit.transaction((transaction) =>
      transaction.commitCommand({
        ...valid,
        mutations: [valid.mutations[0]!, valid.mutations[0]!]
      })
    )).rejects.toThrow(/strict code-unit order/);
    expect(persistedCounts(freshDatabase)).toEqual({
      runs: 0,
      commands: 0,
      events: 0,
      outbox: 0,
      checkpoints: 0,
      effectPayloads: 0
    });
  });

  it('replays an exact multi-Run result and rejects any historical result drift', async () => {
    const { database } = createDatabase();
    const unitOfWork = createUnitOfWork(database);
    const commit = multiRunStartCommit('command-multi-replay');
    await unitOfWork.transaction((transaction) => transaction.commitCommand(commit));
    const before = persistedCounts(database);

    await expect(unitOfWork.transaction((transaction) =>
      transaction.commitCommand(commit)
    )).resolves.toBeUndefined();
    expect(persistedCounts(database)).toEqual(before);

    const child = commit.mutations[1]!;
    const driftedRun: AgentRun = { ...child.run, updatedAt: at(1) };
    const drifted: AgentRunCommandCommit = {
      ...commit,
      mutations: commit.mutations.map((mutation) =>
        mutation.runId === child.runId
          ? { ...mutation, run: driftedRun }
          : mutation
      )
    };
    await expect(unitOfWork.transaction((transaction) =>
      transaction.commitCommand(drifted)
    )).rejects.toMatchObject({
      code: 'AGENT_RUN_COMMAND_CONFLICT',
      reason: 'command_mismatch'
    });
    expect(persistedCounts(database)).toEqual(before);
  });

  it('rolls back every Run when a later child outbox write is killed', async () => {
    const { database } = createDatabase();
    const unitOfWork = createUnitOfWork(database);
    database.connection.exec(`
      CREATE TRIGGER reject_agent_v3_child_outbox
      BEFORE INSERT ON agent_v3_outbox
      WHEN NEW.aggregate_id = 'run-20-child-b'
      BEGIN
        SELECT RAISE(ABORT, 'kill_during_child_outbox');
      END;
    `);
    await expect(unitOfWork.transaction((transaction) =>
      transaction.commitCommand(multiRunStartCommit('command-killed-multi'))
    )).rejects.toThrow(/kill_during_child_outbox/);
    expect(database.connection.isTransaction).toBe(false);
    expect(persistedCounts(database)).toEqual({
      runs: 0,
      commands: 0,
      events: 0,
      outbox: 0,
      checkpoints: 0,
      effectPayloads: 0
    });
    expect(countRows(database, 'agent_v3_command_runs')).toBe(0);
  });

  it('replays a stable commandId without a second aggregate, event, or outbox write', async () => {
    const { database } = createDatabase();
    const unitOfWork = createUnitOfWork(database);
    const service = new SqliteTestAgentRunCommandService(unitOfWork);
    const secondService = new SqliteTestAgentRunCommandService(unitOfWork);
    const command = startCommand('run-idempotent', 'stable-command-id');

    const results = await Promise.all([
      service.execute(command),
      secondService.execute(command)
    ]);
    const first = results.find((result) => !result.replayed)!;
    const replay = results.find((result) => result.replayed)!;
    const countsAfterFirst = persistedCounts(database);

    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.run).toEqual(first.run);
    expect(replay.events).toEqual(first.events);
    expect(persistedCounts(database)).toEqual(countsAfterFirst);
    expect(persistedCommandDigest(database, 'stable-command-id'))
      .toMatch(/^sha256:[0-9a-f]{64}$/u);

    await expect(service.execute({
      ...command,
      binding: {
        ...command.binding,
        objectiveRef: {
          kind: 'conversation_message',
          messageId: 'message-different-command',
          messageVersion: command.binding.objectiveRef.kind === 'conversation_message'
            ? command.binding.objectiveRef.messageVersion
            : 1,
          contentDigest: command.binding.objectiveRef.kind === 'conversation_message'
            ? command.binding.objectiveRef.contentDigest
            : `sha256:${'e'.repeat(64)}`
        }
      }
    })).rejects.toMatchObject({
      code: 'AGENT_RUN_COMMAND_CONFLICT',
      reason: 'command_mismatch'
    });
    expect(persistedCounts(database)).toEqual(countsAfterFirst);

    await expect(service.execute(
      startCommand('different-run', 'stable-command-id')
    )).rejects.toMatchObject({
      code: 'AGENT_RUN_COMMAND_CONFLICT',
      reason: 'run_mismatch'
    });
    expect(persistedCounts(database)).toEqual(countsAfterFirst);
  });

  it('rolls back the aggregate, command, and event when the outbox insert fails', async () => {
    const { database } = createDatabase();
    const unitOfWork = createUnitOfWork(database);
    const service = new SqliteTestAgentRunCommandService(unitOfWork);
    await service.execute(startCommand('run-atomic'));
    const initialCounts = persistedCounts(database);

    database.connection.exec(`
      CREATE TRIGGER reject_agent_v3_outbox
      BEFORE INSERT ON agent_v3_outbox
      WHEN NEW.aggregate_version = 2
      BEGIN
        SELECT RAISE(ABORT, 'forced_outbox_failure');
      END;
    `);
    const beginCommand: AgentRunCommand = {
      kind: 'run.begin',
      commandId: 'command-atomic-begin',
      runId: 'run-atomic',
      expectedVersion: 1,
      occurredAt: at(1)
    };

    await expect(service.execute(beginCommand)).rejects.toThrow(
      /forced_outbox_failure/
    );
    expect(database.connection.isTransaction).toBe(false);
    expect(persistedCounts(database)).toEqual(initialCounts);
    expect(commandCount(database, 'command-atomic-begin')).toBe(0);
    const rolledBackRun = await unitOfWork.transaction((transaction) =>
      transaction.loadRun('run-atomic')
    );
    expect(rolledBackRun?.version).toBe(1);

    database.connection.exec('DROP TRIGGER reject_agent_v3_outbox');
    const begun = await service.execute(beginCommand);
    expect(begun.run).toMatchObject({
      version: 2,
      state: { status: 'running' }
    });
  });

  it('fails closed for a second UoW owner and reopens only after close', async () => {
    const { database } = createDatabase();
    const first = createUnitOfWork(database);
    const firstService = new SqliteTestAgentRunCommandService(first);
    await firstService.execute(startCommand('run-concurrent'));
    expect(() => new SqliteAgentRunUnitOfWork(database.root))
      .toThrow(/sqlite_owner_lease_unavailable:agent-control/);

    await closeUnitOfWork(first);
    const reopened = createUnitOfWork(database);
    await expect(reopened.transaction((transaction) =>
      transaction.loadRun('run-concurrent')
    )).resolves.toMatchObject({ runId: 'run-concurrent', version: 1 });
  });

  it('claims outbox rows without overlap and publishes with exact durable receipts', async () => {
    const { database } = createDatabase();
    const clock = new MutableClock(at(20));
    const first = createUnitOfWorkWithClock(database, clock);
    const second = first;
    const service = new SqliteTestAgentRunCommandService(first);
    await service.execute(startCommand('run-outbox-a', 'command-start-outbox-a'));
    await service.execute(startCommand('run-outbox-b', 'command-start-outbox-b'));
    expect(countRows(database, 'agent_v3_outbox')).toBe(4);

    const claimA = await first.claimPending({
      claimId: 'claim-a',
      leaseMs: 60_000,
      limit: 1
    });
    expect(claimA).toHaveLength(1);
    const publishA = {
      claimId: 'claim-a',
      messages: claimA.map(({ cursor, eventId }) => ({ cursor, eventId }))
    };
    await first.markPublished(publishA);
    await first.markPublished(publishA);
    await expect(first.claimPending({
      claimId: 'claim-a',
      leaseMs: 60_000,
      limit: 1
    })).resolves.toEqual([]);

    const [claimB, claimC] = await Promise.all([
      first.claimPending({ claimId: 'claim-b', leaseMs: 60_000, limit: 1 }),
      second.claimPending({ claimId: 'claim-c', leaseMs: 60_000, limit: 1 })
    ]);
    expect(claimB).toHaveLength(1);
    expect(claimC).toHaveLength(1);
    expect(claimB[0]?.eventId).not.toBe(claimC[0]?.eventId);

    const publishedBeforeMixedBatch = publishedOutboxCount(database);
    await expect(first.markPublished({
      claimId: 'claim-b',
      messages: [
        { cursor: claimB[0]!.cursor, eventId: claimB[0]!.eventId },
        { cursor: claimC[0]!.cursor, eventId: claimC[0]!.eventId }
      ]
    })).rejects.toMatchObject({ code: 'AGENT_RUN_OUTBOX_CLAIM_CONFLICT' });
    expect(publishedOutboxCount(database)).toBe(publishedBeforeMixedBatch);

    await first.markPublished({
      claimId: 'claim-b',
      messages: [{ cursor: claimB[0]!.cursor, eventId: claimB[0]!.eventId }]
    });
    clock.advance(60_001);
    await expect(second.markPublished({
      claimId: 'claim-c',
      messages: [{ cursor: claimC[0]!.cursor, eventId: claimC[0]!.eventId }]
    })).rejects.toMatchObject({ code: 'AGENT_RUN_OUTBOX_CLAIM_CONFLICT' });
    const reclaimed = await first.claimPending({
      claimId: 'claim-d',
      leaseMs: 60_000,
      limit: 1
    });
    expect(reclaimed).toMatchObject([{
      eventId: claimC[0]!.eventId,
      publishAttempts: 2
    }]);
  });

  it('starts and validates outbox leases only after the queued transaction begins', async () => {
    const { database } = createDatabase();
    const clock = new MutableClock(at(20));
    const unitOfWork = createUnitOfWorkWithClock(database, clock);
    await new SqliteTestAgentRunCommandService(unitOfWork).execute(
      startCommand('run-outbox-lease-clock', 'command-outbox-lease-clock')
    );

    let releaseClaim!: () => void;
    let markClaimBlockerEntered!: () => void;
    const claimBlocker = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    const claimBlockerEntered = new Promise<void>((resolve) => {
      markClaimBlockerEntered = resolve;
    });
    const holdingClaim = unitOfWork.transaction(async () => {
      markClaimBlockerEntered();
      await claimBlocker;
    });
    await claimBlockerEntered;

    const queuedClaim = unitOfWork.claimPending({
      claimId: 'claim-after-queue',
      leaseMs: 60_000,
      limit: 1
    });
    clock.advance(120_000);
    releaseClaim();
    await holdingClaim;
    const claim = await queuedClaim;
    expect(claim).toHaveLength(1);
    expect(claim[0]?.leaseExpiresAt).toBe(at(200));

    let releasePublish!: () => void;
    let markPublishBlockerEntered!: () => void;
    const publishBlocker = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    const publishBlockerEntered = new Promise<void>((resolve) => {
      markPublishBlockerEntered = resolve;
    });
    const holdingPublish = unitOfWork.transaction(async () => {
      markPublishBlockerEntered();
      await publishBlocker;
    });
    await publishBlockerEntered;

    const queuedPublish = unitOfWork.markPublished({
      claimId: 'claim-after-queue',
      messages: claim.map(({ cursor, eventId }) => ({ cursor, eventId }))
    });
    const rejectedPublish = expect(queuedPublish).rejects.toMatchObject({
      code: 'AGENT_RUN_OUTBOX_CLAIM_CONFLICT'
    });
    clock.advance(60_001);
    releasePublish();
    await holdingPublish;
    await rejectedPublish;
    expect(publishedOutboxCount(database)).toBe(0);
  });

  it('fails closed when outbox JSON diverges from or corrupts its canonical event', async () => {
    const { database } = createDatabase();
    const unitOfWork = createUnitOfWork(database);
    await new SqliteTestAgentRunCommandService(unitOfWork).execute(
      startCommand('run-outbox-integrity', 'command-outbox-integrity')
    );
    const row = database.connection.prepare(
      `SELECT cursor, event_id, event_json
       FROM agent_v3_outbox ORDER BY cursor LIMIT 1`
    ).get() as { cursor: number; event_id: string; event_json: string };
    const forged = JSON.parse(row.event_json) as Record<string, unknown>;
    forged.commandId = 'forged-command';
    forged.sequence = 999;
    forged.occurredAt = 'not-a-timestamp';
    forged.payload = { type: 'forged.event' };
    const forgedJson = JSON.stringify(forged);

    database.connection.prepare(
      'UPDATE agent_v3_outbox SET event_json=? WHERE cursor=?'
    ).run(forgedJson, row.cursor);
    await expect(unitOfWork.claimPending({
      claimId: 'claim-divergent-event',
      leaseMs: 60_000,
      limit: 1
    })).rejects.toThrow(/event_diverged/);

    database.connection.prepare(
      'UPDATE agent_v3_events SET event_json=? WHERE event_id=?'
    ).run(forgedJson, row.event_id);
    await expect(unitOfWork.claimPending({
      claimId: 'claim-corrupt-canonical-event',
      leaseMs: 60_000,
      limit: 1
    })).rejects.toThrow(/metadata_mismatch/);
  });

  it('fails closed when active recovery index metadata diverges from the aggregate', async () => {
    const { database } = createDatabase();
    const unitOfWork = createUnitOfWork(database);
    await new AgentRunCommandService(unitOfWork).execute(
      startCommand('run-recovery-metadata', 'command-recovery-metadata'),
      { turnInputPayloads: [], effectPayloads: [] }
    );

    database.connection.prepare(
      `UPDATE agent_v3_runs SET state_status='completed' WHERE run_id=?`
    ).run('run-recovery-metadata');
    await expect(unitOfWork.listActiveRuns())
      .rejects.toThrow(/recovery_metadata_mismatch/);

    database.connection.prepare(
      `UPDATE agent_v3_runs SET state_status='queued', created_at=? WHERE run_id=?`
    ).run(at(99), 'run-recovery-metadata');
    await expect(unitOfWork.listActiveRuns())
      .rejects.toThrow(/recovery_metadata_mismatch/);
  });

  it('owns a physically isolated database containing only Agent Control schema', async () => {
    const root = createTemporaryRoot();
    const memoryPath = path.join(root, 'data', 'agent_data', 'memory.db');
    const memory = new DatabaseManager(path.join(root, 'data'));
    memory.connection.exec(`
      CREATE TABLE owner_fencing_sentinel (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO owner_fencing_sentinel(id, value)
      VALUES ('memory-owner', 'must-not-change');
    `);
    memory.close();
    const memoryBefore = readDatabaseSnapshot(memoryPath);

    const unitOfWork = new SqliteAgentRunUnitOfWork(root);
    openUnitOfWorks.add(unitOfWork);
    expect(readUnitOfWorkPragmas(unitOfWork)).toEqual({
      foreignKeys: 1,
      busyTimeout: 0,
      journalMode: 'wal',
      synchronous: 2
    });
    await new AgentRunCommandService(unitOfWork).execute(
      startCommand('run-physical-isolation', 'command-physical-isolation'),
      { turnInputPayloads: [], effectPayloads: [] }
    );
    expect(readDatabaseSnapshot(memoryPath)).toEqual(memoryBefore);

    const control = openDatabase(root);
    expect(control.dbPath).toBe(resolveAgentControlDatabasePath(root));
    expect(control.dbPath).not.toBe(memoryPath);
    expect((control.connection.prepare('PRAGMA journal_mode').get() as {
      journal_mode: string;
    }).journal_mode).toBe('wal');
    expect((control.connection.prepare('PRAGMA synchronous').get() as {
      synchronous: number;
    }).synchronous).toBe(2);
    expect(listUserTables(control)).toEqual([
      'agent_control_metadata',
      'agent_v3_budget_entries',
      'agent_v3_budget_grants',
      'agent_v3_checkpoints',
      'agent_v3_child_terminals',
      'agent_v3_command_runs',
      'agent_v3_commands',
      'agent_v3_delegations',
      'agent_v3_directive_payloads',
      'agent_v3_effect_payloads',
      'agent_v3_events',
      'agent_v3_execution_intents',
      'agent_v3_outbox',
      'agent_v3_plan_approvals',
      'agent_v3_plan_versions',
      'agent_v3_runs',
      'agent_v3_turn_inputs',
      'schema_migrations'
    ]);
    expect(countRows(control, 'agent_v3_runs')).toBe(1);
    for (const forbidden of [
      'runtime_commands', 'sessions', 'messages', 'conversation_summaries'
    ]) {
      expect(listUserTables(control)).not.toContain(forbidden);
    }

    expect(readDatabaseSnapshot(memoryPath)).toEqual(memoryBefore);
  });

  it('creates the authoritative schema-v5/ledger-v49 format on a pristine file and reopens it', () => {
    const root = createTemporaryRoot();
    const first = openAgentControlDatabase(root);
    try {
      expect(readUserVersion(first.database)).toBe(5);
      expect(first.database.prepare(
        'SELECT version, name FROM schema_migrations ORDER BY version'
      ).all()).toEqual([{
        version: 4,
        name: 'agent_control_v3_execution_intent_ledger'
      }, {
        version: 5,
        name: 'agent_control_v3_protected_turn_inputs'
      }]);
    } finally {
      closeOwnedSqliteDatabase(first.database, first.ownerLease);
    }

    const beforeReopen = readAgentControlSchemaSnapshot(
      resolveAgentControlDatabasePath(root)
    );
    const reopened = openAgentControlDatabase(root);
    try {
      expect(readUserVersion(reopened.database)).toBe(AGENT_CONTROL_DB_SCHEMA_VERSION);
      expect(reopened.database.prepare(
        'SELECT version, name, applied_at FROM schema_migrations ORDER BY version'
      ).all()).toEqual(beforeReopen.migrations);
    } finally {
      closeOwnedSqliteDatabase(reopened.database, reopened.ownerLease);
    }
    expect(readAgentControlSchemaSnapshot(resolveAgentControlDatabasePath(root)))
      .toEqual(beforeReopen);
  });

  it('rejects an empty schema-v4 store and leaves it byte-for-byte logically unchanged', () => {
    const root = createTemporaryRoot();
    const initialized = openAgentControlDatabase(root);
    closeOwnedSqliteDatabase(initialized.database, initialized.ownerLease);
    const databasePath = resolveAgentControlDatabasePath(root);
    const legacy = new DatabaseSync(databasePath);
    legacy.exec('BEGIN IMMEDIATE;');
    try {
      legacy.exec(`
        DROP INDEX idx_agent_v3_turn_inputs_command;
        DROP TABLE agent_v3_turn_inputs;
        DELETE FROM schema_migrations WHERE version=5;
        PRAGMA user_version = 4;
        COMMIT;
      `);
    } catch (error) {
      if (legacy.isTransaction) legacy.exec('ROLLBACK;');
      throw error;
    } finally {
      legacy.close();
    }

    const before = readAgentControlSchemaSnapshot(databasePath);
    expect(before.userVersion).toBe(4);
    expect(Object.values(before.rows).every((rows) => rows.length === 0)).toBe(true);

    expect(() => new SqliteAgentRunUnitOfWork(root)).toThrow(
      'agent_control_offline_migration_required:agent_control_schema:4:5'
    );
    expect(readAgentControlSchemaSnapshot(databasePath)).toEqual(before);
  });

  it('rejects legacy aggregate JSON at the SQL boundary without partial rows', () => {
    const { database } = createDatabase();
    const insertRun = database.connection.prepare(
      `INSERT INTO agent_v3_runs (
         run_id, version, state_status, aggregate_json, created_at, updated_at
       ) VALUES (?, 1, 'queued', ?, ?, ?)`
    );
    const legacyRunJson = JSON.stringify({
      binding: {},
      effects: []
    });
    expect(() => insertRun.run(
      'legacy-shape',
      legacyRunJson,
      at(0),
      at(0)
    )).toThrow(/constraint failed/i);
    expect(countRows(database, 'agent_v3_runs')).toBe(0);

    const v2RunJson = JSON.stringify({
      binding: {
        toolCatalog: {
          catalogId: 'test-catalog',
          revision: 1,
          digest: `sha256:${'b'.repeat(64)}`
        }
      },
      turns: []
    });
    insertRun.run('v2-shape', v2RunJson, at(0), at(0));
    database.connection.prepare(
      `INSERT INTO agent_v3_commands (
         command_id, command_digest, mutation_count, committed_at
       ) VALUES (?, ?, 1, ?)`
    ).run(
      'legacy-result-command',
      `sha256:${'a'.repeat(64)}`,
      at(0)
    );
    expect(() => database.connection.prepare(
      `INSERT INTO agent_v3_command_runs (
         command_id, run_id, ordinal, expected_version,
         resulting_version, result_run_json
       ) VALUES (?, ?, 0, NULL, 1, ?)`
    ).run(
      'legacy-result-command',
      'v2-shape',
      legacyRunJson
    )).toThrow(/constraint failed/i);
    expect(countRows(database, 'agent_v3_command_runs')).toBe(0);
  });

  it('blocks a populated v1 aggregate before reads and leaves the old store unchanged', () => {
    const root = createTemporaryRoot();
    const initialized = openAgentControlDatabase(root);
    closeOwnedSqliteDatabase(initialized.database, initialized.ownerLease);
    const databasePath = resolveAgentControlDatabasePath(root);
    const legacy = new DatabaseSync(databasePath);
    legacy.exec('PRAGMA ignore_check_constraints = ON; BEGIN IMMEDIATE;');
    try {
      legacy.prepare(
         `UPDATE schema_migrations
         SET version=1, name='agent_control_v44_ledger'
         WHERE version=?`
      ).run(AGENT_CONTROL_DB_SCHEMA_VERSION);
      legacy.prepare(
        `INSERT INTO agent_v3_runs (
           run_id, version, state_status, aggregate_json, created_at, updated_at
         ) VALUES (?, 1, 'queued', ?, ?, ?)`
      ).run(
        'legacy-v1-run',
        JSON.stringify({
          runId: 'legacy-v1-run',
          version: 1,
          binding: {
            sessionId: 'legacy-session',
            objectiveRef: {
              kind: 'conversation_message',
              messageId: 'legacy-message'
            },
            workspace: { workspaceId: 'legacy-workspace', access: 'write' },
            model: {
              providerId: 'legacy-provider',
              modelId: 'legacy-model',
              settingsRevision: 1
            },
            policy: {
              policyId: 'legacy-policy',
              revision: 1,
              permissionMode: 'ask',
              maxTurns: 12,
              maxToolCalls: 8
            }
          },
          state: { status: 'queued', checkpointVersion: 0, queuedAt: at(0) },
          effects: [],
          createdAt: at(0),
          updatedAt: at(0)
        }),
        at(0),
        at(0)
      );
      legacy.exec('PRAGMA user_version = 1; COMMIT;');
    } catch (error) {
      if (legacy.isTransaction) legacy.exec('ROLLBACK');
      throw error;
    } finally {
      legacy.close();
    }
    const before = readAgentControlSchemaSnapshot(databasePath);

    expect(() => new SqliteAgentRunUnitOfWork(root)).toThrow(
      'agent_control_offline_migration_required:agent_control_schema:1:5'
    );

    expect(readAgentControlSchemaSnapshot(databasePath)).toEqual(before);
  });

  it('fails closed on a populated schema v2 database and requires offline migration', () => {
    const root = createTemporaryRoot();
    const databasePath = resolveAgentControlDatabasePath(root);
    mkdirSync(path.dirname(databasePath), { recursive: true });
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE agent_v2_runs (
        run_id TEXT PRIMARY KEY,
        aggregate_json TEXT NOT NULL
      );
      INSERT INTO agent_v2_runs(run_id, aggregate_json)
      VALUES ('v2-sentinel', '{"preserve":true}');
      PRAGMA user_version = 2;
    `);
    const before = legacy.prepare(
      'SELECT run_id, aggregate_json FROM agent_v2_runs ORDER BY run_id'
    ).all();
    legacy.close();

    expect(() => new SqliteAgentRunUnitOfWork(root)).toThrow(
      'agent_control_offline_migration_required:agent_control_schema:2:5'
    );

    const unchanged = new DatabaseSync(databasePath, { readOnly: true });
    expect(readUserVersion(unchanged)).toBe(2);
    expect(unchanged.prepare(
      'SELECT run_id, aggregate_json FROM agent_v2_runs ORDER BY run_id'
    ).all()).toEqual(before);
    expect(unchanged.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
    ).all()).toEqual([{ name: 'agent_v2_runs' }]);
    unchanged.close();
  });

  it('blocks a newer nonempty format without schema, audit, or row mutation', () => {
    const root = createTemporaryRoot();
    const initialized = openAgentControlDatabase(root);
    closeOwnedSqliteDatabase(initialized.database, initialized.ownerLease);
    const databasePath = resolveAgentControlDatabasePath(root);
    const future = new DatabaseSync(databasePath);
    future.exec('BEGIN IMMEDIATE;');
    try {
      future.prepare(
        `UPDATE schema_migrations
         SET version=?, name='future_agent_control_ledger'
         WHERE version=?`
      ).run(
        AGENT_CONTROL_DB_SCHEMA_VERSION + 1,
        AGENT_CONTROL_DB_SCHEMA_VERSION
      );
      future.prepare(
        `INSERT INTO agent_control_metadata(key, value, updated_at)
         VALUES ('keyring_generation', 'future-sentinel', ?)`
      ).run(at(0));
      future.exec(
        `PRAGMA user_version = ${String(AGENT_CONTROL_DB_SCHEMA_VERSION + 1)}; COMMIT;`
      );
    } catch (error) {
      if (future.isTransaction) future.exec('ROLLBACK');
      throw error;
    } finally {
      future.close();
    }
    const before = readAgentControlSchemaSnapshot(databasePath);

    expect(() => new SqliteAgentRunUnitOfWork(root)).toThrow(
      `agent_control_schema_newer_than_runtime:${String(
        AGENT_CONTROL_DB_SCHEMA_VERSION + 1
      )}:${String(AGENT_CONTROL_DB_SCHEMA_VERSION)}`
    );

    expect(readAgentControlSchemaSnapshot(databasePath)).toEqual(before);
  });

  it('fails closed for unversioned and structurally divergent stores', () => {
    const unversionedRoot = createTemporaryRoot();
    const unversionedPath = resolveAgentControlDatabasePath(unversionedRoot);
    mkdirSync(path.dirname(unversionedPath), { recursive: true });
    const unversioned = new DatabaseSync(unversionedPath);
    unversioned.exec('CREATE TABLE legacy_agent_runs (id TEXT PRIMARY KEY);');
    unversioned.close();
    expect(() => new SqliteAgentRunUnitOfWork(unversionedRoot))
      .toThrow(/agent_control_unversioned_schema_not_empty/);

    const divergentRoot = createTemporaryRoot();
    const divergentPath = resolveAgentControlDatabasePath(divergentRoot);
    mkdirSync(path.dirname(divergentPath), { recursive: true });
    const divergent = new DatabaseSync(divergentPath);
    divergent.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER NOT NULL PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      PRAGMA user_version = ${AGENT_CONTROL_DB_SCHEMA_VERSION};
    `);
    divergent.close();
    expect(() => new SqliteAgentRunUnitOfWork(divergentRoot))
      .toThrow(/agent_control_schema_definition_mismatch/);
  });

  it('does not mutate an unversioned database containing only an alien view', () => {
    const root = createTemporaryRoot();
    const databasePath = resolveAgentControlDatabasePath(root);
    mkdirSync(path.dirname(databasePath), { recursive: true });
    const alien = new DatabaseSync(databasePath);
    alien.exec('CREATE VIEW alien_view AS SELECT 1 AS value;');
    const beforeObjects = alien.prepare(
      `SELECT type, name, sql FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`
    ).all();
    expect(readUserVersion(alien)).toBe(0);
    alien.close();
    const beforeBytes = readFileSync(databasePath);

    expect(() => new SqliteAgentRunUnitOfWork(root))
      .toThrow(/agent_control_unversioned_schema_not_empty:view:alien_view/);

    expect(readFileSync(databasePath)).toEqual(beforeBytes);
    const reopened = new DatabaseSync(databasePath);
    expect(readUserVersion(reopened)).toBe(0);
    expect(reopened.prepare(
      `SELECT type, name, sql FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`
    ).all()).toEqual(beforeObjects);
    reopened.close();

    const repaired = new DatabaseSync(databasePath);
    repaired.exec('DROP VIEW alien_view;');
    repaired.close();
    const recoveredOwner = new SqliteAgentRunUnitOfWork(root);
    openUnitOfWorks.add(recoveredOwner);
    expect(readUnitOfWorkPragmas(recoveredOwner).journalMode).toBe('wal');
  });

  it('rejects altered constraints, forged indexes, views, and triggers at the same version', () => {
    const indexRoot = createTemporaryRoot();
    const indexDatabase = openDatabase(indexRoot);
    closeDatabase(indexDatabase);
    const alteredIndex = new DatabaseSync(resolveAgentControlDatabasePath(indexRoot));
    alteredIndex.exec(`
      DROP INDEX idx_agent_v3_runs_status;
      CREATE INDEX idx_agent_v3_runs_status ON agent_v3_runs(updated_at);
    `);
    alteredIndex.close();
    expect(() => new SqliteAgentRunUnitOfWork(indexRoot))
      .toThrow(/agent_control_schema_definition_mismatch/);

    const constraintRoot = createTemporaryRoot();
    const constraintDatabase = openDatabase(constraintRoot);
    closeDatabase(constraintDatabase);
    const alteredConstraint = new DatabaseSync(
      resolveAgentControlDatabasePath(constraintRoot)
    );
    alteredConstraint.exec(`
      PRAGMA foreign_keys = OFF;
      PRAGMA legacy_alter_table = ON;
      ALTER TABLE agent_v3_runs RENAME TO agent_v3_runs_original;
      DROP TABLE agent_v3_runs_original;
      CREATE TABLE agent_v3_runs (
        run_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK(version >= 0),
        state_status TEXT NOT NULL CHECK(state_status IN (
          'queued', 'running', 'waiting', 'recovering',
          'completed', 'failed', 'cancelled'
        )),
        aggregate_json TEXT NOT NULL CHECK(json_valid(aggregate_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_agent_v3_runs_status
        ON agent_v3_runs(state_status, updated_at DESC);
      CREATE INDEX idx_agent_v3_runs_recovery
        ON agent_v3_runs(created_at, run_id)
        WHERE state_status IN ('queued', 'running', 'waiting', 'recovering');
    `);
    alteredConstraint.close();
    expect(() => new SqliteAgentRunUnitOfWork(constraintRoot))
      .toThrow(/agent_control_schema_definition_mismatch/);

    const foreignObjectRoot = createTemporaryRoot();
    const foreignObjectDatabase = openDatabase(foreignObjectRoot);
    closeDatabase(foreignObjectDatabase);
    const foreignObjects = new DatabaseSync(
      resolveAgentControlDatabasePath(foreignObjectRoot)
    );
    foreignObjects.exec(`
      CREATE VIEW agent_run_ids AS SELECT run_id FROM agent_v3_runs;
      CREATE TRIGGER unexpected_agent_trigger
      AFTER INSERT ON agent_control_metadata
      BEGIN
        SELECT 1;
      END;
    `);
    foreignObjects.close();
    expect(() => new SqliteAgentRunUnitOfWork(foreignObjectRoot))
      .toThrow(/agent_control_schema_definition_mismatch/);
  });

  it('atomically initializes and verifies the keyring anchor after reopening', async () => {
    const { database, root } = createDatabase();
    const unitOfWork = createUnitOfWork(database);
    const request = keyringAnchorRequest(7, 'key-7', ['key-7', 'key-6']);
    await Promise.all([
      unitOfWork.verifyOrInitializeKeyringAnchor(request),
      unitOfWork.verifyOrInitializeKeyringAnchor(request)
    ]);
    expect(database.connection.prepare(
      'SELECT key, value FROM agent_control_metadata ORDER BY key'
    ).all()).toEqual([
      { key: 'active_key_id', value: 'key-7' },
      { key: 'keyring_generation', value: '7' }
    ]);

    await closeUnitOfWork(unitOfWork);
    closeDatabase(database);
    const reopened = openDatabase(root);
    const reopenedUnitOfWork = createUnitOfWork(reopened);
    await expect(reopenedUnitOfWork.verifyOrInitializeKeyringAnchor(request))
      .resolves.toBeUndefined();
  });

  it('rejects rollback, uncommitted rotation, active-key mismatch, and partial anchors', async () => {
    const { database } = createDatabase();
    const unitOfWork = createUnitOfWork(database);
    await unitOfWork.verifyOrInitializeKeyringAnchor(
      keyringAnchorRequest(7, 'key-7', ['key-7', 'key-6'])
    );
    await expect(unitOfWork.verifyOrInitializeKeyringAnchor(
      keyringAnchorRequest(6, 'key-7', ['key-7'])
    )).rejects.toThrow(/agent_keyring_anchor_rollback/);
    await expect(unitOfWork.verifyOrInitializeKeyringAnchor(
      keyringAnchorRequest(8, 'key-8', ['key-8', 'key-7'])
    )).rejects.toThrow(/agent_keyring_anchor_rotation_not_committed/);
    await expect(unitOfWork.verifyOrInitializeKeyringAnchor(
      keyringAnchorRequest(7, 'other-key', ['other-key', 'key-7'])
    )).rejects.toThrow(/agent_keyring_anchor_active_key_mismatch/);

    const partialRoot = createTemporaryRoot();
    const partialDatabase = openDatabase(partialRoot);
    partialDatabase.connection.prepare(
      `INSERT INTO agent_control_metadata(key, value, updated_at)
       VALUES ('keyring_generation', '7', ?)`
    ).run(at(0));
    const partialUnitOfWork = createUnitOfWork(partialDatabase);
    await expect(partialUnitOfWork.verifyOrInitializeKeyringAnchor(
      keyringAnchorRequest(7, 'key-7', ['key-7'])
    )).rejects.toThrow(/agent_keyring_anchor_partial/);
  });

  it('does not initialize an anchor after authoritative Agent rows exist', async () => {
    const { database } = createDatabase();
    const unitOfWork = createUnitOfWork(database);
    await new AgentRunCommandService(unitOfWork).execute(
      startCommand('run-before-anchor', 'command-before-anchor'),
      { turnInputPayloads: [], effectPayloads: [] }
    );
    await expect(unitOfWork.verifyOrInitializeKeyringAnchor(
      keyringAnchorRequest(1, 'active', ['active'])
    )).rejects.toThrow(/agent_keyring_anchor_missing_nonempty_store/);
    expect(countRows(database, 'agent_control_metadata')).toBe(0);
  });

  it('fails closed for unknown, malformed, or plaintext recovery payload keys', async () => {
    for (const fixture of [
      {
        label: 'unknown key',
        target: 'result',
        codecId: 'aes-256-gcm-v1',
        payload: { keyId: 'retired' },
        expected: /agent_keyring_anchor_unknown_payload_key/
      },
      {
        label: 'malformed envelope',
        target: 'input',
        codecId: 'aes-256-gcm-v1',
        payload: { keyId: 17 },
        expected: /agent_keyring_anchor_malformed_envelope/
      },
      {
        label: 'plaintext codec',
        target: 'input',
        codecId: 'strict-json-v1',
        payload: { keyId: 'active' },
        expected: /agent_keyring_anchor_codec_mismatch/
      }
    ] as const) {
      const root = createTemporaryRoot();
      const database = openDatabase(root);
      const unitOfWork = createUnitOfWork(database);
      await unitOfWork.verifyOrInitializeKeyringAnchor(
        keyringAnchorRequest(1, 'active', ['active'])
      );
      insertProtectedRecoveryFixture(
        database,
        fixture.target,
        fixture.codecId,
        fixture.payload
      );
      await expect(
        unitOfWork.verifyOrInitializeKeyringAnchor(
          keyringAnchorRequest(1, 'active', ['active'])
        ),
        fixture.label
      ).rejects.toThrow(fixture.expected);
    }
  });

  it('blocks a populated v43 database without partially applying later migrations', () => {
    const root = createTemporaryRoot();
    const agentData = path.join(root, 'agent_data');
    mkdirSync(agentData, { recursive: true });
    const dbPath = path.join(agentData, 'memory.db');
    const version43 = new DatabaseSync(dbPath);
    version43.exec('PRAGMA foreign_keys = ON;');
    const migrated = applySqliteMigrations(
      version43,
      MEMORY_DB_MIGRATIONS.filter((migration) => migration.version <= 43)
    );
    expect(migrated.version).toBe(43);
    version43.prepare(
      `INSERT INTO agent_state(key, value, updated_at)
       VALUES ('upgrade-sentinel', 'preserved', ?)`
    ).run(at(0));
    const v43Command = startCommand('run-v43-migration', 'command-v43-migration');
    const v43Run = {
      runId: v43Command.runId,
      version: 1,
      binding: v43Command.binding,
      state: {
        status: 'queued' as const,
        checkpointVersion: 0 as const,
        queuedAt: v43Command.occurredAt
      },
      effects: [],
      createdAt: v43Command.occurredAt,
      updatedAt: v43Command.occurredAt
    };
    const v43Events = [
      {
        eventId: 'command-v43-migration:1',
        commandId: v43Command.commandId,
        runId: v43Command.runId,
        runVersion: 1,
        sequence: 1,
        occurredAt: v43Command.occurredAt,
        payload: { type: 'run.started', binding: v43Command.binding }
      },
      {
        eventId: 'command-v43-migration:2',
        commandId: v43Command.commandId,
        runId: v43Command.runId,
        runVersion: 1,
        sequence: 2,
        occurredAt: v43Command.occurredAt,
        payload: {
          type: 'run.state_changed',
          from: 'absent',
          to: v43Run.state
        }
      }
    ];
    version43.prepare(
      `INSERT INTO agent_v2_runs (
         run_id, version, state_status, aggregate_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      v43Run.runId,
      v43Run.version,
      v43Run.state.status,
      JSON.stringify(v43Run),
      v43Run.createdAt,
      v43Run.updatedAt
    );
    version43.prepare(
      `INSERT INTO agent_v2_commands (
         command_id, command_digest, run_id, resulting_version,
         result_run_json, committed_at
       ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      v43Command.commandId,
      `sha256:${'1'.repeat(64)}`,
      v43Run.runId,
      v43Run.version,
      JSON.stringify(v43Run),
      v43Run.createdAt
    );
    const insertV43Event = version43.prepare(
      `INSERT INTO agent_v2_events (
         event_id, command_id, run_id, run_version, sequence,
         occurred_at, event_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const insertV43Outbox = version43.prepare(
      `INSERT INTO agent_v2_outbox (
         event_id, aggregate_type, aggregate_id, aggregate_version,
         event_json, created_at, published_at
       ) VALUES (?, 'agent_run', ?, ?, ?, ?, ?)`
    );
    for (const [index, event] of v43Events.entries()) {
      const eventJson = JSON.stringify(event);
      insertV43Event.run(
        event.eventId,
        event.commandId,
        event.runId,
        event.runVersion,
        event.sequence,
        event.occurredAt,
        eventJson
      );
      insertV43Outbox.run(
        event.eventId,
        event.runId,
        event.runVersion,
        eventJson,
        event.occurredAt,
        index === 0 ? at(1) : null
      );
    }
    version43.close();

    expect(() => openMemoryDatabase(root)).toThrow(
      'memory_control_shadow_offline_migration_required:'
        + 'agent_v2_commands,agent_v2_events,agent_v2_outbox,agent_v2_runs'
    );

    const unchanged = new DatabaseSync(dbPath, { readOnly: true });
    expect(unchanged.prepare('PRAGMA user_version').get()).toEqual({ user_version: 43 });
    expect(unchanged.prepare(
      `SELECT value FROM agent_state WHERE key='upgrade-sentinel'`
    ).get()).toEqual({ value: 'preserved' });
    expect(unchanged.prepare('SELECT COUNT(*) AS count FROM agent_v2_runs').get())
      .toEqual({ count: 1 });
    expect(unchanged.prepare('SELECT COUNT(*) AS count FROM agent_v2_events').get())
      .toEqual({ count: 2 });
    expect(unchanged.prepare(
      'SELECT version FROM schema_migrations WHERE version > 43 ORDER BY version'
    ).all()).toEqual([]);
    expect(unchanged.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    unchanged.close();
  });
});

const effectInputDigester = new Sha256AgentEffectInputDigester();

class ThrowOnDecodePayloadCodec implements AgentPersistencePayloadCodec {
  private readonly delegate = new StrictJsonAgentPersistencePayloadCodec();

  public encode(value: AgentJsonValue, context: AgentPersistencePayloadContext) {
    return this.delegate.encode(value, context);
  }

  public decode(
    _encoded: EncodedAgentPersistencePayload,
    _context: AgentPersistencePayloadContext
  ): AgentJsonValue {
    throw new Error('decode_must_be_just_in_time');
  }
}

class MutableClock implements AgentPersistenceClock {
  public constructor(private current: string) {}

  public now(): Date {
    return new Date(this.current);
  }

  public advance(milliseconds: number): void {
    this.current = new Date(Date.parse(this.current) + milliseconds).toISOString();
  }
}

class SqliteTestAgentRunCommandService extends AgentRunCommandService {
  public override execute(command: AgentRunCommand): Promise<AgentRunCommandResult> {
    return super.execute(command, sqliteTestRecoveryArtifacts(command));
  }
}

function sqliteTestRecoveryArtifacts(
  command: AgentRunCommand
): AgentRunCommitArtifacts {
  const effectPayloads: AgentRunCommitArtifacts['effectPayloads'] =
    command.kind === 'run.register_effect'
      ? [{
          kind: 'record_input',
          effectId: command.effect.effectId,
          inputDigest: command.effect.inputDigest,
          input: testEffectInput(command.effect.effectId),
          recordedAt: command.occurredAt
        }]
      : command.kind === 'run.record_effect_result'
          && command.result.status !== 'uncertain'
        ? [{
            kind: 'record_result',
            effectId: command.effectId,
            inputDigest: testEffectInputDigest(command.runId, command.effectId),
            result: { ...command.result },
            recordedAt: command.occurredAt
          }]
        : [];
  const terminal = command.kind === 'run.complete'
    || command.kind === 'run.fail'
    || command.kind === 'run.cancel';
  return {
    turnInputPayloads: [],
    effectPayloads,
    ...(command.kind !== 'run.start' && !terminal
      ? {
          checkpoint: {
            checkpointVersion: command.expectedVersion,
            payload: {
              format: 'ariadne.agent-checkpoint' as const,
              schemaVersion: 1 as const,
              engineContinuation: { commandId: command.commandId },
              modelContext: [{ role: 'system', content: 'non-sensitive fixture' }]
            },
            createdAt: command.occurredAt
          }
        }
      : {})
  };
}

function testEffectInput(effectId: string): AgentJsonValue {
  return {
    tool: 'workspace.write',
    effectId,
    path: 'src/result.ts',
    content: 'verified fixture output'
  };
}

function testEffectInputDigest(runId: string, effectId: string): string {
  return effectInputDigester.digest(testEffectInput(effectId), { runId, effectId });
}

function multiRunStartCommit(commandId: string): AgentRunCommandCommit {
  const parentRunId = 'run-00-parent';
  const parentBinding = startCommand(parentRunId, commandId).binding;
  const childBinding = (
    runId: string,
    delegationId: string
  ): AgentRunBinding => ({
    ...startCommand(runId, commandId).binding,
    sessionId: parentBinding.sessionId,
    objectiveRef: {
      kind: 'parent_delegation',
      parentRunId,
      delegationId,
      objectiveDigest: `sha256:${'e'.repeat(64)}`
    },
    budget: {
      ...startCommand(runId, commandId).binding.budget,
      source: {
        kind: 'parent_allocation',
        parentRunId,
        parentGrantId: parentBinding.budget.grantId,
        delegationId
      }
    }
  });
  const bindings = new Map<string, AgentRunBinding>([
    [parentRunId, parentBinding],
    ['run-10-child-a', childBinding('run-10-child-a', 'delegation-child-a')],
    ['run-20-child-b', childBinding('run-20-child-b', 'delegation-child-b')]
  ]);
  return {
    commandId,
    commandDigest: `sha256:${'f'.repeat(64)}`,
    mutations: [...bindings].map(([runId, binding]): AgentRunCommitMutation => {
      const state = {
        status: 'queued' as const,
        checkpointVersion: 0 as const,
        queuedAt: at(0)
      };
      const run: AgentRun = {
        runId,
        version: 1,
        binding,
        state,
        turns: [],
        effects: [],
        inbox: [],
        createdAt: at(0),
        updatedAt: at(0)
      };
      return {
        runId,
        expectedVersion: null,
        resultingVersion: 1,
        run,
        events: [{
          eventId: `event:${commandId}:${runId}:1`,
          commandId,
          runId,
          runVersion: 1,
          sequence: 1,
          occurredAt: at(0),
          payload: { type: 'run.started', binding }
        }, {
          eventId: `event:${commandId}:${runId}:2`,
          commandId,
          runId,
          runVersion: 1,
          sequence: 2,
          occurredAt: at(0),
          payload: { type: 'run.state_changed', from: 'absent', to: state }
        }],
        artifacts: { turnInputPayloads: [], effectPayloads: [] }
      };
    })
  };
}

function multiRunBeginCommit(
  started: AgentRunCommandCommit,
  commandId: string
): AgentRunCommandCommit {
  return {
    commandId,
    commandDigest: `sha256:${'9'.repeat(64)}`,
    mutations: started.mutations.map((mutation): AgentRunCommitMutation => {
      const state = {
        status: 'running' as const,
        checkpointVersion: 1,
        enteredAt: at(1)
      };
      return {
        runId: mutation.runId,
        expectedVersion: 1,
        resultingVersion: 2,
        run: {
          ...mutation.run,
          version: 2,
          state,
          updatedAt: at(1)
        },
        events: [{
          eventId: `event:${commandId}:${mutation.runId}:1`,
          commandId,
          runId: mutation.runId,
          runVersion: 2,
          sequence: 1,
          occurredAt: at(1),
          payload: {
            type: 'run.state_changed',
            from: 'queued',
            to: state
          }
        }],
        artifacts: {
          checkpoint: {
            checkpointVersion: 1,
            payload: {
              format: 'ariadne.agent-checkpoint',
              schemaVersion: 1,
              engineContinuation: { phase: 'multi-run-begin' },
              modelContext: []
            },
            createdAt: at(1)
          },
          turnInputPayloads: [],
          effectPayloads: []
        }
      };
    })
  };
}

function startCommand(
  runId: string,
  commandId = 'command-start'
): StartAgentRunCommand {
  return {
    kind: 'run.start',
    commandId,
    runId,
    occurredAt: at(0),
    binding: {
      bindingVersion: 3,
      sessionId: 'session-1',
      objectiveRef: {
        kind: 'conversation_message',
        messageId: `message-${runId}`,
        messageVersion: 1,
        contentDigest: `sha256:${'a'.repeat(64)}`
      },
      workspace: {
        workspaceId: 'workspace-1',
        revision: 1,
        grantDigest: `sha256:${'b'.repeat(64)}`,
        access: 'write',
        scopeIds: ['src']
      },
      model: {
        providerId: 'provider-test',
        modelId: 'model-test',
        settingsRevision: 1
      },
      policy: {
        policyId: 'policy-test',
        revision: 1,
        permissionMode: 'ask'
      },
      capabilities: [{
        capabilityId: 'workspace.write',
        scopeIds: ['src']
      }],
      toolCatalog: {
        ...TEST_TOOL_CATALOG,
        allowedToolNames: ['workspace.write']
      },
      budget: {
        grantId: `grant-${runId}`,
        runId,
        vector: {
          modelTurns: 12,
          toolCalls: 8,
          readCalls: 0,
          writeCalls: 8,
          shellCalls: 0,
          costMicrousd: 1_000_000
        },
        deadlineAt: '2031-01-01T00:00:00.000Z',
        source: { kind: 'root' }
      }
    }
  };
}

function testPinnedTool(toolName: string) {
  return {
    ...TEST_TOOL_CATALOG,
    toolName,
    toolVersion: '1.0.0',
    providerId: 'ariadne.builtin',
    contractDigest: TEST_TOOL_CONTRACT_DIGEST
  };
}

function at(offsetSeconds: number): string {
  return new Date(Date.UTC(2030, 0, 1, 0, 0, offsetSeconds)).toISOString();
}

function createDatabase(): { database: AgentControlTestDatabase; root: string } {
  const root = createTemporaryRoot();
  return { database: openDatabase(root), root };
}

function createTemporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-agent-v3-'));
  temporaryRoots.push(root);
  return root;
}

function openDatabase(root: string): AgentControlTestDatabase {
  const dbPath = resolveAgentControlDatabasePath(root);
  if (!existsSync(dbPath)) {
    const initialized = openAgentControlDatabase(root);
    closeOwnedSqliteDatabase(initialized.database, initialized.ownerLease);
  }
  const connection = new DatabaseSync(dbPath);
  const database: AgentControlTestDatabase = {
    root,
    dbPath,
    connection,
    schemaVersion: readUserVersion(connection),
    close: () => connection.close()
  };
  openDatabases.add(database);
  return database;
}

function openMemoryDatabase(root: string): DatabaseManager {
  const database = new DatabaseManager(root);
  openDatabases.add(database);
  return database;
}

function closeDatabase(database: TestDatabaseConnection): void {
  if (!openDatabases.delete(database)) return;
  database.close();
}

function createUnitOfWork(
  database: AgentControlTestDatabase
): SqliteAgentRunUnitOfWork {
  const unitOfWork = new SqliteAgentRunUnitOfWork(database.root);
  openUnitOfWorks.add(unitOfWork);
  return unitOfWork;
}

function createUnitOfWorkWithClock(
  database: AgentControlTestDatabase,
  clock: AgentPersistenceClock
): SqliteAgentRunUnitOfWork {
  const unitOfWork = new SqliteAgentRunUnitOfWork(
    database.root,
    new StrictJsonAgentPersistencePayloadCodec(),
    clock
  );
  openUnitOfWorks.add(unitOfWork);
  return unitOfWork;
}

async function closeUnitOfWork(
  unitOfWork: SqliteAgentRunUnitOfWork
): Promise<void> {
  if (!openUnitOfWorks.delete(unitOfWork)) return;
  await closeUnitOfWorkWithDeadline(unitOfWork);
}

async function closeUnitOfWorkWithDeadline(
  unitOfWork: SqliteAgentRunUnitOfWork
): Promise<void> {
  const context = createShutdownContext(Date.now() + 5_000);
  try {
    await unitOfWork.close(context);
  } finally {
    context.dispose();
  }
}

function countRows(database: TestDatabaseConnection, table: string): number {
  const row = database.connection.prepare(
    `SELECT COUNT(*) AS count FROM ${table}`
  ).get() as { count: number };
  return row.count;
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

function readUnitOfWorkPragmas(unitOfWork: SqliteAgentRunUnitOfWork): {
  readonly foreignKeys: number;
  readonly busyTimeout: number;
  readonly journalMode: string;
  readonly synchronous: number;
} {
  const database = (unitOfWork as unknown as { database: DatabaseSync }).database;
  return {
    foreignKeys: Number((database.prepare('PRAGMA foreign_keys').get() as {
      foreign_keys: number;
    }).foreign_keys),
    busyTimeout: Number((database.prepare('PRAGMA busy_timeout').get() as {
      timeout: number;
    }).timeout),
    journalMode: String((database.prepare('PRAGMA journal_mode').get() as {
      journal_mode: string;
    }).journal_mode).toLowerCase(),
    synchronous: Number((database.prepare('PRAGMA synchronous').get() as {
      synchronous: number;
    }).synchronous)
  };
}

function readDatabaseSnapshot(databaseFile: string): {
  readonly bytes: Buffer;
  readonly userVersion: number;
  readonly schema: readonly Record<string, unknown>[];
  readonly sentinel: readonly Record<string, unknown>[];
} {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      bytes: readFileSync(databaseFile),
      userVersion: readUserVersion(database),
      schema: database.prepare(
        `SELECT type, name, tbl_name, sql
         FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%'
         ORDER BY type, name`
      ).all() as unknown as Record<string, unknown>[],
      sentinel: database.prepare(
        'SELECT id, value FROM owner_fencing_sentinel ORDER BY id'
      ).all() as unknown as Record<string, unknown>[]
    };
  } finally {
    database.close();
  }
}

function readAgentControlSchemaSnapshot(databaseFile: string): {
  readonly userVersion: number;
  readonly schema: readonly Record<string, unknown>[];
  readonly migrations: readonly Record<string, unknown>[];
  readonly rows: Readonly<Record<string, readonly Record<string, unknown>[]>>;
  readonly sqliteSequence: readonly Record<string, unknown>[];
} {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const tableNames = [
      'agent_control_metadata',
      'agent_v3_budget_entries',
      'agent_v3_budget_grants',
      'agent_v3_checkpoints',
      'agent_v3_child_terminals',
      'agent_v3_command_runs',
      'agent_v3_commands',
      'agent_v3_delegations',
      'agent_v3_directive_payloads',
      'agent_v3_effect_payloads',
      'agent_v3_events',
      'agent_v3_outbox',
      'agent_v3_plan_approvals',
      'agent_v3_plan_versions',
      'agent_v3_runs'
    ] as const;
    return {
      userVersion: readUserVersion(database),
      schema: database.prepare(
        `SELECT type, name, tbl_name, sql
         FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%'
         ORDER BY type, name`
      ).all() as unknown as Record<string, unknown>[],
      migrations: database.prepare(
        'SELECT version, name, applied_at FROM schema_migrations ORDER BY version'
      ).all() as unknown as Record<string, unknown>[],
      rows: Object.fromEntries(tableNames.map((tableName) => [
        tableName,
        database.prepare(`SELECT * FROM ${tableName} ORDER BY rowid`).all()
      ])) as Readonly<Record<string, readonly Record<string, unknown>[]>>,
      sqliteSequence: database.prepare(
        'SELECT name, seq FROM sqlite_sequence ORDER BY name'
      ).all() as unknown as Record<string, unknown>[]
    };
  } finally {
    database.close();
  }
}

function commandCount(database: TestDatabaseConnection, commandId: string): number {
  const row = database.connection.prepare(
    'SELECT COUNT(*) AS count FROM agent_v3_commands WHERE command_id=?'
  ).get(commandId) as { count: number };
  return row.count;
}

function persistedCommandDigest(
  database: TestDatabaseConnection,
  commandId: string
): string | null {
  const row = database.connection.prepare(
    'SELECT command_digest FROM agent_v3_commands WHERE command_id=?'
  ).get(commandId) as { command_digest: string } | undefined;
  return row?.command_digest ?? null;
}

function orphanedOutboxRows(database: TestDatabaseConnection): number {
  const row = database.connection.prepare(
    `SELECT COUNT(*) AS count
     FROM agent_v3_outbox outbox
     LEFT JOIN agent_v3_events event ON event.event_id=outbox.event_id
     WHERE event.event_id IS NULL`
  ).get() as { count: number };
  return row.count;
}

function divergentOutboxRows(database: TestDatabaseConnection): number {
  const row = database.connection.prepare(
    `SELECT COUNT(*) AS count
     FROM agent_v3_outbox outbox
     INNER JOIN agent_v3_events event ON event.event_id=outbox.event_id
     WHERE event.event_json <> outbox.event_json`
  ).get() as { count: number };
  return row.count;
}

function publishedOutboxCount(database: TestDatabaseConnection): number {
  const row = database.connection.prepare(
    'SELECT COUNT(*) AS count FROM agent_v3_outbox WHERE published_at IS NOT NULL'
  ).get() as { count: number };
  return row.count;
}

function persistedCounts(database: TestDatabaseConnection): Record<string, number> {
  return {
    runs: countRows(database, 'agent_v3_runs'),
    commands: countRows(database, 'agent_v3_commands'),
    events: countRows(database, 'agent_v3_events'),
    outbox: countRows(database, 'agent_v3_outbox'),
    checkpoints: countRows(database, 'agent_v3_checkpoints'),
    effectPayloads: countRows(database, 'agent_v3_effect_payloads')
  };
}

function listUserTables(database: TestDatabaseConnection): string[] {
  return (database.connection.prepare(
    `SELECT name FROM sqlite_master
     WHERE type='table' AND name NOT LIKE 'sqlite_%'
     ORDER BY name`
  ).all() as unknown as Array<{ name: string }>).map((row) => row.name);
}

function keyringAnchorRequest(
  generation: number,
  activeKeyId: string,
  availableKeyIds: readonly string[]
) {
  return {
    generation,
    activeKeyId,
    availableKeyIds,
    requiredCodecId: 'aes-256-gcm-v1'
  } as const;
}

function insertProtectedRecoveryFixture(
  database: TestDatabaseConnection,
  target: 'checkpoint' | 'input' | 'result',
  codecId: string,
  payload: AgentJsonValue
): void {
  const protectedPayload = (candidate: 'checkpoint' | 'input' | 'result') => ({
    codecId: candidate === target ? codecId : 'aes-256-gcm-v1',
    payloadJson: JSON.stringify(candidate === target ? payload : { keyId: 'active' })
  });
  const checkpoint = protectedPayload('checkpoint');
  const input = protectedPayload('input');
  const result = protectedPayload('result');
  const aggregateJson = JSON.stringify({
    binding: {
      toolCatalog: {
        catalogId: 'protected-recovery-fixture',
        revision: 1,
        digest: `sha256:${'d'.repeat(64)}`
      }
    },
    turns: []
  });
  database.connection.exec('BEGIN IMMEDIATE');
  try {
    database.connection.prepare(
      `INSERT INTO agent_v3_runs (
         run_id, version, state_status, aggregate_json, created_at, updated_at
       ) VALUES ('run-anchor-payload', 2, 'waiting', ?, ?, ?)`
    ).run(aggregateJson, at(0), at(0));
    const insertCommand = database.connection.prepare(
      `INSERT INTO agent_v3_commands (
         command_id, command_digest, mutation_count, committed_at
       ) VALUES (?, ?, 1, ?)`
    );
    insertCommand.run(
      'command-anchor-input',
      `sha256:${'1'.repeat(64)}`,
      at(0)
    );
    insertCommand.run(
      'command-anchor-result',
      `sha256:${'2'.repeat(64)}`,
      at(0)
    );
    const insertCommandRun = database.connection.prepare(
      `INSERT INTO agent_v3_command_runs (
         command_id, run_id, ordinal, expected_version,
         resulting_version, result_run_json
       ) VALUES (?, 'run-anchor-payload', 0, ?, ?, ?)`
    );
    insertCommandRun.run('command-anchor-input', null, 1, aggregateJson);
    insertCommandRun.run('command-anchor-result', 1, 2, aggregateJson);
    database.connection.prepare(
      `INSERT INTO agent_v3_checkpoints (
         run_id, checkpoint_version, run_version, command_id,
         codec_id, payload_json, created_at
       ) VALUES (
         'run-anchor-payload', 1, 2, 'command-anchor-result', ?, ?, ?
       )`
    ).run(checkpoint.codecId, checkpoint.payloadJson, at(0));
    database.connection.prepare(
      `INSERT INTO agent_v3_effect_payloads (
         run_id, effect_id, input_digest, input_command_id, input_run_version,
         input_codec_id, input_payload_json, result_command_id,
         result_run_version, result_codec_id, result_payload_json,
         created_at, updated_at
       ) VALUES (
         'run-anchor-payload', 'effect-anchor', 'sha256:fixture',
         'command-anchor-input', 1, ?, ?, 'command-anchor-result', 2, ?, ?, ?, ?
       )`
    ).run(
      input.codecId,
      input.payloadJson,
      result.codecId,
      result.payloadJson,
      at(0),
      at(0)
    );
    database.connection.exec('COMMIT');
  } catch (error) {
    if (database.connection.isTransaction) database.connection.exec('ROLLBACK');
    throw error;
  }
}

function readUserVersion(database: DatabaseSync): number {
  return (database.prepare('PRAGMA user_version').get() as {
    user_version: number;
  }).user_version;
}
