import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { AgentRunCommandService } from '@ariadne/agent-core';
import {
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  type RuntimeCommand
} from '@ariadne/protocol/public';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SqliteAgentRunUnitOfWork,
  type AgentPersistenceClock
} from '../src/adapters/persistence/SqliteAgentRunUnitOfWork.js';
import { SqliteConversationRunHandoffUnitOfWork } from '../src/adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import { StrictJsonAgentPersistencePayloadCodec } from '../src/adapters/persistence/StrictJsonAgentPersistencePayloadCodec.js';
import { resolveAgentControlDatabasePath } from '../src/adapters/persistence/agentControlDbSchema.js';
import {
  SqlitePublicProjectionStore
} from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import {
  ComposedAgentControlRuntime
} from '../src/composition/DefaultAgentControlRuntimeFactory.js';
import type {
  AgentControlExecutionPipeline
} from '../src/composition/ProductionAgentControlExecutionPipelineFactory.js';
import { ConversationAuthorityService } from '../src/control/conversation/ConversationAuthorityService.js';
import { ConversationRunHandoffSagaService } from '../src/control/conversation/ConversationRunHandoffSagaService.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';
import type { RuntimeCommandEnvelope } from '../src/ingress/RuntimeIngress.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Agent Control v3 public projection lifecycle', () => {
  it('renames, archives, restores, replays and projects one durable Conversation Session', async () => {
    const root = createRoot();
    const unit = new SqliteAgentRunUnitOfWork(root);
    const conversation = new SqliteConversationRunHandoffUnitOfWork(root);
    const projection = new SqlitePublicProjectionStore(root);
    const times = [at(0), at(1), at(2), at(3)].map((value) => new Date(value));
    const control = new ComposedAgentControlRuntime(
      unit,
      conversation,
      projection,
      undefined,
      {
        publishIntervalMs: 60_000,
        conversationCommandNow: () => times.shift() ?? new Date(at(3))
      }
    );
    const close = closeControl(control);
    try {
      await control.start();
      const create = commandEnvelope({
        kind: 'conversation.session.create.v3',
        contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
        sessionId: 'session-lifecycle',
        workspaceId: 'workspace-lifecycle'
      }, 'create-session-lifecycle');
      await expect(control.executeOwnedCommand(create)).resolves.toMatchObject({
        outcome: { ok: true, result: { kind: 'conversation.session.created.v3', version: 1 } }
      });
      const rename = commandEnvelope({
        kind: 'conversation.session.rename.v3',
        contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
        sessionId: 'session-lifecycle',
        workspaceId: 'workspace-lifecycle',
        expectedSessionVersion: 1,
        title: 'Durable lifecycle'
      }, 'rename-session-lifecycle');
      await expect(control.executeOwnedCommand(rename)).resolves.toMatchObject({
        outcome: { ok: true, result: { kind: 'conversation.session.updated.v3', version: 2 } }
      });
      await expect(control.executeOwnedCommand(commandEnvelope({
        kind: 'conversation.session.archive.v3',
        contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
        sessionId: 'session-lifecycle',
        workspaceId: 'workspace-lifecycle',
        expectedSessionVersion: 2
      }, 'archive-session-lifecycle'))).resolves.toMatchObject({
        outcome: { ok: true, result: { version: 3 } }
      });
      await expect.poll(() => projection.snapshot()).toMatchObject({
        sessions: [{
          sessionId: 'session-lifecycle',
          version: 3,
          title: 'Durable lifecycle',
          status: 'archived'
        }]
      });
      await expect(control.executeOwnedCommand(commandEnvelope({
        kind: 'conversation.session.restore.v3',
        contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
        sessionId: 'session-lifecycle',
        workspaceId: 'workspace-lifecycle',
        expectedSessionVersion: 3
      }, 'restore-session-lifecycle'))).resolves.toMatchObject({
        outcome: { ok: true, result: { version: 4 } }
      });
      await expect(control.executeOwnedCommand(rename)).resolves.toMatchObject({
        outcome: { ok: true, result: { version: 2 } }
      });
      await expect.poll(() => projection.snapshot()).toMatchObject({
        sessions: [{ version: 4, title: 'Durable lifecycle', status: 'active' }]
      });
    } finally {
      await close();
    }
  });

  it('cancels a projected Run through the authoritative v3 command path', async () => {
    const root = createRoot();
    const unit = new SqliteAgentRunUnitOfWork(root);
    const conversation = new SqliteConversationRunHandoffUnitOfWork(root);
    const projection = new SqlitePublicProjectionStore(root);
    const objectiveDigest = await prepareLinkedConversationRun(
      conversation,
      'run-public-cancel'
    );
    await startRun(unit, 'run-public-cancel', objectiveDigest);
    const control = new ComposedAgentControlRuntime(
      unit,
      conversation,
      projection,
      undefined,
      { publishIntervalMs: 60_000 },
      projectionLifecyclePipeline()
    );
    await control.start();
    const envelope = {
      commandId: 'public-cancel-command',
      correlationId: 'public-cancel-command',
      deadlineAt: '2031-01-01T00:00:00.000Z',
      signal: new AbortController().signal,
      command: {
        kind: 'agent.run.cancel.v3' as const,
        contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
        runId: 'run-public-cancel',
        expectedVersion: 1,
        occurredAt: at(3),
        reason: 'user_requested' as const
      }
    };

    await expect(control.executeOwnedCommand(envelope)).resolves.toMatchObject({
      outcome: {
        ok: true,
        result: {
          kind: 'agent.run.cancelled.v3',
          runId: 'run-public-cancel',
          runVersion: 2
        }
      }
    });
    await expect(control.executeOwnedCommand(envelope)).resolves.toMatchObject({
      outcome: { ok: true, result: { runVersion: 2 } }
    });
    await control.shutdown(createShutdownContext(Date.now() + 5_000));
  });

  it('persists, replays, edits, removes, and projects one unified inbox entry', async () => {
    const root = createRoot();
    const unit = new SqliteAgentRunUnitOfWork(root);
    const conversation = new SqliteConversationRunHandoffUnitOfWork(root);
    const projection = new SqlitePublicProjectionStore(root);
    await startRun(unit, 'run-public-inbox');
    const control = new ComposedAgentControlRuntime(
      unit,
      conversation,
      projection,
      undefined,
      {
        publishIntervalMs: 60_000,
        agentInboxCommandNow: () => new Date(at(1))
      },
      projectionLifecyclePipeline()
    );
    const close = closeControl(control);
    try {
      await control.start();
      const enqueue = commandEnvelope({
        kind: 'agent.inbox.enqueue.v3',
        contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
        runId: 'run-public-inbox',
        sessionId: 'session-run-public-inbox',
        inputId: 'input-public-inbox',
        delivery: 'next_step',
        content: 'Inspect the durable inbox before the next step.'
      }, 'enqueue-public-inbox');
      await expect(control.executeOwnedCommand(enqueue)).resolves.toMatchObject({
        outcome: {
          ok: true,
          result: { kind: 'agent.inbox.enqueued.v3', runVersion: 2, inputVersion: 1 }
        }
      });
      await expect(control.executeOwnedCommand(enqueue)).resolves.toMatchObject({
        outcome: { ok: true, result: { runVersion: 2, inputVersion: 1 } }
      });
      await expect.poll(() => projection.snapshot()).toMatchObject({
        runs: [{
          runId: 'run-public-inbox',
          version: 2,
          inbox: [{
            inputId: 'input-public-inbox',
            version: 1,
            delivery: 'next_step',
            state: 'queued'
          }]
        }]
      });

      await expect(control.executeOwnedCommand(commandEnvelope({
        kind: 'agent.inbox.replace.v3',
        contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
        runId: 'run-public-inbox',
        inputId: 'input-public-inbox',
        expectedInputVersion: 1,
        content: 'Use the revised durable inbox input.'
      }, 'replace-public-inbox'))).resolves.toMatchObject({
        outcome: {
          ok: true,
          result: { kind: 'agent.inbox.replaced.v3', runVersion: 3, inputVersion: 2 }
        }
      });
      await expect.poll(() => projection.snapshot()).toMatchObject({
        runs: [{
          version: 3,
          inbox: [{ version: 2, content: 'Use the revised durable inbox input.' }]
        }]
      });

      await expect(control.executeOwnedCommand(commandEnvelope({
        kind: 'agent.inbox.remove.v3',
        contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
        runId: 'run-public-inbox',
        inputId: 'input-public-inbox',
        expectedInputVersion: 2
      }, 'remove-public-inbox'))).resolves.toMatchObject({
        outcome: {
          ok: true,
          result: { kind: 'agent.inbox.removed.v3', runVersion: 4 }
        }
      });
      await expect.poll(() => projection.snapshot()).toMatchObject({
        runs: [{ version: 4, inbox: [] }]
      });
      await expect(unit.transaction((transaction) => (
        transaction.loadRun('run-public-inbox')
      ))).resolves.toMatchObject({ version: 4, inbox: [] });
    } finally {
      await close();
    }
  });

  it('fails startup when durable Handoff work exists without its producer', async () => {
    const root = createRoot();
    const unit = new SqliteAgentRunUnitOfWork(root);
    const conversation = new SqliteConversationRunHandoffUnitOfWork(root);
    const projection = new SqlitePublicProjectionStore(root);
    const authority = new ConversationAuthorityService(conversation);
    await authority.createSession({
      kind: 'conversation.create_session',
      commandId: 'create-pending-handoff-session',
      eventId: 'create-pending-handoff-session-event',
      sessionId: 'pending-handoff-session',
      workspaceId: 'pending-handoff-workspace',
      expectedVersion: null,
      occurredAt: '2030-01-01T00:00:00.000Z'
    });
    await authority.acceptUserMessage({
      kind: 'conversation.accept_user_message',
      commandId: 'accept-pending-handoff-message',
      eventId: 'accept-pending-handoff-message-event',
      sessionId: 'pending-handoff-session',
      workspaceId: 'pending-handoff-workspace',
      expectedSessionVersion: 1,
      messageId: 'pending-handoff-message',
      expectedMessageVersion: null,
      content: 'This accepted fact must never be stranded silently.',
      sagaId: 'pending-handoff-saga',
      handoffCommandId: 'pending-handoff-command',
      handoffOutboxMessageId: 'pending-handoff-outbox',
      occurredAt: '2030-01-01T00:00:01.000Z'
    });
    const control = new ComposedAgentControlRuntime(
      unit,
      conversation,
      projection,
      undefined,
      { publishIntervalMs: 60_000 }
    );

    await expect(control.start()).rejects.toMatchObject({
      message: 'agent_control_public_projection_unhealthy',
      cause: expect.objectContaining({
        message: 'conversation_agent_handoff_producer_required'
      })
    });
    expect(await conversation.countPendingHandoffOutbox()).toBe(1);

    const context = createShutdownContext(Date.now() + 5_000);
    try {
      await control.shutdown(context);
    } finally {
      context.dispose();
    }
    const reopened = new SqliteConversationRunHandoffUnitOfWork(root);
    expect(await reopened.countPendingHandoffOutbox()).toBe(1);
    const reopenContext = createShutdownContext(Date.now() + 5_000);
    try {
      await reopened.close(reopenContext);
    } finally {
      reopenContext.dispose();
    }
  });

  it('fails startup when any active Run exists without its durable work owner', async () => {
    const root = createRoot();
    const unit = new SqliteAgentRunUnitOfWork(root);
    const conversation = new SqliteConversationRunHandoffUnitOfWork(root);
    const projection = new SqlitePublicProjectionStore(root);
    await startRun(unit, 'run-without-work-owner');
    const control = new ComposedAgentControlRuntime(
      unit,
      conversation,
      projection,
      undefined,
      { publishIntervalMs: 60_000 }
    );

    await expect(control.start()).rejects.toMatchObject({
      message: 'agent_control_public_projection_unhealthy',
      cause: expect.objectContaining({
        message: 'agent_run_work_scheduler_required'
      })
    });

    const context = createShutdownContext(Date.now() + 5_000);
    try {
      await control.shutdown(context);
    } finally {
      context.dispose();
    }
  });

  it('drains the Agent outbox into the single v3 Projection Store before ready', async () => {
    const root = createRoot();
    const unit = new SqliteAgentRunUnitOfWork(root);
    const conversation = new SqliteConversationRunHandoffUnitOfWork(root);
    const projection = new SqlitePublicProjectionStore(root);
    await startRun(unit, 'run-production-chain');
    const control = new ComposedAgentControlRuntime(
      unit,
      conversation,
      projection,
      undefined,
      { publishIntervalMs: 60_000 },
      projectionLifecyclePipeline()
    );
    const close = closeControl(control);
    try {
      await control.start();

      await expect(projection.snapshot()).resolves.toMatchObject({
        cursor: 1,
        runs: [{
          runId: 'run-production-chain',
          version: 1,
          status: 'queued'
        }]
      });
      await expect(unit.claimPending({
        claimId: 'post-initial-drain-check',
        leaseMs: 1_000,
        limit: 100
      })).resolves.toEqual([]);
    } finally {
      await close();
    }
  });

  it('does not lose a Projection wake that arrives while an empty drain is settling', async () => {
    const root = createRoot();
    const unit = new SqliteAgentRunUnitOfWork(root);
    const conversation = new SqliteConversationRunHandoffUnitOfWork(root);
    const projection = new SqlitePublicProjectionStore(root);
    const control = new ComposedAgentControlRuntime(
      unit,
      conversation,
      projection,
      undefined,
      {
        publishIntervalMs: 60_000,
        conversationCommandNow: () => new Date('2030-01-01T00:00:00.000Z')
      }
    );
    const close = closeControl(control);
    try {
      await control.start();
      const internals = control as unknown as ProjectionDrainTestInternals;
      const originalPublish = internals.agentPublisher.publishPending
        .bind(internals.agentPublisher);
      const emptyPassReached = deferred<void>();
      const releaseEmptyPass = deferred<void>();
      vi.spyOn(internals.agentPublisher, 'publishPending')
        .mockImplementation(async () => {
          const result = await originalPublish();
          emptyPassReached.resolve();
          await releaseEmptyPass.promise;
          return result;
        });

      // Hold an empty pass after both source scans have observed no work. The
      // accepted Session then wakes Projection while that drain still owns the
      // single-flight slot: this was the exact lost-wake window.
      internals.wakeProjectionDrain();
      await emptyPassReached.promise;
      await expect(control.executeOwnedCommand({
        commandId: 'create-session-during-active-projection-drain',
        correlationId: 'create-session-during-active-projection-drain',
        deadlineAt: '2031-01-01T00:00:00.000Z',
        signal: new AbortController().signal,
        command: {
          kind: 'conversation.session.create.v3',
          contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
          sessionId: 'session-created-during-active-drain',
          workspaceId: 'workspace-created-during-active-drain'
        }
      })).resolves.toMatchObject({ outcome: { ok: true } });
      releaseEmptyPass.resolve();

      await expect.poll(() => projection.snapshot(), {
        timeout: 1_000,
        interval: 5
      }).toMatchObject({
        cursor: 1,
        sessions: [{
          sessionId: 'session-created-during-active-drain',
          version: 1
        }]
      });
    } finally {
      await close();
    }
  });

  it('replays the committed Projection append after a crash before Agent acknowledgement', async () => {
    const root = createRoot();
    const clock = new MutableClock(at(10));
    const unit = new SqliteAgentRunUnitOfWork(
      root,
      new StrictJsonAgentPersistencePayloadCodec(),
      clock
    );
    const conversation = new SqliteConversationRunHandoffUnitOfWork(root);
    await startRun(unit, 'run-append-before-ack');
    let failAfterCommit = true;
    const projection = new SqlitePublicProjectionStore(root, undefined, {
      afterCommit: () => {
        if (!failAfterCommit) return;
        failAfterCommit = false;
        throw new Error('simulated_projection_process_loss_after_commit');
      }
    });
    const control = new ComposedAgentControlRuntime(
      unit,
      conversation,
      projection,
      undefined,
      {
        publishIntervalMs: 60_000,
        publisher: { claimLeaseMs: 1_000 }
      },
      projectionLifecyclePipeline()
    );
    const context = createShutdownContext(Date.now() + 5_000);
    try {
      await expect(control.start()).rejects.toThrow(
        'agent_control_public_projection_unhealthy'
      );
      await expect(projection.snapshot()).resolves.toMatchObject({
        cursor: 1,
        runs: [{ runId: 'run-append-before-ack', version: 1 }]
      });
      expect(outboxPublicationCounts(root)).toEqual({ published: 0, pending: 2 });

      // A new process/store sees the same durable commit. The Agent claim lease
      // expires, exact append replays, and only then are source rows acknowledged.
      await projection.close(context);
      clock.advance(1_001);
      const reopenedProjection = new SqlitePublicProjectionStore(root);
      const recovering = new ComposedAgentControlRuntime(
        unit,
        conversation,
        reopenedProjection,
        undefined,
        {
          publishIntervalMs: 60_000,
          publisher: { claimLeaseMs: 1_000 }
        },
        projectionLifecyclePipeline()
      );
      await recovering.start();
      expect(outboxPublicationCounts(root)).toEqual({ published: 2, pending: 0 });
      await recovering.shutdown(context);
    } finally {
      try {
        await control.shutdown(context);
      } catch {
        // The first lifecycle is intentionally failed; its Projection Store
        // was already closed before the recovery lifecycle acquired ownership.
      }
      context.dispose();
    }
  });

  it('reclaims the previous owner claim before ready without waiting for wall-clock expiry', async () => {
    const root = createRoot();
    const clock = new MutableClock(at(10));
    const firstUnit = new SqliteAgentRunUnitOfWork(
      root,
      new StrictJsonAgentPersistencePayloadCodec(),
      clock
    );
    const firstConversation = new SqliteConversationRunHandoffUnitOfWork(root);
    await startRun(firstUnit, 'run-owner-takeover');
    await expect(firstUnit.claimPending({
      claimId: 'dead-owner-claim',
      leaseMs: 5 * 60_000,
      limit: 100
    })).resolves.toHaveLength(2);

    const context = createShutdownContext(Date.now() + 5_000);
    try {
      await firstConversation.close(context);
      await firstUnit.close(context);
      const recoveredUnit = new SqliteAgentRunUnitOfWork(
        root,
        new StrictJsonAgentPersistencePayloadCodec(),
        clock
      );
      const recoveredConversation = new SqliteConversationRunHandoffUnitOfWork(root);
      const projection = new SqlitePublicProjectionStore(root);
      const control = new ComposedAgentControlRuntime(
        recoveredUnit,
        recoveredConversation,
        projection,
        undefined,
        {
          publishIntervalMs: 60_000,
          publisher: { claimLeaseMs: 5 * 60_000 }
        },
        projectionLifecyclePipeline()
      );
      await control.start();
      await expect(projection.snapshot()).resolves.toMatchObject({
        runs: [{ runId: 'run-owner-takeover', version: 1 }]
      });
      expect(outboxPublicationCounts(root)).toEqual({ published: 2, pending: 0 });
      await control.shutdown(context);
    } finally {
      context.dispose();
    }
  });

  it('stops the producer, drains, then freezes Agent writes and closes Projection', async () => {
    const root = createRoot();
    const unit = new SqliteAgentRunUnitOfWork(root);
    const conversation = new SqliteConversationRunHandoffUnitOfWork(root);
    const commands = new AgentRunCommandService(unit);
    const projection = new SqlitePublicProjectionStore(root);
    const control = new ComposedAgentControlRuntime(
      unit,
      conversation,
      projection,
      undefined,
      { publishIntervalMs: 60_000 }
    );
    await control.start();
    await startRun(unit, 'run-shutdown-drain');

    const context = createShutdownContext(Date.now() + 5_000);
    try {
      await control.prepareShutdown(context);
      await expect(commands.execute({
        kind: 'run.cancel',
        commandId: 'command-after-agent-freeze',
        runId: 'run-shutdown-drain',
        expectedVersion: 1,
        occurredAt: at(2),
        reason: 'must not enter a frozen UoW'
      }, { turnInputPayloads: [], effectPayloads: [] }))
        .rejects.toThrow('agent_v3_unit_of_work_closed');

      await expect(projection.snapshot()).resolves.toMatchObject({
        runs: [{ runId: 'run-shutdown-drain', version: 1 }]
      });
      await control.shutdown(context);
      await expect(projection.snapshot()).rejects.toThrow(
        'public_projection_store_closed'
      );
      expect(outboxPublicationCounts(root)).toEqual({ published: 2, pending: 0 });
    } finally {
      context.dispose();
    }
  });

  it('retains every owner fence when the shutdown preparation barrier fails', async () => {
    const root = createRoot();
    const unit = new SqliteAgentRunUnitOfWork(root);
    const conversation = new SqliteConversationRunHandoffUnitOfWork(root);
    const projection = new SqlitePublicProjectionStore(root);
    const control = new ComposedAgentControlRuntime(
      unit,
      conversation,
      projection,
      undefined,
      { publishIntervalMs: 60_000 }
    );
    await control.start();

    const preparationFailure = vi.spyOn(unit, 'prepareShutdown').mockImplementation(() => {
      throw new Error('simulated_agent_prepare_failure');
    });
    const context = createShutdownContext(Date.now() + 5_000);
    try {
      await expect(control.shutdown(context)).rejects.toThrow(
        'agent_control_shutdown_barrier_failed'
      );

      // A failed preparation boundary is uncertain. No store may close or
      // release its process-owner lease until Main kills the Runtime.
      await expect(projection.snapshot()).resolves.toMatchObject({ cursor: 0 });
      await expect(unit.countUnpublishedOutbox()).resolves.toBe(0);
      expect(() => new SqliteAgentRunUnitOfWork(root)).toThrow(
        /sqlite_owner_lease_unavailable:agent-control/
      );
      expect(() => new SqliteConversationRunHandoffUnitOfWork(root)).toThrow(
        /sqlite_owner_lease_unavailable:conversation/
      );
      expect(() => new SqlitePublicProjectionStore(root)).toThrow(
        /sqlite_owner_lease_unavailable:public_projection/
      );
    } finally {
      preparationFailure.mockRestore();
      await projection.close(context);
      await conversation.close(context);
      await unit.close(context);
      context.dispose();
    }
  });

  it('latches producer health and stops the timer after a periodic append failure', async () => {
    const root = createRoot();
    const unit = new SqliteAgentRunUnitOfWork(root);
    const conversation = new SqliteConversationRunHandoffUnitOfWork(root);
    let appendAttempts = 0;
    const projection = new SqlitePublicProjectionStore(root, undefined, {
      beforeCommit: () => {
        appendAttempts += 1;
        throw new Error('periodic_projection_append_failed');
      }
    });
    const control = new ComposedAgentControlRuntime(
      unit,
      conversation,
      projection,
      undefined,
      {
        publishIntervalMs: 5,
        publisher: { claimLeaseMs: 1 }
      }
    );
    const context = createShutdownContext(Date.now() + 5_000);
    try {
      await control.start();
      await startRun(unit, 'run-periodic-failure');
      await expect.poll(() => {
        try {
          control.assertHealthy();
          return 'healthy';
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      }, { timeout: 1_000, interval: 5 }).toBe(
        'agent_control_public_projection_unhealthy'
      );
      const attemptsAfterFailure = appendAttempts;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(attemptsAfterFailure).toBe(1);
      expect(appendAttempts).toBe(attemptsAfterFailure);
    } finally {
      await control.shutdown(context);
      context.dispose();
    }
    expect(outboxPublicationCounts(root)).toEqual({ published: 0, pending: 2 });
  });
});

