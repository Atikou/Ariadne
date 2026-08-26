import { mkdtempSync, rmSync } from 'node:fs';
import { fork } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  AgentRunAdmissionService,
  AgentRunCommandService,
  digestAgentTurnInput,
  sha256AgentControlData,
  summarizeAgentTurnInput,
  type AdmitAgentRunRequest
} from '@ariadne/agent-core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AgentRunExecutionIntentStoreError,
  SqliteAgentRunUnitOfWork,
  type AgentPersistenceClock
} from '../src/adapters/persistence/SqliteAgentRunUnitOfWork.js';
import { resolveAgentControlDatabasePath } from '../src/adapters/persistence/agentControlDbSchema.js';
import type { AgentRunExecutionIntent } from '../src/control/ports/AgentRunExecutionStarter.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';

const roots: string[] = [];
const openUnits = new Set<SqliteAgentRunUnitOfWork>();

afterEach(async () => {
  await Promise.all([...openUnits].map(closeUnit));
  openUnits.clear();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('SQLite Agent execution-intent ledger', () => {
  it('commits the full canonical payload digest before returning and exact-replays after restart', async () => {
    const root = createRoot();
    const clock = new MutableClock(at(10));
    const unit = track(new SqliteAgentRunUnitOfWork(root, undefined, clock));
    const intent = executionIntent();
    await admitExactRun(unit, intent);

    await expect(unit.startExecutionIntent(intent, liveSignal())).resolves.toEqual({
      executionIntentId: intent.executionIntentId,
      sourceOutboxMessageId: intent.sourceOutboxMessageId,
      runId: intent.runId,
      admittedRunVersion: 1,
      replayed: false
    });

    const durable = readIntentRow(root, intent.executionIntentId);
    expect(durable).toMatchObject({
      execution_intent_id: intent.executionIntentId,
      source_outbox_message_id: intent.sourceOutboxMessageId,
      run_id: intent.runId,
      admitted_run_version: 1,
      created_at: intent.occurredAt,
      state: 'pending'
    });
    expect(durable.intent_json).toBe(canonicalJson(intent));
    expect(durable.intent_digest).toBe(await sha256AgentControlData(intent));

    await expect(unit.startExecutionIntent({
      ...intent,
      workspaceId: 'workspace-drift'
    }, liveSignal())).rejects.toMatchObject({
      code: 'AGENT_EXECUTION_INTENT_CONFLICT'
    });

    await closeTracked(unit);
    const reopened = track(new SqliteAgentRunUnitOfWork(root, undefined, clock));
    await expect(reopened.startExecutionIntent(intent, liveSignal())).resolves.toEqual({
      executionIntentId: intent.executionIntentId,
      sourceOutboxMessageId: intent.sourceOutboxMessageId,
      runId: intent.runId,
      admittedRunVersion: 1,
      replayed: true
    });
    expect(readIntentCount(root)).toBe(1);
  });

  it('rejects execution unless the current Run is the exact admitted v1 receipt, checkpoint, and unique intended Attempt', async () => {
    const root = createRoot();
    const unit = track(new SqliteAgentRunUnitOfWork(root));
    const intent = executionIntent();
    const admission = await admitExactRun(unit, intent);

    await new AgentRunCommandService(unit).execute({
      kind: 'run.start_inference_attempt',
      commandId: 'execution-run-already-started-command',
      runId: intent.runId,
      expectedVersion: 1,
      turnId: admission.command.turn.turnId,
      attemptId: admission.command.turn.attemptId,
      occurredAt: at(1)
    }, {
      checkpoint: {
        checkpointVersion: 2,
        createdAt: at(1),
        payload: {
          ...admission.checkpoint,
          engineContinuation: { phase: 'inference_started' }
        }
      },
      turnInputPayloads: [],
      effectPayloads: []
    });

    await expect(unit.startExecutionIntent(intent, liveSignal()))
      .rejects.toMatchObject({ code: 'AGENT_EXECUTION_ADMISSION_MISMATCH' });
    expect(readIntentCount(root)).toBe(0);
  });

  it('keeps an unknown external result in sticky dispatching recovery and never reclaims it as pending', async () => {
    const root = createRoot();
    const clock = new MutableClock(at(10));
    const unit = track(new SqliteAgentRunUnitOfWork(root, undefined, clock));
    const intent = executionIntent();
    await admitExactRun(unit, intent);
    await unit.startExecutionIntent(intent, liveSignal());

    const claim = (await unit.claimPendingExecutionIntents({
      claimId: 'execution-claim-a',
      leaseMs: 60_000,
      limit: 10
    }))[0];
    expect(claim).toMatchObject({
      intent,
      claimId: 'execution-claim-a',
      claimAttempts: 1
    });
    clock.set(at(11));
    await expect(unit.markExecutionDispatchStarted({
      executionIntentId: intent.executionIntentId,
      claimId: 'execution-claim-a',
      dispatchAttemptId: 'execution-dispatch-attempt-a',
      startedAt: at(11)
    })).resolves.toEqual({
      executionIntentId: intent.executionIntentId,
      state: 'dispatching',
      dispatchAttemptId: 'execution-dispatch-attempt-a',
      replayed: false
    });

    await expect(unit.settleExecutionIntent({
      executionIntentId: intent.executionIntentId,
      dispatchAttemptId: 'execution-dispatch-attempt-a',
      externalDispatchId: 'external-dispatch-a',
      outcome: 'failed',
      settlementDigest: digest('9'),
      settledAt: at(13)
    })).rejects.toMatchObject({ code: 'AGENT_EXECUTION_STATE_CONFLICT' });

    await closeTracked(unit);
    clock.set(at(100));
    const reopened = track(new SqliteAgentRunUnitOfWork(root, undefined, clock));
    await expect(reopened.claimPendingExecutionIntents({
      claimId: 'execution-claim-after-restart',
      leaseMs: 60_000,
      limit: 10
    })).resolves.toEqual([]);
    await expect(reopened.listExecutionIntentRecovery()).resolves.toMatchObject({
      items: [{
        intent,
        state: 'dispatching',
        dispatchAttemptId: 'execution-dispatch-attempt-a',
        externalDispatchId: null
      }]
    });

    const dispatched = {
      executionIntentId: intent.executionIntentId,
      dispatchAttemptId: 'execution-dispatch-attempt-a',
      externalDispatchId: 'external-dispatch-a',
      dispatchReceiptDigest: digest('7'),
      dispatchedAt: at(12)
    } as const;
    await expect(reopened.markExecutionDispatched(dispatched)).resolves.toEqual({
      executionIntentId: intent.executionIntentId,
      state: 'dispatched',
      dispatchAttemptId: 'execution-dispatch-attempt-a',
      replayed: false
    });
    await expect(reopened.markExecutionDispatched(dispatched)).resolves.toMatchObject({
      state: 'dispatched',
      replayed: true
    });
    await expect(reopened.markExecutionDispatched({
      ...dispatched,
      dispatchReceiptDigest: digest('8')
    })).rejects.toMatchObject({ code: 'AGENT_EXECUTION_STATE_CONFLICT' });

    const settlement = {
      executionIntentId: intent.executionIntentId,
      dispatchAttemptId: 'execution-dispatch-attempt-a',
      externalDispatchId: 'external-dispatch-a',
      outcome: 'completed' as const,
      settlementDigest: digest('6'),
      settledAt: at(13)
    };
    await expect(reopened.settleExecutionIntent(settlement)).resolves.toMatchObject({
      state: 'settled',
      replayed: false
    });
    await expect(reopened.settleExecutionIntent(settlement)).resolves.toMatchObject({
      state: 'settled',
      replayed: true
    });
    await expect(reopened.listExecutionIntentRecovery()).resolves.toEqual({ items: [] });
  });

  it('uses the Agent owner fence and immediately recovers only pre-dispatch claims on restart', async () => {
    const root = createRoot();
    const clock = new MutableClock(at(10));
    const first = track(new SqliteAgentRunUnitOfWork(root, undefined, clock));
    const intent = executionIntent();
    await admitExactRun(first, intent);
    await first.startExecutionIntent(intent, liveSignal());
    await first.claimPendingExecutionIntents({
      claimId: 'execution-owner-old-claim',
      leaseMs: 300_000,
      limit: 1
    });

    expect(() => new SqliteAgentRunUnitOfWork(root, undefined, clock))
      .toThrow(/owner|lease|locked/i);

    await closeTracked(first);
    const restarted = track(new SqliteAgentRunUnitOfWork(root, undefined, clock));
    await expect(restarted.claimPendingExecutionIntents({
      claimId: 'execution-owner-new-claim',
      leaseMs: 60_000,
      limit: 1
    })).resolves.toMatchObject([{
      claimId: 'execution-owner-new-claim',
      claimAttempts: 2,
      intent
    }]);
  });

  it('rolls back on caller cancellation before commit and rejects source/run aliasing', async () => {
    const root = createRoot();
    const unit = track(new SqliteAgentRunUnitOfWork(root));
    const intent = executionIntent();
    await admitExactRun(unit, intent);
    const cancelled = new AbortController();
    cancelled.abort(new Error('source_cancelled'));
    await expect(unit.startExecutionIntent(intent, cancelled.signal))
      .rejects.toThrow('source_cancelled');
    expect(readIntentCount(root)).toBe(0);

    await unit.startExecutionIntent(intent, liveSignal());
    await expect(unit.startExecutionIntent({
      ...intent,
      executionIntentId: 'execution-intent-alias'
    }, liveSignal())).rejects.toBeInstanceOf(AgentRunExecutionIntentStoreError);
    expect(readIntentCount(root)).toBe(1);
  });

  it('replays the committed receipt after the owning process is killed before source ACK', async () => {
    const root = createRoot();
    const seeder = track(new SqliteAgentRunUnitOfWork(root));
    const intent = executionIntent();
    await admitExactRun(seeder, intent);
    await closeTracked(seeder);

    const fixture = fileURLToPath(new URL(
      './fixtures/execution-intent-kill-fixture.ts',
      import.meta.url
    ));
    const child = fork(fixture, [root], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    });
    try {
      await waitForChildCommit(child);
      expect(readIntentRow(root, intent.executionIntentId)).toMatchObject({
        state: 'pending',
        execution_intent_id: intent.executionIntentId
      });
      child.kill('SIGKILL');
      await waitForChildExit(child);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }

    const restarted = track(new SqliteAgentRunUnitOfWork(root));
    await expect(restarted.startExecutionIntent(intent, liveSignal())).resolves.toMatchObject({
      executionIntentId: intent.executionIntentId,
      replayed: true
    });
    expect(readIntentCount(root)).toBe(1);
  });

  it('requires an explicit offline migration for a nonempty schema-v3 store', async () => {
    const root = createRoot();
    const initialized = track(new SqliteAgentRunUnitOfWork(root));
    await closeTracked(initialized);
    const databasePath = resolveAgentControlDatabasePath(root);
    const legacy = new DatabaseSync(databasePath);
    legacy.exec('BEGIN IMMEDIATE;');
    try {
      legacy.exec(`
        DROP INDEX idx_agent_v3_execution_intents_pending;
        DROP INDEX idx_agent_v3_execution_intents_recovery;
        DROP INDEX idx_agent_v3_execution_intents_run;
        DROP TABLE agent_v3_execution_intents;
        UPDATE schema_migrations
           SET version=3, name='agent_control_v3_plan_budget_child_run_ledger'
         WHERE version=4;
        INSERT INTO agent_control_metadata(key, value, updated_at)
        VALUES ('keyring_generation', '3', '2030-01-01T00:00:00.000Z');
        PRAGMA user_version = 3;
        COMMIT;
      `);
    } catch (error) {
      if (legacy.isTransaction) legacy.exec('ROLLBACK;');
      throw error;
    } finally {
      legacy.close();
    }

    expect(() => new SqliteAgentRunUnitOfWork(root)).toThrow(
      'agent_control_offline_migration_required:agent_control_schema:3:5'
    );
    const unchanged = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(unchanged.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 });
      expect(unchanged.prepare(
        `SELECT value FROM agent_control_metadata WHERE key='keyring_generation'`
      ).get()).toEqual({ value: '3' });
      expect(unchanged.prepare(
        `SELECT name FROM sqlite_master
         WHERE type='table' AND name='agent_v3_execution_intents'`
      ).get()).toBeUndefined();
    } finally {
      unchanged.close();
    }
  });
});

