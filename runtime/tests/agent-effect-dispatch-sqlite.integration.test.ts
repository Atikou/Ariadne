import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  AgentEffectDispatchRecoveryRequiredError,
  AgentEffectDispatchService,
  AgentRunCommandService,
  type AgentEffectDispatchCheckpointFactory,
  type AgentEffectExecutor,
  type AgentJsonValue,
  type AgentRunCheckpointCommit,
  type AgentTurnInput,
} from '@ariadne/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Sha256AgentEffectInputDigester } from '../src/adapters/persistence/Sha256AgentEffectInputDigester.js';
import {
  SqliteAgentRunUnitOfWork,
  type AgentPersistenceClock,
} from '../src/adapters/persistence/SqliteAgentRunUnitOfWork.js';
import { resolveAgentControlDatabasePath } from '../src/adapters/persistence/agentControlDbSchema.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';

const RUN_ID = 'run-effect-dispatch-sqlite';
const EFFECT_ID = 'effect-effect-dispatch-sqlite';
const DISPATCH_COMMAND_ID = 'dispatch-effect-sqlite';
const EFFECT_INPUT: AgentJsonValue = {
  path: 'src/result.ts',
  content: 'durable effect input',
};
const RAW_EXECUTOR_ERROR = 'provider exploded: bearer super-secret-executor-token';
const SECRET_MARKER = 'super-secret-executor-token';
const EFFECT_TOOL_CATALOG_DIGEST = `sha256:${'a'.repeat(64)}`;
const EFFECT_PINNED_TOOL = {
  catalogId: 'effect-dispatch-test-tools',
  revision: 1,
  digest: EFFECT_TOOL_CATALOG_DIGEST,
  toolName: 'workspace.write',
  toolVersion: '1.0.0',
  providerId: 'ariadne.builtin',
  contractDigest: `sha256:${'b'.repeat(64)}`
} as const;
const EFFECT_TOOL_DIRECTORY: AgentTurnInput['availableTools'] = [{
  tool: EFFECT_PINNED_TOOL,
  capabilityIds: ['workspace.write'],
}];

const roots: string[] = [];
const openUnits = new Set<SqliteAgentRunUnitOfWork>();

