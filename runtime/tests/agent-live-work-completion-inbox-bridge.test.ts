import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  AgentRunCommandService,
  digestAgentTurnInput,
  summarizeAgentTurnInput,
  type AgentJsonValue,
  type AgentRunBinding,
  type AgentRunCheckpointCommit,
  type AgentTurnInputSnapshotV1
} from '@ariadne/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SqliteAgentRunUnitOfWork } from '../src/adapters/persistence/SqliteAgentRunUnitOfWork.js';
import { StrictJsonAgentPersistencePayloadCodec } from '../src/adapters/persistence/StrictJsonAgentPersistencePayloadCodec.js';
import { Sha256AgentEffectInputDigester } from '../src/adapters/persistence/Sha256AgentEffectInputDigester.js';
import { AgentLiveWorkCompletionInboxBridge } from '../src/control/execution/AgentLiveWorkCompletionInboxBridge.js';
import { AgentLiveWorkStartupRecovery } from '../src/control/execution/AgentLiveWorkStartupRecovery.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';

const roots: string[] = [];
const units = new Set<SqliteAgentRunUnitOfWork>();

afterEach(async () => {
  await Promise.all([...units].map(closeUnit));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('AgentLiveWorkCompletionInboxBridge', () => {
  it('commits one system-originated inbox input before waking Agent consumers', async () => {
    const unit = openUnit();
    await admitRun(unit);
    const wakeWorkScheduler = vi.fn();
    const wakeProjectionDrain = vi.fn();
    const bridge = new AgentLiveWorkCompletionInboxBridge(unit, {
      wakeWorkScheduler,
      wakeProjectionDrain
    });
    const notification = {
      runId: 'run-live-work-notice',
      workspaceId: 'workspace-live-work-notice',
      jobId: 'job-live-work-notice',
      workKind: 'process',
      status: 'completed' as const,
      finishedAt: at(1),
      outputCursor: 42,
      exitCode: 0
    };

    await bridge.notify(notification);
    const run = await unit.transaction((transaction) => (
      transaction.loadRun(notification.runId)
    ));
    expect(run?.inbox).toEqual([expect.objectContaining({
      delivery: 'next_step',
      state: 'queued',
      source: {
        kind: 'live_work',
        jobId: notification.jobId,
        workKind: 'process',
        status: 'completed'
      }
    })]);
    expect(run?.inbox[0]?.content).toContain('workspace.job_output');
    expect(wakeWorkScheduler).toHaveBeenCalledTimes(1);
    expect(wakeProjectionDrain).toHaveBeenCalledTimes(1);

    await bridge.notify(notification);
    expect(wakeWorkScheduler).toHaveBeenCalledTimes(1);
    expect((await unit.transaction((transaction) => (
      transaction.loadRun(notification.runId)
    )))?.inbox).toHaveLength(1);
  });

  it('rebuilds one durable interrupted inbox fact after reopening SQLite', async () => {
    const root = createRoot();
    const first = openUnitAt(root);
    await persistRunningProcessStart(first);
    await closeUnit(first);

    const reopened = openUnitAt(root);
    const wakeWorkScheduler = vi.fn();
    const wakeProjectionDrain = vi.fn();
    const bridge = new AgentLiveWorkCompletionInboxBridge(reopened, {
      wakeWorkScheduler,
      wakeProjectionDrain
    });
    const recovery = new AgentLiveWorkStartupRecovery(
      reopened,
      bridge,
      () => new Date(at(9))
    );

    await recovery.reconcile();
    await recovery.reconcile();

    const run = await reopened.transaction((transaction) => (
      transaction.loadRun('run-live-work-restart')
    ));
    expect(run?.inbox).toEqual([expect.objectContaining({
      state: 'queued',
      source: {
        kind: 'live_work',
        jobId: 'job-live-work-restart',
        workKind: 'process',
        status: 'interrupted'
      }
    })]);
    expect(run?.inbox[0]?.content).toContain('Runtime restart');
    expect(run?.inbox[0]?.content).toContain('no longer available');
    expect(run?.inbox[0]?.content).not.toContain('workspace.job_output');
    expect(wakeWorkScheduler).toHaveBeenCalledTimes(1);
    expect(wakeProjectionDrain).toHaveBeenCalledTimes(1);
  });
});

async function persistRunningProcessStart(unit: SqliteAgentRunUnitOfWork): Promise<void> {
  const runId = 'run-live-work-restart';
  const effectId = 'effect-live-work-restart';
  const input: AgentJsonValue = { command: 'node', args: ['worker.js'] };
  const inputDigest = new Sha256AgentEffectInputDigester().digest(input, { runId, effectId });
  const commands = new AgentRunCommandService(unit);
  const binding = restartRunBinding(runId);
  await commands.execute({
    kind: 'run.start',
    commandId: 'command-start-live-work-restart',
    runId,
    occurredAt: at(0),
    binding
  }, { turnInputPayloads: [], effectPayloads: [] });
  await commands.execute({
    kind: 'run.begin',
    commandId: 'command-begin-live-work-restart',
    runId,
    expectedVersion: 1,
    occurredAt: at(1)
  }, checkpointArtifacts(1, at(1)));
  await commands.execute({
    kind: 'run.register_effect',
    commandId: 'command-register-live-work-restart',
    runId,
    expectedVersion: 2,
    occurredAt: at(2),
    effect: {
      effectId,
      toolCallId: 'tool-call-live-work-restart',
      tool: {
        catalogId: binding.toolCatalog.catalogId,
        revision: binding.toolCatalog.revision,
        digest: binding.toolCatalog.digest,
        toolName: 'workspace.process_start',
        toolVersion: '1.0.0',
        providerId: 'ariadne.builtin',
        contractDigest: digest('4')
      },
      idempotencyKey: 'idempotency-live-work-restart',
      capabilityIds: ['workspace.shell'],
      scope: [binding.workspace.workspaceId],
      inputDigest
    }
  }, {
    ...checkpointArtifacts(2, at(2)),
    effectPayloads: [{
      kind: 'record_input',
      effectId,
      inputDigest,
      input,
      recordedAt: at(2)
    }]
  });
  await commands.execute({
    kind: 'run.authorize_effect',
    commandId: 'command-authorize-live-work-restart',
    runId,
    expectedVersion: 3,
    occurredAt: at(3),
    effectId
  }, checkpointArtifacts(3, at(3)));
  await commands.execute({
    kind: 'run.start_effect',
    commandId: 'command-effect-start-live-work-restart',
    runId,
    expectedVersion: 4,
    occurredAt: at(4),
    effectId
  }, checkpointArtifacts(4, at(4)));
  await commands.execute({
    kind: 'run.record_effect_result',
    commandId: 'command-effect-result-live-work-restart',
    runId,
    expectedVersion: 5,
    occurredAt: at(5),
    effectId,
    result: { status: 'succeeded' }
  }, {
    ...checkpointArtifacts(5, at(5)),
    effectPayloads: [{
      kind: 'record_result',
      effectId,
      inputDigest,
      result: {
        jobId: 'job-live-work-restart',
        kind: 'process',
        status: 'running',
        outputCursor: 7
      },
      recordedAt: at(5)
    }]
  });
}

function restartRunBinding(runId: string): AgentRunBinding {
  return {
    ...runBinding(runId),
    sessionId: 'session-live-work-restart',
    objectiveRef: {
      kind: 'conversation_message',
      messageId: 'message-live-work-restart',
      messageVersion: 1,
      contentDigest: digest('1')
    },
    workspace: {
      workspaceId: 'workspace-live-work-restart',
      revision: 1,
      grantDigest: digest('2'),
      access: 'write',
      scopeIds: ['workspace-live-work-restart']
    },
    capabilities: [{
      capabilityId: 'workspace.shell',
      scopeIds: ['workspace-live-work-restart']
    }],
    toolCatalog: {
      catalogId: 'catalog-live-work-restart',
      revision: 1,
      digest: digest('3'),
      allowedToolNames: ['workspace.process_start']
    },
    budget: {
      ...runBinding(runId).budget,
      grantId: 'grant-live-work-restart',
      runId
    }
  };
}

function checkpointArtifacts(checkpointVersion: number, createdAt: string) {
  return {
    checkpoint: {
      checkpointVersion,
      createdAt,
      payload: {
        format: 'ariadne.agent-checkpoint' as const,
        schemaVersion: 1 as const,
        engineContinuation: { phase: 'live_work_restart_test' },
        modelContext: []
      }
    },
    turnInputPayloads: [] as const,
    effectPayloads: [] as const
  };
}

async function admitRun(unit: SqliteAgentRunUnitOfWork): Promise<void> {
  const runId = 'run-live-work-notice';
  const turnId = 'turn-live-work-notice';
  const binding = runBinding(runId);
  const input = {
    messages: [{ kind: 'text' as const, role: 'user' as const, content: 'Start work.' }],
    availableTools: []
  };
  const inputDigest = await digestAgentTurnInput(input);
  const turnInput: AgentTurnInputSnapshotV1 = {
    format: 'ariadne.agent-turn-input',
    schemaVersion: 1,
    runId,
    turnId,
    cause: {
      kind: 'conversation_objective',
      messageId: 'message-live-work-notice',
      messageVersion: 1,
      contentDigest: binding.objectiveRef.contentDigest
    },
    authorityRef: {
      kind: 'conversation_message',
      sessionId: binding.sessionId,
      workspaceId: binding.workspace.workspaceId,
      messageId: 'message-live-work-notice',
      messageVersion: 1,
      contentDigest: binding.objectiveRef.contentDigest
    },
    messages: input.messages,
    availableTools: []
  };
  await new AgentRunCommandService(unit).execute({
    kind: 'run.admit',
    commandId: 'command-admit-live-work-notice',
    runId,
    occurredAt: at(0),
    binding,
    turn: {
      cause: turnInput.cause,
      turnId,
      attemptId: 'attempt-live-work-notice',
      providerIdempotencyKey: 'provider-live-work-notice',
      inputDigest,
      inputSummary: summarizeAgentTurnInput(input)
    }
  }, {
    checkpoint: checkpoint(),
    turnInputPayloads: [{
      turnId,
      inputDigest,
      payload: turnInput,
      recordedAt: at(0)
    }],
    effectPayloads: []
  });
}

function runBinding(runId: string): AgentRunBinding {
  return {
    bindingVersion: 3,
    sessionId: 'session-live-work-notice',
    objectiveRef: {
      kind: 'conversation_message',
      messageId: 'message-live-work-notice',
      messageVersion: 1,
      contentDigest: digest('1')
    },
    workspace: {
      workspaceId: 'workspace-live-work-notice',
      revision: 1,
      grantDigest: digest('2'),
      access: 'write',
      scopeIds: ['workspace-live-work-notice']
    },
    model: { providerId: 'provider-test', modelId: 'model-test', settingsRevision: 1 },
    policy: { policyId: 'policy-test', revision: 1, permissionMode: 'trusted' },
    capabilities: [],
    toolCatalog: {
      catalogId: 'catalog-live-work-notice',
      revision: 1,
      digest: digest('3'),
      allowedToolNames: []
    },
    budget: {
      grantId: 'grant-live-work-notice',
      runId,
      vector: {
        modelTurns: 10,
        toolCalls: 10,
        readCalls: 10,
        writeCalls: 10,
        shellCalls: 10,
        costMicrousd: 1_000_000
      },
      deadlineAt: '2031-01-01T00:00:00.000Z',
      source: { kind: 'root' }
    }
  };
}

function checkpoint(): AgentRunCheckpointCommit {
  return {
    checkpointVersion: 1,
    createdAt: at(0),
    payload: {
      format: 'ariadne.agent-checkpoint',
      schemaVersion: 1,
      engineContinuation: { phase: 'admitted' },
      modelContext: []
    }
  };
}

function openUnit(): SqliteAgentRunUnitOfWork {
  return openUnitAt(createRoot());
}

function createRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-live-work-notice-'));
  roots.push(root);
  return root;
}

function openUnitAt(root: string): SqliteAgentRunUnitOfWork {
  const unit = new SqliteAgentRunUnitOfWork(root, new StrictJsonAgentPersistencePayloadCodec());
  units.add(unit);
  return unit;
}

async function closeUnit(unit: SqliteAgentRunUnitOfWork): Promise<void> {
  if (!units.delete(unit)) return;
  const context = createShutdownContext(Date.now() + 5_000);
  try {
    await unit.close(context);
  } finally {
    context.dispose();
  }
}

function at(second: number): string {
  return `2026-08-28T00:00:${String(second).padStart(2, '0')}.000Z`;
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