async function admitExactRun(
  unit: SqliteAgentRunUnitOfWork,
  intent: AgentRunExecutionIntent
): Promise<AdmitAgentRunRequest> {
  const request = await admissionRequest(intent);
  await new AgentRunAdmissionService(unit).admit(request);
  return request;
}

async function admissionRequest(
  intent: AgentRunExecutionIntent
): Promise<AdmitAgentRunRequest> {
  const catalogDigest = digest('a');
  const cause = {
    kind: 'conversation_objective' as const,
    messageId: intent.objectiveMessageId,
    messageVersion: intent.objectiveMessageVersion,
    contentDigest: intent.objectiveDigest
  };
  const input = {
    messages: [{
      kind: 'text' as const,
      role: 'user' as const,
      content: 'Execute only after durable handoff.'
    }],
    availableTools: []
  };
  return {
    command: {
      kind: 'run.admit',
      commandId: 'execution-admission-command',
      runId: intent.runId,
      occurredAt: intent.occurredAt,
      binding: {
        bindingVersion: 3,
        sessionId: intent.sessionId,
        objectiveRef: {
          kind: 'conversation_message',
          messageId: intent.objectiveMessageId,
          messageVersion: intent.objectiveMessageVersion,
          contentDigest: intent.objectiveDigest
        },
        workspace: {
          workspaceId: intent.workspaceId,
          revision: 1,
          grantDigest: digest('d'),
          access: 'write',
          scopeIds: ['workspace']
        },
        model: {
          providerId: 'execution-provider',
          modelId: 'execution-model',
          settingsRevision: 1
        },
        policy: {
          policyId: 'execution-policy',
          revision: 1,
          permissionMode: 'ask'
        },
        capabilities: [],
        toolCatalog: {
          catalogId: 'execution-catalog',
          revision: 1,
          digest: catalogDigest,
          allowedToolNames: []
        },
        budget: {
          grantId: 'execution-root-grant',
          runId: intent.runId,
          vector: {
            modelTurns: 4,
            toolCalls: 0,
            readCalls: 0,
            writeCalls: 0,
            shellCalls: 0,
            costMicrousd: 100_000
          },
          deadlineAt: '2031-01-01T00:00:00.000Z',
          source: { kind: 'root' }
        }
      },
      turn: {
        cause,
        turnId: 'execution-turn',
        attemptId: 'execution-attempt',
        providerIdempotencyKey: 'execution-provider-key',
        inputDigest: await digestAgentTurnInput(input),
        inputSummary: summarizeAgentTurnInput(input)
      }
    },
    checkpoint: {
      format: 'ariadne.agent-checkpoint',
      schemaVersion: 1,
      engineContinuation: {
        phase: 'turn_intended',
        sagaId: intent.sagaId,
        runRequestId: intent.runRequestId,
        sessionId: intent.sessionId,
        workspaceId: intent.workspaceId,
        objectiveRef: {
          kind: 'conversation_message',
          messageId: intent.objectiveMessageId,
          messageVersion: intent.objectiveMessageVersion,
          contentDigest: intent.objectiveDigest
        }
      },
      modelContext: null
    },
    turnInput: {
      format: 'ariadne.agent-turn-input',
      schemaVersion: 1,
      runId: intent.runId,
      turnId: 'execution-turn',
      cause,
      authorityRef: {
        kind: 'conversation_message',
        sessionId: intent.sessionId,
        workspaceId: intent.workspaceId,
        messageId: intent.objectiveMessageId,
        messageVersion: intent.objectiveMessageVersion,
        contentDigest: intent.objectiveDigest
      },
      messages: input.messages,
      availableTools: input.availableTools
    }
  };
}