function closeControl(control: ComposedAgentControlRuntime): () => Promise<void> {
  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    const context = createShutdownContext(Date.now() + 5_000);
    try {
      await control.shutdown(context);
    } finally {
      context.dispose();
    }
  };
}

function commandEnvelope(
  command: RuntimeCommand,
  commandId: string
): RuntimeCommandEnvelope {
  return {
    commandId,
    correlationId: commandId,
    deadlineAt: '2031-01-01T00:00:00.000Z',
    signal: new AbortController().signal,
    command
  };
}

interface ProjectionDrainTestInternals {
  readonly agentPublisher: {
    publishPending(): Promise<{
      readonly claimedMessages: number;
      readonly projectedVersions: number;
      readonly acknowledgedMessages: number;
    }>;
  };
  wakeProjectionDrain(): void;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
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

async function startRun(
  unit: SqliteAgentRunUnitOfWork,
  runId: string,
  contentDigest: string = `sha256:${'a'.repeat(64)}`
): Promise<void> {
  await new AgentRunCommandService(unit).execute({
    kind: 'run.start',
    commandId: `command-start-${runId}`,
    runId,
    occurredAt: at(0),
    binding: {
      bindingVersion: 3,
      sessionId: `session-${runId}`,
      objectiveRef: {
        kind: 'conversation_message',
        messageId: `message-${runId}`,
        messageVersion: 1,
        contentDigest
      },
      workspace: {
        workspaceId: 'workspace-public-projection',
        revision: 1,
        grantDigest: `sha256:${'b'.repeat(64)}`,
        access: 'write',
        scopeIds: ['workspace']
      },
      model: {
        providerId: 'provider-public-projection',
        modelId: 'model-public-projection',
        settingsRevision: 1
      },
      policy: {
        policyId: 'policy-public-projection',
        revision: 1,
        permissionMode: 'ask'
      },
      capabilities: [],
      toolCatalog: {
        catalogId: 'catalog-public-projection',
        revision: 1,
        digest: `sha256:${'e'.repeat(64)}`,
        allowedToolNames: []
      },
      budget: {
        grantId: `grant-${runId}`,
        runId,
        vector: {
          modelTurns: 12,
          toolCalls: 8,
          readCalls: 0,
          writeCalls: 0,
          shellCalls: 0,
          costMicrousd: 1_000_000
        },
        deadlineAt: '2031-01-01T00:00:00.000Z',
        source: { kind: 'root' }
      }
    }
  }, { turnInputPayloads: [], effectPayloads: [] });
}

async function prepareLinkedConversationRun(
  conversation: SqliteConversationRunHandoffUnitOfWork,
  runId: string
): Promise<string> {
  const authority = new ConversationAuthorityService(conversation);
  const handoffs = new ConversationRunHandoffSagaService(conversation);
  await authority.createSession({
    kind: 'conversation.create_session',
    commandId: `create-${runId}`,
    eventId: `create-event-${runId}`,
    sessionId: `session-${runId}`,
    workspaceId: 'workspace-public-projection',
    expectedVersion: null,
    occurredAt: at(0)
  });
  const accepted = await authority.acceptUserMessage({
    kind: 'conversation.accept_user_message',
    commandId: `accept-${runId}`,
    eventId: `accept-event-${runId}`,
    sessionId: `session-${runId}`,
    workspaceId: 'workspace-public-projection',
    expectedSessionVersion: 1,
    messageId: `message-${runId}`,
    expectedMessageVersion: null,
    content: 'Cancel this linked Agent Run.',
    sagaId: `saga-${runId}`,
    handoffCommandId: `accept-handoff-${runId}`,
    handoffOutboxMessageId: `accept-outbox-${runId}`,
    occurredAt: at(1)
  });
  const identity = {
    sessionId: accepted.saga.sessionId,
    workspaceId: accepted.saga.workspaceId,
    messageId: accepted.saga.messageId,
    messageVersion: accepted.saga.messageVersion,
    objectiveDigest: accepted.saga.objectiveDigest
  };
  await handoffs.execute({
    kind: 'handoff.request_agent_run',
    ...identity,
    sagaId: accepted.saga.sagaId,
    commandId: `request-${runId}`,
    expectedVersion: 1,
    inboxEventId: `request-inbox-${runId}`,
    outboxMessageId: `request-outbox-${runId}`,
    occurredAt: at(1),
    runRequestId: `request-id-${runId}`,
    agentCommandId: `agent-command-${runId}`
  });
  await handoffs.execute({
    kind: 'handoff.link_agent_run',
    ...identity,
    sagaId: accepted.saga.sagaId,
    commandId: `link-${runId}`,
    expectedVersion: 2,
    inboxEventId: `link-inbox-${runId}`,
    outboxMessageId: `link-outbox-${runId}`,
    occurredAt: at(2),
    runRequestId: `request-id-${runId}`,
    agentCommandId: `agent-command-${runId}`,
    runId,
    admittedRunVersion: 1
  });
  return accepted.messageVersion.contentDigest;
}

function at(offsetSeconds: number): string {
  return new Date(Date.UTC(2030, 0, 1, 0, 0, offsetSeconds)).toISOString();
}

/** These tests isolate Projection lifecycle while explicitly owning producers. */
function projectionLifecyclePipeline(): AgentControlExecutionPipeline {
  let running = false;
  const producer = {
    start: async (): Promise<void> => { running = true; },
    assertHealthy: (): void => {
      if (!running) throw new Error('projection_test_producer_not_running');
    },
    wake: (): void => undefined,
    prepareShutdown: async (): Promise<void> => { running = false; }
  };
  const executionScheduler = {
    preflightStartupRecovery: async (): Promise<void> => undefined,
    cancelActiveRun: async (): Promise<{ readonly status: 'not_active' }> => ({
      status: 'not_active'
    }),
    ...producer
  };
  return {
    handoffProducer: producer as unknown as AgentControlExecutionPipeline['handoffProducer'],
    executionScheduler: executionScheduler as unknown as
      AgentControlExecutionPipeline['executionScheduler'],
    runWorkScheduler: producer as unknown as
      AgentControlExecutionPipeline['runWorkScheduler'],
    assertConversationMessageAdmission: (): void => undefined
  };
}

function createRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-agent-control-projection-'));
  temporaryRoots.push(root);
  return root;
}

function outboxPublicationCounts(root: string): {
  readonly published: number;
  readonly pending: number;
} {
  const database = new DatabaseSync(
    resolveAgentControlDatabasePath(root),
    { readOnly: true }
  );
  try {
    return database.prepare(
      `SELECT
         SUM(CASE WHEN published_at IS NULL THEN 0 ELSE 1 END) AS published,
         SUM(CASE WHEN published_at IS NULL THEN 1 ELSE 0 END) AS pending
       FROM agent_v3_outbox`
    ).get() as { published: number; pending: number };
  } finally {
    database.close();
  }
}