afterEach(async () => {
  await Promise.all([...openUnits].map(closeUnitWithDeadline));
  openUnits.clear();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('AgentEffectDispatchService with SQLite', () => {
  it('executes an authorized effect and preserves its output and result after reopen', async () => {
    const root = createRoot();
    const first = openUnit(root);
    await createAuthorizedEffect(first);
    const executor: AgentEffectExecutor = {
      execute: vi.fn(async (request) => {
        expect(request).toMatchObject({
          runId: RUN_ID,
          effectId: EFFECT_ID,
          tool: EFFECT_PINNED_TOOL,
          idempotencyKey: `${RUN_ID}:tool-call-1`,
          input: EFFECT_INPUT,
        });
        return {
          status: 'succeeded' as const,
          outputRef: 'artifact:effect-result',
          result: { written: true, bytes: 21 },
        };
      }),
    };
    const dispatcher = createDispatcher(first, executor);

    const dispatched = await dispatcher.dispatch(dispatchRequest(4));

    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(dispatched).toMatchObject({
      status: 'succeeded',
      alreadySettled: false,
      run: { version: 6 },
      effect: {
        state: { status: 'succeeded', outputRef: 'artifact:effect-result' },
      },
    });
    await closeUnit(first);

    const reopened = openUnit(root);
    const persistedRun = await loadRun(reopened);
    expect(persistedRun).toMatchObject({
      version: 6,
      effects: [{
        effectId: EFFECT_ID,
        state: { status: 'succeeded', outputRef: 'artifact:effect-result' },
      }],
    });
    const recovery = await reopened.listActiveRuns();
    const recoverable = recovery.items.find((item) => item.run.runId === RUN_ID);
    if (recoverable?.ready !== true || recoverable.phase !== 'resumable') {
      throw new Error('expected_resumable_effect_run');
    }
    const resultReference = recoverable.effectPayloads.find(
      (reference) => reference.effectId === EFFECT_ID,
    );
    if (resultReference?.hasResult !== true) {
      throw new Error('expected_persisted_effect_result');
    }
    await expect(reopened.loadEffectResult(resultReference)).resolves.toEqual({
      written: true,
      bytes: 21,
    });
  });

  it('requires recovery after a committed start_effect and never calls the executor after reopen', async () => {
    const root = createRoot();
    const first = openUnit(root);
    const authorized = await createAuthorizedEffect(first);
    const commands = new AgentRunCommandService(first);
    await commands.execute({
      kind: 'run.start_effect',
      commandId: `${DISPATCH_COMMAND_ID}:effect-start`,
      runId: RUN_ID,
      expectedVersion: authorized.version,
      occurredAt: at(4),
      effectId: EFFECT_ID,
    }, {
      checkpoint: dispatchCheckpointFactory.create({
        run: authorized,
        effect: authorized.effects[0]!,
        checkpointVersion: authorized.state.checkpointVersion + 1,
        phase: 'effect_started',
        occurredAt: at(4),
      }),
      turnInputPayloads: [],
      effectPayloads: [],
    });
    await closeUnit(first);

    const reopened = openUnit(root);
    const executor: AgentEffectExecutor = {
      execute: vi.fn(async () => ({
        status: 'succeeded' as const,
        result: { mustNotRun: true },
      })),
    };
    const dispatcher = createDispatcher(reopened, executor);

    await expect(dispatcher.dispatch(dispatchRequest(5)))
      .rejects.toBeInstanceOf(AgentEffectDispatchRecoveryRequiredError);
    expect(executor.execute).not.toHaveBeenCalled();
    await expect(loadRun(reopened)).resolves.toMatchObject({
      version: 5,
      state: { status: 'running', checkpointVersion: 4 },
      effects: [{ effectId: EFFECT_ID, state: { status: 'started' } }],
    });
  });

  it('persists executor exceptions only as normalized uncertain recovery without raw error text or secrets', async () => {
    const root = createRoot();
    const first = openUnit(root);
    await createAuthorizedEffect(first);
    const executor: AgentEffectExecutor = {
      execute: vi.fn(async () => {
        throw new Error(RAW_EXECUTOR_ERROR);
      }),
    };

    const dispatched = await createDispatcher(first, executor).dispatch(dispatchRequest(4));

    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(dispatched).toMatchObject({
      status: 'uncertain',
      run: {
        version: 6,
        state: {
          status: 'recovering',
          reason: 'uncertain_effect',
          decision: {
            kind: 'recovery',
            effectId: EFFECT_ID,
            allowedActions: ['retry', 'mark_succeeded', 'mark_failed', 'cancel_run'],
          },
        },
      },
      effect: {
        state: {
          status: 'uncertain',
          reason: 'effect_executor_terminated_without_durable_outcome',
        },
      },
    });
    expect(JSON.stringify(dispatched.run)).not.toContain(SECRET_MARKER);
    await closeUnit(first);

    expect(databaseFilesContain(root, RAW_EXECUTOR_ERROR)).toBe(false);
    expect(databaseFilesContain(root, SECRET_MARKER)).toBe(false);

    const reopened = openUnit(root);
    const persistedRun = await loadRun(reopened);
    expect(persistedRun).toMatchObject({
      version: 6,
      state: {
        status: 'recovering',
        decision: { effectId: EFFECT_ID },
      },
      effects: [{
        effectId: EFFECT_ID,
        state: {
          status: 'uncertain',
          reason: 'effect_executor_terminated_without_durable_outcome',
        },
      }],
    });
    expect(JSON.stringify(persistedRun)).not.toContain(RAW_EXECUTOR_ERROR);
    const persistedText = readPersistedText(resolveAgentControlDatabasePath(root));
    expect(persistedText).not.toContain(RAW_EXECUTOR_ERROR);
    expect(persistedText).not.toContain(SECRET_MARKER);
    expect(persistedText).toContain('effect_executor_terminated_without_durable_outcome');
  });
});

const persistenceClock: AgentPersistenceClock = {
  now: () => new Date(at(10)),
};

const dispatchCheckpointFactory: AgentEffectDispatchCheckpointFactory = {
  create: ({ checkpointVersion, phase, effect, occurredAt }) => ({
    checkpointVersion,
    createdAt: occurredAt,
    payload: {
      format: 'ariadne.agent-checkpoint',
      schemaVersion: 1,
      engineContinuation: { phase, effectId: effect.effectId },
      modelContext: null,
    },
  }),
};

function createDispatcher(
  unitOfWork: SqliteAgentRunUnitOfWork,
  executor: AgentEffectExecutor,
): AgentEffectDispatchService {
  return new AgentEffectDispatchService(
    unitOfWork,
    unitOfWork,
    executor,
    dispatchCheckpointFactory,
    { now: () => at(5) },
  );
}

async function createAuthorizedEffect(unitOfWork: SqliteAgentRunUnitOfWork) {
  const commands = new AgentRunCommandService(unitOfWork);
  const digest = new Sha256AgentEffectInputDigester().digest(EFFECT_INPUT, {
    runId: RUN_ID,
    effectId: EFFECT_ID,
  });
  await commands.execute({
    kind: 'run.start',
    commandId: 'command-start',
    runId: RUN_ID,
    occurredAt: at(0),
    binding: {
      bindingVersion: 3,
      sessionId: 'session-1',
      objectiveRef: {
        kind: 'conversation_message',
        messageId: 'message-1',
        messageVersion: 1,
        contentDigest: `sha256:${'c'.repeat(64)}`
      },
      workspace: {
        workspaceId: 'workspace-1',
        revision: 1,
        grantDigest: `sha256:${'d'.repeat(64)}`,
        access: 'write',
        scopeIds: ['src/result.ts']
      },
      model: {
        providerId: 'provider-test',
        modelId: 'model-test',
        settingsRevision: 1,
      },
      policy: {
        policyId: 'policy-test',
        revision: 1,
        permissionMode: 'ask',
      },
      capabilities: [{
        capabilityId: 'workspace.write',
        scopeIds: ['src/result.ts']
      }],
      toolCatalog: {
        catalogId: 'effect-dispatch-test-tools',
        revision: 1,
        digest: EFFECT_TOOL_CATALOG_DIGEST,
        allowedToolNames: ['workspace.write']
      },
      budget: {
        grantId: 'grant-effect-dispatch-sqlite',
        runId: RUN_ID,
        vector: {
          modelTurns: 10,
          toolCalls: 5,
          readCalls: 0,
          writeCalls: 5,
          shellCalls: 0,
          costMicrousd: 1_000_000
        },
        deadlineAt: '2031-01-01T00:00:00.000Z',
        source: { kind: 'root' }
      },
    },
  }, { turnInputPayloads: [], effectPayloads: [] });
  await commands.execute({
    kind: 'run.begin',
    commandId: 'command-begin',
    runId: RUN_ID,
    expectedVersion: 1,
    occurredAt: at(1),
  }, checkpointArtifacts(1, 'run_begun', at(1)));
  await commands.execute({
    kind: 'run.register_effect',
    commandId: 'command-register-effect',
    runId: RUN_ID,
    expectedVersion: 2,
    occurredAt: at(2),
    effect: {
      effectId: EFFECT_ID,
      toolCallId: 'tool-call-1',
      tool: EFFECT_PINNED_TOOL,
      idempotencyKey: `${RUN_ID}:tool-call-1`,
      capabilityIds: ['workspace.write'],
      scope: ['src/result.ts'],
      inputDigest: digest,
    },
  }, {
    ...checkpointArtifacts(2, 'effect_intended', at(2)),
    effectPayloads: [{
      kind: 'record_input',
      effectId: EFFECT_ID,
      inputDigest: digest,
      input: EFFECT_INPUT,
      recordedAt: at(2),
    }],
  });
  const authorized = await commands.execute({
    kind: 'run.authorize_effect',
    commandId: 'command-authorize-effect',
    runId: RUN_ID,
    expectedVersion: 3,
    occurredAt: at(3),
    effectId: EFFECT_ID,
  }, checkpointArtifacts(3, 'effect_authorized', at(3)));
  return authorized.run;
}

function checkpointArtifacts(
  checkpointVersion: number,
  phase: string,
  createdAt: string,
): {
  readonly checkpoint: AgentRunCheckpointCommit;
  readonly turnInputPayloads: readonly [];
  readonly effectPayloads: readonly [];
} {
  return {
    checkpoint: {
      checkpointVersion,
      createdAt,
      payload: {
        format: 'ariadne.agent-checkpoint',
        schemaVersion: 1,
        engineContinuation: { phase },
        modelContext: null,
      },
    },
    turnInputPayloads: [],
    effectPayloads: [],
  };
}

function dispatchRequest(expectedVersion: number) {
  return {
    commandId: DISPATCH_COMMAND_ID,
    runId: RUN_ID,
    effectId: EFFECT_ID,
    expectedVersion,
    occurredAt: at(4),
  } as const;
}

async function loadRun(unitOfWork: SqliteAgentRunUnitOfWork) {
  const run = await unitOfWork.transaction((transaction) => transaction.loadRun(RUN_ID));
  if (run === null) throw new Error('expected_persisted_run');
  return run;
}

function createRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-effect-dispatch-sqlite-'));
  roots.push(root);
  return root;
}

function openUnit(root: string): SqliteAgentRunUnitOfWork {
  const unit = new SqliteAgentRunUnitOfWork(
    root,
    undefined,
    persistenceClock,
  );
  openUnits.add(unit);
  return unit;
}

async function closeUnit(unit: SqliteAgentRunUnitOfWork): Promise<void> {
  if (!openUnits.delete(unit)) return;
  await closeUnitWithDeadline(unit);
}

async function closeUnitWithDeadline(unit: SqliteAgentRunUnitOfWork): Promise<void> {
  const context = createShutdownContext(Date.now() + 5_000);
  try {
    await unit.close(context);
  } finally {
    context.dispose();
  }
}

function at(offsetSeconds: number): string {
  return new Date(Date.UTC(2030, 0, 1, 0, 0, offsetSeconds)).toISOString();
}

function databaseFilesContain(root: string, value: string): boolean {
  const directory = path.dirname(resolveAgentControlDatabasePath(root));
  const needle = Buffer.from(value, 'utf8');
  return readdirSync(directory).some((name) => {
    const file = path.join(directory, name);
    return statSync(file).isFile() && readFileSync(file).includes(needle);
  });
}

function readPersistedText(databasePath: string): string {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database.prepare(`
      SELECT aggregate_json AS value FROM agent_v3_runs
      UNION ALL SELECT result_run_json FROM agent_v3_command_runs
      UNION ALL SELECT event_json FROM agent_v3_events
      UNION ALL SELECT event_json FROM agent_v3_outbox
      UNION ALL SELECT payload_json FROM agent_v3_checkpoints
      UNION ALL SELECT input_payload_json FROM agent_v3_effect_payloads
      UNION ALL SELECT result_payload_json FROM agent_v3_effect_payloads
    `).all() as Array<{ value: string | null }>;
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    return rows.map((row) => row.value ?? '').join('\n');
  } finally {
    database.close();
  }
}