function executionIntent(): AgentRunExecutionIntent {
  return {
    kind: 'agent.execution.start',
    executionIntentId: 'execution-intent-1',
    sourceOutboxMessageId: 'conversation-linked-outbox-1',
    sagaId: 'conversation-saga-1',
    sessionId: 'execution-session',
    workspaceId: 'execution-workspace',
    objectiveMessageId: 'execution-objective-message',
    objectiveMessageVersion: 1,
    objectiveDigest: digest('b'),
    runRequestId: 'execution-run-request',
    runId: 'execution-run',
    admittedRunVersion: 1,
    occurredAt: at(0)
  };
}

class MutableClock implements AgentPersistenceClock {
  public constructor(private value: string) {}
  public now(): Date {
    return new Date(this.value);
  }
  public set(value: string): void {
    this.value = value;
  }
}

function readIntentRow(root: string, executionIntentId: string): Record<string, unknown> {
  const database = new DatabaseSync(resolveAgentControlDatabasePath(root), {
    readOnly: true
  });
  try {
    const row = database.prepare(
      'SELECT * FROM agent_v3_execution_intents WHERE execution_intent_id=?'
    ).get(executionIntentId) as Record<string, unknown> | undefined;
    if (row === undefined) throw new Error('execution_intent_test_row_missing');
    return row;
  } finally {
    database.close();
  }
}

