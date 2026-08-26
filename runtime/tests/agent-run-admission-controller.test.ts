import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  deriveStableAgentId,
  type AgentRunRecoveryPayloadReader
} from '@ariadne/agent-core';
import { afterEach, describe, expect, it } from 'vitest';

import { SqliteAgentRunUnitOfWork } from '../src/adapters/persistence/SqliteAgentRunUnitOfWork.js';
import { resolveAgentControlDatabasePath } from '../src/adapters/persistence/agentControlDbSchema.js';
import {
  AgentRunAdmissionController,
  deriveAgentAdmissionCommandId,
  type AgentRunAdmissionStore,
  type AgentRunAdmissionSnapshot,
  type AgentRunAdmissionSnapshotReader,
  type AgentRunRequestedHandoffMessage
} from '../src/control/run/AgentRunAdmissionController.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';

const OBJECTIVE_DIGEST = `sha256:${'a'.repeat(64)}`;
const CATALOG_DIGEST = `sha256:${'b'.repeat(64)}`;
const WORKSPACE_GRANT_DIGEST = `sha256:${'c'.repeat(64)}`;
const TOOL_CONTRACT_DIGEST = `sha256:${'d'.repeat(64)}`;
const roots: string[] = [];
const openUnits = new Set<SqliteAgentRunUnitOfWork>();

