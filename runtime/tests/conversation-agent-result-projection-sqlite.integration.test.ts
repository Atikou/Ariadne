import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import {
  resolveConversationDatabasePath
} from '../src/adapters/persistence/ConversationDbSchema.js';
import {
  SqliteConversationRunHandoffUnitOfWork,
  type ConversationPersistenceFaultInjector,
  type ConversationShutdownContext
} from '../src/adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import type {
  AcceptConversationUserMessageCommand,
  CreateConversationSessionCommand
} from '../src/conversation/ConversationAuthority.js';
import type {
  ConversationRunHandoffCommand,
  ConversationRunHandoffSaga
} from '../src/conversation/ConversationRunHandoffSaga.js';
import {
  ConversationAgentResultProjectionService,
  type ProjectConversationAgentResultInput
} from '../src/control/conversation/ConversationAgentResultProjectionService.js';
import {
  ConversationAuthorityService
} from '../src/control/conversation/ConversationAuthorityService.js';
import {
  ConversationRunHandoffSagaService
} from '../src/control/conversation/ConversationRunHandoffSagaService.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';
import {
  projectConversationAuthorityRecordV3
} from '../src/projection/ConversationPublicProjectionPublisher.js';

const ASSISTANT_CONTENT =
  'Resolved assistant result sentinel 74af6d: the requested operation completed safely.';
const roots = new Set<string>();
const units = new Set<SqliteConversationRunHandoffUnitOfWork>();