function readIntentCount(root: string): number {
  const database = new DatabaseSync(resolveAgentControlDatabasePath(root), {
    readOnly: true
  });
  try {
    return Number((database.prepare(
      'SELECT COUNT(*) AS count FROM agent_v3_execution_intents'
    ).get() as { count: number }).count);
  } finally {
    database.close();
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(',')}}`;
}

function liveSignal(): AbortSignal {
  return new AbortController().signal;
}

function createRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-execution-intent-'));
  roots.push(root);
  return root;
}

function track(unit: SqliteAgentRunUnitOfWork): SqliteAgentRunUnitOfWork {
  openUnits.add(unit);
  return unit;
}

async function closeTracked(unit: SqliteAgentRunUnitOfWork): Promise<void> {
  if (!openUnits.delete(unit)) return;
  await closeUnit(unit);
}

async function closeUnit(unit: SqliteAgentRunUnitOfWork): Promise<void> {
  const context = createShutdownContext(Date.now() + 5_000);
  try {
    await unit.close(context);
  } finally {
    context.dispose();
  }
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function at(offsetSeconds: number): string {
  return new Date(Date.UTC(2030, 0, 1, 0, 0, offsetSeconds)).toISOString();
}

function waitForChildCommit(child: ReturnType<typeof fork>): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('execution_intent_fixture_timeout')), 10_000);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      reject(new Error(
        `execution_intent_fixture_exited:${String(code)}:${String(signal)}`
      ));
    });
    child.on('message', (message: unknown) => {
      if (
        typeof message === 'object'
        && message !== null
        && (message as { type?: unknown }).type === 'intent_committed'
      ) {
        clearTimeout(timer);
        resolve();
      } else if (
        typeof message === 'object'
        && message !== null
        && (message as { type?: unknown }).type === 'fixture_error'
      ) {
        clearTimeout(timer);
        reject(new Error(String((message as { message?: unknown }).message)));
      }
    });
  });
}

function waitForChildExit(child: ReturnType<typeof fork>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('execution_intent_kill_timeout')), 10_000);
    child.once('error', reject);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