afterEach(async () => {
  await Promise.all([...openUnits].map(closeUnit));
  openUnits.clear();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('AgentRunAdmissionController', () => {
  it('atomically admits one handoff and collapses concurrent duplicates', async () => {
    const request = await requestedMessage();
    const unit = createUnit();
    const snapshotReader = new DeferredSnapshotReader(await snapshot(request));
    const controller = new AgentRunAdmissionController(
      unit.store,
      snapshotReader
    );

    const first = controller.admit(request);
    const duplicate = controller.admit(request);
    snapshotReader.release();
    const [left, right] = await Promise.all([first, duplicate]);

    expect(left).toEqual(right);
    expect(left).toMatchObject({
      replayed: false,
      run: {
        version: 1,
        state: { status: 'running' },
        turns: [{ attempts: [{ state: { status: 'intended' } }] }]
      }
    });
    expect(snapshotReader.calls).toBe(1);
    expect(agentControlCounts(unit.root)).toEqual({
      runs: 1,
      commands: 1,
      events: 4,
      checkpoints: 1
    });
    const persisted = await unit.store.loadCommittedCommandReceipt(request.agentCommandId);
    const checkpoint = await unit.store.loadCheckpoint({
      runId: left.runId,
      runVersion: 1,
      checkpointVersion: 1,
      commandId: request.agentCommandId,
      createdAt: request.occurredAt
    });
    expect(JSON.stringify({ persisted, checkpoint })).not.toContain('raw user prompt');
  });

  it('replays a durable receipt without rereading objective or catalog inputs', async () => {
    const request = await requestedMessage();
    const unit = createUnit();
    const firstReader = new SnapshotReader(await snapshot(request));
    const firstController = new AgentRunAdmissionController(
      unit.store,
      firstReader
    );
    const admitted = await firstController.admit(request);
    expect(firstReader.calls).toBe(1);

    const forbiddenReader: AgentRunAdmissionSnapshotReader = {
      readAdmissionSnapshot: async () => {
        throw new Error('snapshot_must_not_be_read_on_receipt_replay');
      }
    };
    const replay = await new AgentRunAdmissionController(
      unit.store,
      forbiddenReader
    ).admit(request);
    expect(replay).toEqual({ ...admitted, replayed: true });
    expect(agentControlCounts(unit.root).commands).toBe(1);
  });

  it('rejects command identity, snapshot, and receipt objective drift', async () => {
    const request = await requestedMessage();
    const unit = createUnit();
    const controller = new AgentRunAdmissionController(
      unit.store,
      new SnapshotReader(await snapshot(request))
    );
    await expect(controller.admit({
      ...request,
      agentCommandId: 'agent-command-forged'
    })).rejects.toMatchObject({ code: 'AGENT_ADMISSION_COMMAND_ID_MISMATCH' });
    await expect(new AgentRunAdmissionController(
      unit.store,
      new SnapshotReader({
        ...await snapshot(request),
        objectiveDigest: `sha256:${'e'.repeat(64)}`
      })
    ).admit(request)).rejects.toMatchObject({ code: 'AGENT_ADMISSION_SNAPSHOT_MISMATCH' });

    const admitted = await controller.admit(request);
    expect(admitted.replayed).toBe(false);
    const tamperedRecoveryReader: AgentRunRecoveryPayloadReader = {
      loadCheckpoint: async (reference) => {
        const checkpoint = await unit.store.loadCheckpoint(reference);
        return {
          ...checkpoint,
          payload: {
            ...checkpoint.payload,
            engineContinuation: {
              ...(checkpoint.payload.engineContinuation as Record<string, unknown>),
              rawPrompt: 'must never be accepted from a receipt'
            }
          }
        };
      },
      loadEffectInput: (reference) => unit.store.loadEffectInput(reference),
      loadEffectResult: (reference) => unit.store.loadEffectResult(reference)
    };
    const tamperedStore: AgentRunAdmissionStore = {
      transaction: (operation) => unit.store.transaction(operation),
      loadCommittedCommandReceipt: (commandId) => (
        unit.store.loadCommittedCommandReceipt(commandId)
      ),
      ...tamperedRecoveryReader
    };
    await expect(new AgentRunAdmissionController(
      tamperedStore,
      new SnapshotReader(await snapshot(request))
    ).admit(request)).rejects.toMatchObject({
      code: 'AGENT_ADMISSION_RECEIPT_CONFLICT'
    });
  });

  it('rejects non-canonical, unsupported, or hidden handoff fields before storage', async () => {
    const request = await requestedMessage();
    const unit = createUnit();
    const controller = new AgentRunAdmissionController(
      unit.store,
      new SnapshotReader(await snapshot(request))
    );

    await expect(controller.admit({
      ...request,
      occurredAt: '2030-02-30T00:00:00.000Z'
    })).rejects.toMatchObject({ code: 'AGENT_ADMISSION_REQUEST_INVALID' });
    await expect(controller.admit({
      ...request,
      messageId: ' outbox-run-request'
    })).rejects.toMatchObject({ code: 'AGENT_ADMISSION_REQUEST_INVALID' });
    await expect(controller.admit({
      ...request,
      rawPrompt: 'hidden secret'
    } as AgentRunRequestedHandoffMessage)).rejects.toMatchObject({
      code: 'AGENT_ADMISSION_REQUEST_INVALID'
    });
    expect(agentControlCounts(unit.root).commands).toBe(0);
  });
});

class SnapshotReader implements AgentRunAdmissionSnapshotReader {
  public calls = 0;
  public constructor(private readonly value: AgentRunAdmissionSnapshot) {}
  public async readAdmissionSnapshot(): Promise<AgentRunAdmissionSnapshot> {
    this.calls += 1;
    return structuredClone(this.value);
  }
}

class DeferredSnapshotReader extends SnapshotReader {
  private resolver?: () => void;
  private readonly barrier = new Promise<void>((resolve) => {
    this.resolver = resolve;
  });
  public release(): void {
    this.resolver?.();
  }
  public override async readAdmissionSnapshot(): Promise<AgentRunAdmissionSnapshot> {
    await this.barrier;
    return super.readAdmissionSnapshot();
  }
}

async function requestedMessage(): Promise<AgentRunRequestedHandoffMessage> {
  const base = {
    messageId: 'outbox-run-request',
    kind: 'agent.run.requested' as const,
    sagaId: 'saga-admission',
    sagaVersion: 2,
    sessionId: 'session-admission',
    workspaceId: 'workspace-admission',
    objectiveMessageId: 'message-admission',
    objectiveMessageVersion: 1,
    objectiveDigest: OBJECTIVE_DIGEST,
    runRequestId: 'run-request-admission',
    causationId: 'inbox-run-request',
    occurredAt: '2030-01-01T00:00:00.000Z'
  };
  return {
    ...base,
    agentCommandId: await deriveAgentAdmissionCommandId(base)
  };
}

async function snapshot(
  request: AgentRunRequestedHandoffMessage
): Promise<AgentRunAdmissionSnapshot> {
  const runId = await deriveStableAgentId(
    'agent-run',
    request.agentCommandId,
    request.runRequestId
  );
  return {
    sessionId: 'session-admission',
    workspaceId: 'workspace-admission',
    messageId: 'message-admission',
    messageVersion: 1,
    objectiveDigest: OBJECTIVE_DIGEST,
    binding: {
      bindingVersion: 3,
      sessionId: 'session-admission',
      objectiveRef: {
        kind: 'conversation_message',
        messageId: 'message-admission',
        messageVersion: 1,
        contentDigest: OBJECTIVE_DIGEST
      },
      workspace: {
        workspaceId: 'workspace-admission',
        revision: 1,
        grantDigest: WORKSPACE_GRANT_DIGEST,
        access: 'write',
        scopeIds: ['workspace']
      },
      model: {
        providerId: 'provider-admission',
        modelId: 'model-admission',
        settingsRevision: 1
      },
      policy: {
        policyId: 'policy-admission',
        revision: 1,
        permissionMode: 'ask'
      },
      capabilities: [{
        capabilityId: 'workspace.read',
        scopeIds: ['workspace']
      }],
      toolCatalog: {
        catalogId: 'catalog-admission',
        revision: 1,
        digest: CATALOG_DIGEST,
        allowedToolNames: ['workspace.read']
      },
      budget: {
        grantId: 'grant-admission',
        runId,
        vector: {
          modelTurns: 12,
          toolCalls: 8,
          readCalls: 8,
          writeCalls: 0,
          shellCalls: 0,
          costMicrousd: 1_000_000
        },
        deadlineAt: '2031-01-01T00:00:00.000Z',
        source: { kind: 'root' }
      }
    },
    input: {
      messages: [{ kind: 'text', role: 'user', content: 'raw user prompt stays outside the Run' }],
      availableTools: [{
        tool: {
          catalogId: 'catalog-admission',
          revision: 1,
          digest: CATALOG_DIGEST,
          toolName: 'workspace.read',
          toolVersion: '1.0.0',
          providerId: 'ariadne.builtin',
          contractDigest: TOOL_CONTRACT_DIGEST
        },
        capabilityIds: ['workspace.read']
      }]
    }
  };
}

function createUnit(): {
  readonly root: string;
  readonly store: SqliteAgentRunUnitOfWork;
} {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-admission-controller-'));
  roots.push(root);
  const store = new SqliteAgentRunUnitOfWork(root);
  openUnits.add(store);
  return { root, store };
}

function agentControlCounts(root: string): {
  readonly runs: number;
  readonly commands: number;
  readonly events: number;
  readonly checkpoints: number;
} {
  const database = new DatabaseSync(resolveAgentControlDatabasePath(root), {
    readOnly: true
  });
  try {
    const count = (table: string): number => Number((database.prepare(
      `SELECT COUNT(*) AS count FROM ${table}`
    ).get() as { count: number }).count);
    return {
      runs: count('agent_v3_runs'),
      commands: count('agent_v3_commands'),
      events: count('agent_v3_events'),
      checkpoints: count('agent_v3_checkpoints')
    };
  } finally {
    database.close();
  }
}

async function closeUnit(unit: SqliteAgentRunUnitOfWork): Promise<void> {
  const context = createShutdownContext(Date.now() + 5_000);
  try {
    await unit.close(context);
  } finally {
    context.dispose();
  }
}