afterEach(async () => {
  await Promise.all([...units].map(closeUnit));
  units.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe('Conversation assistant Agent result authority', () => {
  it('atomically commits Session CAS, assistant Message, authority facts, and Handoff result without leaking its body', async () => {
    const root = tempRoot();
    const unit = track(new SqliteConversationRunHandoffUnitOfWork(root));
    const linked = await createLinkedConversation(unit);
    const input = resultInput(linked);
    const projected = await new ConversationAgentResultProjectionService(unit)
      .project(input);

    expect(projected).toMatchObject({
      replayed: false,
      session: { version: 3 },
      messageHead: { messageId: 'assistant-message-result', latestVersion: 1 },
      messageVersion: {
        role: 'assistant',
        payload: { content: ASSISTANT_CONTENT }
      },
      authorityEvent: {
        type: 'conversation.agent_result.projected',
        sessionVersion: 3,
        sagaVersion: 4,
        runId: 'run-result',
        resultRunVersion: 7
      },
      saga: { version: 4, stage: { kind: 'agent_result_projected' } },
      handoffEvent: { type: 'handoff.agent_result_projected' },
      outbox: { kind: 'conversation.agent_result.projected' }
    });
    expect(projected.authorityEvent.contentDigest)
      .toBe(projected.messageVersion.contentDigest);

    const records = await unit.readProjectionRecords({ afterCursor: 0, limit: 10 });
    expect(records).toHaveLength(3);
    expect(records[2]).toMatchObject({
      event: { type: 'conversation.agent_result.projected' },
      messageVersion: { role: 'assistant', payload: { content: ASSISTANT_CONTENT } }
    });
    const publicCommit = projectConversationAuthorityRecordV3(records[2]!);
    expect(publicCommit.changes.find((change) => change.feature === 'messages')?.dto)
      .toMatchObject({
        role: 'assistant',
        runId: 'run-result',
        content: ASSISTANT_CONTENT
      });

    const database = openReadOnly(root);
    try {
      expect(tableCounts(database)).toEqual({
        sessions: 1,
        heads: 2,
        versions: 2,
        authorityCommands: 3,
        authorityEvents: 3,
        sagas: 1,
        handoffCommands: 4,
        handoffInbox: 4,
        handoffEvents: 4,
        handoffOutbox: 4
      });
      const payload = database.prepare(
        `SELECT role, payload_json FROM conversation_message_versions
         WHERE message_id=? AND version=?`
      ).get('assistant-message-result', 1) as {
        role: string;
        payload_json: string;
      };
      expect(payload).toEqual({
        role: 'assistant',
        payload_json: JSON.stringify({ content: ASSISTANT_CONTENT })
      });
      expect(serializeReferenceOnlyState(database)).not.toContain(ASSISTANT_CONTENT);
      expect(serializeReferenceOnlyState(database))
        .toContain(projected.messageVersion.contentDigest);
      expect(database.prepare('PRAGMA foreign_key_check;').all()).toEqual([]);
      expect(database.prepare(
        `SELECT COUNT(*) AS count
         FROM conversation_commands AS authority
         INNER JOIN conversation_message_versions AS message
           ON message.message_id=authority.message_id
          AND message.version=authority.message_version
          AND message.session_id=authority.session_id
          AND message.workspace_id=authority.workspace_id
         INNER JOIN conversation_handoff_commands AS handoff
           ON handoff.command_id=authority.handoff_command_id
          AND handoff.saga_id=authority.saga_id
          AND handoff.resulting_version=authority.saga_version
         INNER JOIN conversation_handoff_inbox AS inbox
           ON inbox.inbox_event_id=authority.handoff_inbox_event_id
          AND inbox.command_id=authority.handoff_command_id
          AND inbox.saga_id=authority.saga_id
         INNER JOIN conversation_handoff_outbox AS outbox
           ON outbox.message_id=authority.handoff_outbox_message_id
          AND outbox.command_id=authority.handoff_command_id
          AND outbox.saga_id=authority.saga_id
          AND outbox.saga_version=authority.saga_version
         WHERE authority.command_kind='conversation.project_agent_result'
           AND message.role='assistant'`
      ).get()).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it('serializes exact duplicates and rejects fingerprint drift without a second Message', async () => {
    const root = tempRoot();
    const unit = track(new SqliteConversationRunHandoffUnitOfWork(root));
    const linked = await createLinkedConversation(unit);
    const input = resultInput(linked);
    const service = new ConversationAgentResultProjectionService(unit);
    const [left, right] = await Promise.all([
      service.project(input),
      service.project(structuredClone(input))
    ]);
    expect([left.replayed, right.replayed].sort()).toEqual([false, true]);

    await expect(service.project({
      ...input,
      assistantContent: `${ASSISTANT_CONTENT} drift`
    })).rejects.toMatchObject({ code: 'CONVERSATION_COMMAND_CONFLICT' });
    await expect(service.project({
      ...input,
      resultRunVersion: 8
    })).rejects.toMatchObject({ code: 'CONVERSATION_COMMAND_CONFLICT' });
    expect(count(root, 'conversation_message_versions')).toBe(2);
    expect(count(root, 'conversation_commands')).toBe(3);
    expect(count(root, 'conversation_handoff_commands')).toBe(4);
  });

  it('fails Session and Saga CAS before leaving any partial result authority', async () => {
    const root = tempRoot();
    const unit = track(new SqliteConversationRunHandoffUnitOfWork(root));
    const linked = await createLinkedConversation(unit);
    const service = new ConversationAgentResultProjectionService(unit);
    const input = resultInput(linked);

    await expect(service.project({
      ...input,
      commandId: 'project-result-stale-session',
      eventId: 'project-result-stale-session-event',
      messageId: 'assistant-stale-session',
      handoffCommandId: 'handoff-stale-session',
      handoffInboxEventId: 'handoff-stale-session-inbox',
      handoffOutboxMessageId: 'handoff-stale-session-outbox',
      expectedSessionVersion: 1
    })).rejects.toMatchObject({ code: 'CONVERSATION_SESSION_VERSION_CONFLICT' });
    await expect(service.project({
      ...input,
      commandId: 'project-result-stale-saga',
      eventId: 'project-result-stale-saga-event',
      messageId: 'assistant-stale-saga',
      handoffCommandId: 'handoff-stale-saga',
      handoffInboxEventId: 'handoff-stale-saga-inbox',
      handoffOutboxMessageId: 'handoff-stale-saga-outbox',
      expectedSagaVersion: 2
    })).rejects.toMatchObject({ code: 'HANDOFF_VERSION_CONFLICT' });

    expect(count(root, 'conversation_message_versions')).toBe(1);
    expect(count(root, 'conversation_commands')).toBe(2);
    expect(count(root, 'conversation_handoff_commands')).toBe(3);
    expect((await unit.readSaga(linked.sagaId))?.stage.kind).toBe('agent_run_linked');
  });

  it('rolls the entire result back on a pre-COMMIT crash and replays after post-COMMIT loss', async () => {
    const beforeRoot = tempRoot();
    const beforeFault = new OneShotFault();
    let unit = track(new SqliteConversationRunHandoffUnitOfWork(
      beforeRoot,
      undefined,
      beforeFault
    ));
    let linked = await createLinkedConversation(unit);
    let input = resultInput(linked);
    let service = new ConversationAgentResultProjectionService(unit);
    beforeFault.phase = 'before';
    await expect(service.project(input)).rejects.toThrow('kill_before_result_commit');
    expect(count(beforeRoot, 'conversation_message_versions')).toBe(1);
    expect(count(beforeRoot, 'conversation_commands')).toBe(2);
    expect(count(beforeRoot, 'conversation_handoff_commands')).toBe(3);
    expect((await unit.readSaga(linked.sagaId))?.version).toBe(3);
    expect((await unit.authorityTransaction((transaction) =>
      transaction.loadSession(input.sessionId)))?.version).toBe(2);

    const afterRoot = tempRoot();
    const afterFault = new OneShotFault();
    unit = track(new SqliteConversationRunHandoffUnitOfWork(
      afterRoot,
      undefined,
      afterFault
    ));
    linked = await createLinkedConversation(unit);
    input = resultInput(linked);
    service = new ConversationAgentResultProjectionService(unit);
    afterFault.phase = 'after';
    await expect(service.project(input)).rejects.toThrow('kill_after_result_commit');
    afterFault.phase = 'none';
    const replay = await service.project(input);
    expect(replay).toMatchObject({
      replayed: true,
      messageVersion: { role: 'assistant', payload: { content: ASSISTANT_CONTENT } },
      saga: { version: 4 }
    });
    expect(count(afterRoot, 'conversation_message_versions')).toBe(2);
    expect(count(afterRoot, 'conversation_commands')).toBe(3);
    expect(count(afterRoot, 'conversation_handoff_commands')).toBe(4);
  });

  it('replays exact assistant authority after restart and fails reopen on broken result FKs', async () => {
    const root = tempRoot();
    let unit = track(new SqliteConversationRunHandoffUnitOfWork(root));
    const linked = await createLinkedConversation(unit);
    const input = resultInput(linked);
    const committed = await new ConversationAgentResultProjectionService(unit)
      .project(input);
    await closeUnit(unit);
    units.delete(unit);

    unit = track(new SqliteConversationRunHandoffUnitOfWork(root));
    const replay = await new ConversationAgentResultProjectionService(unit).project(input);
    expect(replay.replayed).toBe(true);
    expect(replay.receipt).toEqual(committed.receipt);
    expect(replay.messageVersion).toEqual(committed.messageVersion);
    expect(replay.saga).toEqual(committed.saga);
    await closeUnit(unit);
    units.delete(unit);

    const database = new DatabaseSync(resolveConversationDatabasePath(root));
    try {
      database.exec('PRAGMA foreign_keys = OFF;');
      database.prepare(
        `UPDATE conversation_commands SET handoff_outbox_message_id=?
         WHERE command_kind='conversation.project_agent_result'`
      ).run('broken-result-outbox-reference');
    } finally {
      database.close();
    }
    expect(() => new SqliteConversationRunHandoffUnitOfWork(root))
      .toThrow('conversation_schema_integrity_check_failed');
  });
});

class OneShotFault implements ConversationPersistenceFaultInjector {
  public phase: 'none' | 'before' | 'after' = 'none';
  public beforeCommit(): void {
    if (this.phase !== 'before') return;
    this.phase = 'none';
    throw new Error('kill_before_result_commit');
  }
  public afterCommit(): void {
    if (this.phase !== 'after') return;
    this.phase = 'none';
    throw new Error('kill_after_result_commit');
  }
}

async function createLinkedConversation(
  unit: SqliteConversationRunHandoffUnitOfWork
): Promise<ConversationRunHandoffSaga> {
  const authority = new ConversationAuthorityService(unit);
  const handoffs = new ConversationRunHandoffSagaService(unit);
  await authority.createSession(createSessionCommand());
  const accepted = await authority.acceptUserMessage(acceptMessageCommand());
  const requested = await handoffs.execute(requestCommand(accepted.saga));
  return (await handoffs.execute(linkCommand(requested.saga))).saga;
}

function createSessionCommand(): CreateConversationSessionCommand {
  return {
    kind: 'conversation.create_session',
    commandId: 'create-session-result-authority',
    eventId: 'create-session-result-authority-event',
    sessionId: 'session-result-authority',
    workspaceId: 'workspace-result-authority',
    expectedVersion: null,
    occurredAt: at(0)
  };
}

function acceptMessageCommand(): AcceptConversationUserMessageCommand {
  return {
    kind: 'conversation.accept_user_message',
    commandId: 'accept-message-result-authority',
    eventId: 'accept-message-result-authority-event',
    sessionId: 'session-result-authority',
    workspaceId: 'workspace-result-authority',
    expectedSessionVersion: 1,
    messageId: 'objective-message-result',
    expectedMessageVersion: null,
    content: 'Inspect the exact terminal result.',
    sagaId: 'saga-result-authority',
    handoffCommandId: 'handoff-accept-result-authority',
    handoffOutboxMessageId: 'handoff-accept-result-authority-outbox',
    occurredAt: at(1)
  };
}

function requestCommand(saga: ConversationRunHandoffSaga): Extract<
  ConversationRunHandoffCommand,
  { readonly kind: 'handoff.request_agent_run' }
> {
  return {
    kind: 'handoff.request_agent_run',
    ...sagaIdentity(saga),
    sagaId: saga.sagaId,
    commandId: 'handoff-request-result-authority',
    expectedVersion: saga.version,
    inboxEventId: 'handoff-request-result-authority-inbox',
    outboxMessageId: 'handoff-request-result-authority-outbox',
    occurredAt: at(2),
    runRequestId: 'run-request-result-authority',
    agentCommandId: 'agent-command-result-authority'
  };
}

function linkCommand(saga: ConversationRunHandoffSaga): Extract<
  ConversationRunHandoffCommand,
  { readonly kind: 'handoff.link_agent_run' }
> {
  if (saga.stage.kind !== 'agent_run_requested') throw new Error('request_stage_required');
  return {
    kind: 'handoff.link_agent_run',
    ...sagaIdentity(saga),
    sagaId: saga.sagaId,
    commandId: 'handoff-link-result-authority',
    expectedVersion: saga.version,
    inboxEventId: 'handoff-link-result-authority-inbox',
    outboxMessageId: 'handoff-link-result-authority-outbox',
    occurredAt: at(3),
    runRequestId: saga.stage.runRequestId,
    agentCommandId: saga.stage.agentCommandId,
    runId: 'run-result',
    admittedRunVersion: 1
  };
}

function resultInput(saga: ConversationRunHandoffSaga): ProjectConversationAgentResultInput {
  if (saga.stage.kind !== 'agent_run_linked') throw new Error('linked_stage_required');
  return {
    kind: 'conversation.project_agent_result',
    commandId: 'project-result-authority',
    eventId: 'project-result-authority-event',
    sessionId: saga.sessionId,
    workspaceId: saga.workspaceId,
    expectedSessionVersion: 2,
    messageId: 'assistant-message-result',
    expectedMessageVersion: null,
    assistantContent: ASSISTANT_CONTENT,
    sagaId: saga.sagaId,
    expectedSagaVersion: saga.version,
    handoffCommandId: 'handoff-project-result-authority',
    handoffInboxEventId: 'handoff-project-result-authority-inbox',
    handoffOutboxMessageId: 'handoff-project-result-authority-outbox',
    objectiveMessageId: saga.messageId,
    objectiveMessageVersion: saga.messageVersion,
    objectiveDigest: saga.objectiveDigest,
    runRequestId: saga.stage.runRequestId,
    agentCommandId: saga.stage.agentCommandId,
    runId: saga.stage.runId,
    admittedRunVersion: saga.stage.admittedRunVersion,
    resultRunVersion: 7,
    resultStatus: 'completed',
    sourceRunEventId: 'agent-terminal-result-event-7',
    occurredAt: at(4)
  };
}

function sagaIdentity(saga: ConversationRunHandoffSaga) {
  return {
    sessionId: saga.sessionId,
    workspaceId: saga.workspaceId,
    messageId: saga.messageId,
    messageVersion: saga.messageVersion,
    objectiveDigest: saga.objectiveDigest
  };
}

function tableCounts(database: DatabaseSync) {
  const countTable = (table: string): number => Number((database.prepare(
    `SELECT COUNT(*) AS count FROM ${table}`
  ).get() as { count: number }).count);
  return {
    sessions: countTable('conversation_sessions'),
    heads: countTable('conversation_message_heads'),
    versions: countTable('conversation_message_versions'),
    authorityCommands: countTable('conversation_commands'),
    authorityEvents: countTable('conversation_events'),
    sagas: countTable('conversation_handoff_sagas'),
    handoffCommands: countTable('conversation_handoff_commands'),
    handoffInbox: countTable('conversation_handoff_inbox'),
    handoffEvents: countTable('conversation_handoff_events'),
    handoffOutbox: countTable('conversation_handoff_outbox')
  };
}

function serializeReferenceOnlyState(database: DatabaseSync): string {
  return JSON.stringify({
    sessions: database.prepare('SELECT * FROM conversation_sessions').all(),
    heads: database.prepare('SELECT * FROM conversation_message_heads').all(),
    versionRefs: database.prepare(
      `SELECT message_id, version, session_id, workspace_id, role,
              content_digest, created_at
       FROM conversation_message_versions`
    ).all(),
    authorityCommands: database.prepare('SELECT * FROM conversation_commands').all(),
    authorityEvents: database.prepare('SELECT * FROM conversation_events').all(),
    sagas: database.prepare('SELECT * FROM conversation_handoff_sagas').all(),
    handoffCommands: database.prepare(
      'SELECT * FROM conversation_handoff_commands'
    ).all(),
    handoffInbox: database.prepare('SELECT * FROM conversation_handoff_inbox').all(),
    handoffEvents: database.prepare('SELECT * FROM conversation_handoff_events').all(),
    handoffOutbox: database.prepare('SELECT * FROM conversation_handoff_outbox').all()
  });
}

function count(root: string, table: string): number {
  const allowed = new Set([
    'conversation_message_versions',
    'conversation_commands',
    'conversation_handoff_commands'
  ]);
  if (!allowed.has(table)) throw new Error('result_authority_test_table_invalid');
  const database = openReadOnly(root);
  try {
    return Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    }).count);
  } finally {
    database.close();
  }
}

function openReadOnly(root: string): DatabaseSync {
  return new DatabaseSync(resolveConversationDatabasePath(root), { readOnly: true });
}

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-conversation-result-authority-'));
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
  } finally {
    context.dispose();
  }
}

function at(offsetSeconds: number): string {
  return new Date(Date.UTC(2030, 0, 1, 0, 0, offsetSeconds)).toISOString();
}
