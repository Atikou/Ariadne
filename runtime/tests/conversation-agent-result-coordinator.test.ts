import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { AgentRun } from '@ariadne/agent-core';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveConversationDatabasePath } from '../src/adapters/persistence/ConversationDbSchema.js';
import { SqliteConversationRunHandoffUnitOfWork } from '../src/adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import {
  ConversationAgentResultCoordinator
} from '../src/composition/ConversationAgentResultCoordinator.js';
import {
  ProtectedAgentTerminalAssistantContentResolver
} from '../src/composition/ProtectedAgentTerminalAssistantContentResolver.js';
import type {
  AcceptConversationUserMessageCommand,
  CreateConversationSessionCommand
} from '../src/conversation/ConversationAuthority.js';
import { ConversationAuthorityService } from '../src/control/conversation/ConversationAuthorityService.js';
import { ConversationAgentResultProjectionService } from '../src/control/conversation/ConversationAgentResultProjectionService.js';
import { ConversationRunHandoffSagaService } from '../src/control/conversation/ConversationRunHandoffSagaService.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';

const roots = new Set<string>();
const units = new Set<SqliteConversationRunHandoffUnitOfWork>();

afterEach(async () => {
  await Promise.all([...units].map(closeUnit));
  units.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe('ConversationAgentResultCoordinator', () => {
  it('commits one exact terminal Run result before the Agent source can be ACKed', async () => {
    const root = tempRoot();
    const unit = track(new SqliteConversationRunHandoffUnitOfWork(root));
    const authority = new ConversationAuthorityService(unit);
    const handoffs = new ConversationRunHandoffSagaService(unit);
    await authority.createSession(createSession());
    const accepted = await authority.acceptUserMessage(acceptMessage());
    await handoffs.execute({
      kind: 'handoff.request_agent_run',
      sagaId: accepted.saga.sagaId,
      commandId: 'handoff-request-command-result',
      expectedVersion: 1,
      inboxEventId: 'handoff-request-inbox-result',
      outboxMessageId: 'handoff-request-outbox-result',
      occurredAt: at(2),
      sessionId: accepted.saga.sessionId,
      workspaceId: accepted.saga.workspaceId,
      messageId: accepted.saga.messageId,
      messageVersion: accepted.saga.messageVersion,
      objectiveDigest: accepted.saga.objectiveDigest,
      runRequestId: 'run-request-result',
      agentCommandId: 'agent-command-result'
    });
    await handoffs.execute({
      kind: 'handoff.link_agent_run',
      sagaId: accepted.saga.sagaId,
      commandId: 'handoff-link-command-result',
      expectedVersion: 2,
      inboxEventId: 'handoff-link-inbox-result',
      outboxMessageId: 'handoff-link-outbox-result',
      occurredAt: at(3),
      sessionId: accepted.saga.sessionId,
      workspaceId: accepted.saga.workspaceId,
      messageId: accepted.saga.messageId,
      messageVersion: accepted.saga.messageVersion,
      objectiveDigest: accepted.saga.objectiveDigest,
      runRequestId: 'run-request-result',
      agentCommandId: 'agent-command-result',
      runId: 'run-result',
      admittedRunVersion: 1
    });
    const coordinator = new ConversationAgentResultCoordinator(
      unit,
      new ConversationAgentResultProjectionService(unit),
      new ProtectedAgentTerminalAssistantContentResolver(unit),
      () => new Date(at(4))
    );
    const run = cancelledRun(accepted.saga.objectiveDigest);

    await expect(coordinator.projectTerminalResult({
      run,
      sourceRunEventId: 'agent-terminal-event-result',
      occurredAt: at(4)
    })).resolves.toEqual({
      sagaId: accepted.saga.sagaId,
      sagaVersion: 4,
      replayed: false
    });
    await expect(coordinator.projectTerminalResult({
      run,
      sourceRunEventId: 'agent-terminal-event-result',
      occurredAt: at(4)
    })).resolves.toEqual({
      sagaId: accepted.saga.sagaId,
      sagaVersion: 4,
      replayed: true
    });

    const saga = await unit.readSaga(accepted.saga.sagaId);
    expect(saga).toMatchObject({
      version: 4,
      stage: {
        kind: 'agent_result_projected',
        runId: 'run-result',
        resultRunVersion: 2,
        resultStatus: 'cancelled',
        sourceRunEventId: 'agent-terminal-event-result'
      }
    });
    const database = new DatabaseSync(resolveConversationDatabasePath(root), {
      readOnly: true
    });
    try {
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM conversation_handoff_commands
         WHERE resulting_version=4`
      ).get()).toEqual({ count: 1 });
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM conversation_handoff_outbox
         WHERE message_kind='conversation.agent_result.projected'`
      ).get()).toEqual({ count: 1 });
      expect(database.prepare(
        `SELECT role, payload_json FROM conversation_message_versions
         WHERE role='assistant'`
      ).get()).toEqual({
        role: 'assistant',
        payload_json: JSON.stringify({ content: 'The Agent run was cancelled.' })
      });
    } finally {
      database.close();
    }
  });

  it('does not route ordinary child Run results into Conversation', async () => {
    const lookup = {
      async readSagaByMessage(): Promise<never> {
        throw new Error('lookup_must_not_run');
      },
      async readSession(): Promise<never> {
        throw new Error('session_lookup_must_not_run');
      },
      async readCommittedAuthorityCommand(): Promise<never> {
        throw new Error('receipt_lookup_must_not_run');
      }
    };
    const projector = {
      async project(): Promise<never> {
        throw new Error('projection_must_not_run');
      }
    };
    const contentResolver = {
      async resolveTerminalAssistantContent(): Promise<never> {
        throw new Error('content_resolution_must_not_run');
      }
    };
    const coordinator = new ConversationAgentResultCoordinator(
      lookup,
      projector,
      contentResolver
    );
    const run: AgentRun = {
      ...cancelledRun(`sha256:${'a'.repeat(64)}`),
      binding: {
        ...cancelledRun(`sha256:${'a'.repeat(64)}`).binding,
        objectiveRef: {
          kind: 'parent_delegation',
          parentRunId: 'parent-result',
          delegationId: 'delegation-result',
          objectiveDigest: `sha256:${'a'.repeat(64)}`
        },
        budget: {
          ...cancelledRun(`sha256:${'a'.repeat(64)}`).binding.budget,
          source: {
            kind: 'parent_allocation',
            parentRunId: 'parent-result',
            parentGrantId: 'parent-grant-result',
            delegationId: 'delegation-result'
          }
        }
      }
    };
    await expect(coordinator.projectTerminalResult({
      run,
      sourceRunEventId: 'child-terminal-event-result',
      occurredAt: at(4)
    })).resolves.toBeNull();
  });
});

