import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  AgentRunAdmissionService,
  digestAgentTurnInput,
  summarizeAgentTurnInput,
  type AdmitAgentRunRequest
} from '@ariadne/agent-core';
import { afterEach, describe, expect, it } from 'vitest';

import { SqliteAgentRunUnitOfWork } from '../src/adapters/persistence/SqliteAgentRunUnitOfWork.js';
import { resolveAgentControlDatabasePath } from '../src/adapters/persistence/agentControlDbSchema.js';
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

describe('SQLite Agent Run admission', () => {
  it('atomically persists and replays Run, first Turn, checkpoint, events, outbox, and receipt', async () => {
    const root = createRoot();
    const request = await admissionRequest();
    const firstUnit = track(new SqliteAgentRunUnitOfWork(root));
    const first = await new AgentRunAdmissionService(firstUnit).admit(request);

    expect(first).toMatchObject({
      replayed: false,
      run: {
        runId: request.command.runId,
        version: 1,
        state: {
          status: 'running',
          checkpointVersion: 1
        },
        turns: [{
          turnId: request.command.turn.turnId,
          intention: {
            expectedRunVersion: null,
            checkpointVersion: 1,
            inputDigest: request.command.turn.inputDigest
          },
          attempts: [{
            attemptId: request.command.turn.attemptId,
            providerIdempotencyKey: request.command.turn.providerIdempotencyKey,
            state: { status: 'intended' }
          }]
        }]
      }
    });
    expect(first.events.map((event) => event.payload.type)).toEqual([
      'run.admitted',
      'run.state_changed',
      'turn.registered',
      'inference_attempt.registered'
    ]);
    expect(await firstUnit.loadRunVersion(request.command.runId, 1))
      .toEqual(first.run);
    await expect(firstUnit.loadCommittedCommandReceipt(request.command.commandId))
      .resolves.toMatchObject({
        mutations: [{
          resultingVersion: 1,
          run: first.run,
          events: first.events
        }]
      });
    expect(agentControlCounts(root)).toEqual({
      runs: 1,
      commands: 1,
      events: 4,
      outbox: 4,
      checkpoints: 1,
      effectPayloads: 0
    });

    await closeTracked(firstUnit);
    const reopened = track(new SqliteAgentRunUnitOfWork(root));
    const replay = await new AgentRunAdmissionService(reopened).admit(request);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(agentControlCounts(root)).toEqual({
      runs: 1,
      commands: 1,
      events: 4,
      outbox: 4,
      checkpoints: 1,
      effectPayloads: 0
    });
    await expect(reopened.loadRunVersion(request.command.runId, 1))
      .resolves.toEqual(first.run);

    await expect(new AgentRunAdmissionService(reopened).admit({
      ...request,
      command: {
        ...request.command,
        turn: {
          ...request.command.turn,
          inputDigest: `sha256:${'f'.repeat(64)}`
        }
      }
    })).rejects.toMatchObject({
      code: 'AGENT_RUN_COMMAND_CONFLICT',
      reason: 'command_mismatch'
    });
    expect(agentControlCounts(root)).toEqual({
      runs: 1,
      commands: 1,
      events: 4,
      outbox: 4,
      checkpoints: 1,
      effectPayloads: 0
    });
  });
});

async function admissionRequest(): Promise<AdmitAgentRunRequest> {
  const catalogDigest = `sha256:${'a'.repeat(64)}`;
  const objectiveDigest = `sha256:${'b'.repeat(64)}`;
  const cause = {
    kind: 'conversation_objective' as const,
    messageId: 'sqlite-admission-message',
    messageVersion: 1,
    contentDigest: objectiveDigest
  };
  const input = {
    messages: [{
      kind: 'text' as const,
      role: 'user' as const,
      content: 'Persist admission atomically.'
    }],
    availableTools: [{
      tool: {
        catalogId: 'sqlite-admission-tools',
        revision: 1,
        digest: catalogDigest,
        toolName: 'workspace.read',
        toolVersion: '1.0.0',
        providerId: 'ariadne.builtin',
        contractDigest: `sha256:${'c'.repeat(64)}`
      },
      capabilityIds: ['workspace.read']
    }]
  };
  return {
    command: {
      kind: 'run.admit',
      commandId: 'sqlite-admission-command',
      runId: 'sqlite-admission-run',
      occurredAt: at(0),
      binding: {
        bindingVersion: 3,
        sessionId: 'sqlite-admission-session',
        objectiveRef: {
          kind: 'conversation_message',
          messageId: 'sqlite-admission-message',
          messageVersion: 1,
          contentDigest: objectiveDigest
        },
        workspace: {
          workspaceId: 'sqlite-admission-workspace',
          revision: 1,
          grantDigest: `sha256:${'d'.repeat(64)}`,
          access: 'write',
          scopeIds: ['workspace']
        },
        model: {
          providerId: 'sqlite-admission-provider',
          modelId: 'sqlite-admission-model',
          settingsRevision: 1
        },
        policy: {
          policyId: 'sqlite-admission-policy',
          revision: 1,
          permissionMode: 'ask'
        },
        capabilities: [{
          capabilityId: 'workspace.read',
          scopeIds: ['workspace']
        }],
        toolCatalog: {
          catalogId: 'sqlite-admission-tools',
          revision: 1,
          digest: catalogDigest,
          allowedToolNames: ['workspace.read']
        },
        budget: {
          grantId: 'grant-sqlite-admission-run',
          runId: 'sqlite-admission-run',
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
      turn: {
        cause,
        turnId: 'sqlite-admission-turn',
        attemptId: 'sqlite-admission-attempt',
        providerIdempotencyKey: 'sqlite-admission-provider-key',
        inputDigest: await digestAgentTurnInput(input),
        inputSummary: summarizeAgentTurnInput(input)
      }
    },
    checkpoint: {
      format: 'ariadne.agent-checkpoint',
      schemaVersion: 1,
      engineContinuation: { phase: 'admitted' },
      modelContext: []
    },
    turnInput: {
      format: 'ariadne.agent-turn-input',
      schemaVersion: 1,
      runId: 'sqlite-admission-run',
      turnId: 'sqlite-admission-turn',
      cause,
      authorityRef: {
        kind: 'conversation_message',
        sessionId: 'sqlite-admission-session',
        workspaceId: 'sqlite-admission-workspace',
        messageId: 'sqlite-admission-message',
        messageVersion: 1,
        contentDigest: objectiveDigest
      },
      messages: input.messages,
      availableTools: input.availableTools
    }
  };
}

function agentControlCounts(root: string): {
  readonly runs: number;
  readonly commands: number;
  readonly events: number;
  readonly outbox: number;
  readonly checkpoints: number;
  readonly effectPayloads: number;
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
      outbox: count('agent_v3_outbox'),
      checkpoints: count('agent_v3_checkpoints'),
      effectPayloads: count('agent_v3_effect_payloads')
    };
  } finally {
    database.close();
  }
}

function createRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-sqlite-admission-'));
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

function at(offsetSeconds: number): string {
  return new Date(Date.UTC(2030, 0, 1, 0, 0, offsetSeconds)).toISOString();
}