function createSession(): CreateConversationSessionCommand {
  return {
    kind: 'conversation.create_session',
    commandId: 'create-session-result',
    eventId: 'create-session-event-result',
    sessionId: 'session-result',
    workspaceId: 'workspace-result',
    expectedVersion: null,
    occurredAt: at(0)
  };
}

function acceptMessage(): AcceptConversationUserMessageCommand {
  return {
    kind: 'conversation.accept_user_message',
    commandId: 'accept-message-result',
    eventId: 'accept-message-event-result',
    sessionId: 'session-result',
    workspaceId: 'workspace-result',
    expectedSessionVersion: 1,
    messageId: 'message-result',
    expectedMessageVersion: null,
    content: 'terminal result objective',
    sagaId: 'saga-result',
    handoffCommandId: 'accept-handoff-command-result',
    handoffOutboxMessageId: 'accept-handoff-outbox-result',
    occurredAt: at(1)
  };
}

function cancelledRun(contentDigest: string): AgentRun {
  return {
    runId: 'run-result',
    version: 2,
    binding: {
      bindingVersion: 3,
      sessionId: 'session-result',
      objectiveRef: {
        kind: 'conversation_message',
        messageId: 'message-result',
        messageVersion: 1,
        contentDigest
      },
      workspace: {
        workspaceId: 'workspace-result',
        revision: 1,
        grantDigest: `sha256:${'b'.repeat(64)}`,
        access: 'write',
        scopeIds: ['workspace-result']
      },
      model: {
        providerId: 'provider-result',
        modelId: 'model-result',
        settingsRevision: 1
      },
      policy: {
        policyId: 'policy-result',
        revision: 1,
        permissionMode: 'ask'
      },
      capabilities: [{
        capabilityId: 'workspace.write',
        scopeIds: ['workspace-result']
      }],
      toolCatalog: {
        catalogId: 'catalog-result',
        revision: 1,
        digest: `sha256:${'c'.repeat(64)}`,
        allowedToolNames: ['write-file']
      },
      budget: {
        grantId: 'grant-run-result',
        runId: 'run-result',
        vector: {
          modelTurns: 4,
          toolCalls: 4,
          readCalls: 0,
          writeCalls: 4,
          shellCalls: 0,
          costMicrousd: 100_000
        },
        deadlineAt: '2031-01-01T00:00:00.000Z',
        source: { kind: 'root' }
      }
    },
    state: {
      status: 'cancelled',
      checkpointVersion: 1,
      cancelledAt: at(4),
      reason: 'test cancellation'
    },
    turns: [],
    effects: [],
    inbox: [],
    createdAt: at(2),
    updatedAt: at(4)
  };
}

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-conversation-result-'));
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
    await unit.close(context);
  } finally {
    context.dispose();
  }
}

function at(offsetSeconds: number): string {
  return new Date(Date.UTC(2030, 0, 1, 0, 0, offsetSeconds)).toISOString();
}
