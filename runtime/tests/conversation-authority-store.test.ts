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
  type ConversationShutdownContext
} from '../src/adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import {
  acceptConversationUserMessage,
  createConversationAuthorityReceipt,
  digestConversationMessageContent,
  fingerprintConversationAuthorityCommand,
  type AcceptConversationUserMessageCommand,
  type CreateConversationSessionCommand,
  type MutateConversationSessionCommand
} from '../src/conversation/ConversationAuthority.js';
import {
  fingerprintConversationRunHandoffCommand,
  transitionConversationRunHandoff,
  type ConversationRunHandoffCommand
} from '../src/conversation/ConversationRunHandoffSaga.js';
import {
  ConversationAuthorityService
} from '../src/control/conversation/ConversationAuthorityService.js';
import {
  ConversationRunHandoffSagaService
} from '../src/control/conversation/ConversationRunHandoffSagaService.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';

const RAW_CONTENT = 'raw user prompt only message payload may retain';
const roots = new Set<string>();
const units = new Set<SqliteConversationRunHandoffUnitOfWork>();

afterEach(async () => {
  for (const unit of [...units]) await closeUnit(unit);
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  units.clear();
  roots.clear();
});

describe('Conversation authority store', () => {
  it('atomically creates Session + immutable Message v1 + Handoff v1 with a proving FK', async () => {
    const root = tempRoot();
    const unit = track(new SqliteConversationRunHandoffUnitOfWork(root));
    const authority = new ConversationAuthorityService(unit);
    const created = await authority.createSession(createSessionCommand());
    const accepted = await authority.acceptUserMessage(acceptMessageCommand());

    expect(created).toMatchObject({
      replayed: false,
      session: { version: 1, workspaceId: 'workspace-authority' }
    });
    expect(accepted).toMatchObject({
      replayed: false,
      session: { version: 2 },
      messageHead: { latestVersion: 1 },
      messageVersion: { version: 1, payload: { content: RAW_CONTENT } },
      saga: { version: 1, stage: { kind: 'message_accepted' } },
      outbox: { kind: 'conversation.message.accepted' }
    });
    expect(accepted.saga.objectiveDigest).toBe(accepted.messageVersion.contentDigest);
    expect(accepted.saga.processedSteps[0]?.inboxEventId)
      .toBe(accepted.authorityEvent.eventId);

    const database = new DatabaseSync(resolveConversationDatabasePath(root), {
      readOnly: true
    });
    try {
      expect(tableCounts(database)).toEqual({
        sessions: 1,
        sessionVersions: 2,
        heads: 1,
        versions: 1,
        commands: 2,
        events: 2,
        sagas: 1,
        handoffCommands: 1,
        handoffEvents: 1,
        handoffOutbox: 1
      });
      const payload = database.prepare(
        'SELECT payload_json FROM conversation_message_versions'
      ).get() as { payload_json: string };
      expect(payload.payload_json).toBe(JSON.stringify({ content: RAW_CONTENT }));
      expect(serializeSafeConversationState(database)).not.toContain(RAW_CONTENT);
      expect(serializeSafeConversationState(database))
        .toContain(accepted.messageVersion.contentDigest);
      expect(database.prepare('PRAGMA foreign_key_check;').all()).toEqual([]);
      const proof = database.prepare(
        `SELECT COUNT(*) AS count
         FROM conversation_handoff_sagas AS saga
         INNER JOIN conversation_message_versions AS message
           ON message.message_id=saga.message_id
          AND message.version=saga.message_version
          AND message.session_id=saga.session_id
          AND message.workspace_id=saga.workspace_id
          AND message.content_digest=saga.objective_digest`
      ).get() as { count: number };
      expect(Number(proof.count)).toBe(1);
    } finally {
      database.close();
    }
  });

  it('persists exact title and archive versions with CAS and rejects new input while archived', async () => {
    const root = tempRoot();
    const unit = track(new SqliteConversationRunHandoffUnitOfWork(root));
    const authority = new ConversationAuthorityService(unit);
    const created = await authority.createSession(createSessionCommand());
    expect(created.session).toMatchObject({
      version: 1,
      title: 'Conversation',
      status: 'active'
    });

    const renamed = await authority.mutateSession(mutateSessionCommand(
      'rename-session-authority',
      'rename-session-event',
      1,
      { kind: 'rename', title: 'Durable title' },
      '2030-01-01T00:00:01.000Z'
    ));
    expect(renamed).toMatchObject({ resultingSessionVersion: 2, replayed: false });
    await expect(authority.mutateSession(mutateSessionCommand(
      'rename-session-authority',
      'rename-session-event',
      1,
      { kind: 'rename', title: 'Durable title' },
      '2030-01-01T00:00:01.000Z'
    ))).resolves.toMatchObject({ resultingSessionVersion: 2, replayed: true });

    await authority.mutateSession(mutateSessionCommand(
      'archive-session-authority',
      'archive-session-event',
      2,
      { kind: 'set_status', status: 'archived' },
      '2030-01-01T00:00:02.000Z'
    ));
    await expect(authority.acceptUserMessage({
      ...acceptMessageCommand(),
      expectedSessionVersion: 3,
      occurredAt: '2030-01-01T00:00:03.000Z'
    })).rejects.toMatchObject({ code: 'CONVERSATION_SESSION_ARCHIVED' });
    await expect(authority.mutateSession(mutateSessionCommand(
      'stale-restore-session-authority',
      'stale-restore-session-event',
      2,
      { kind: 'set_status', status: 'active' },
      '2030-01-01T00:00:03.000Z'
    ))).rejects.toMatchObject({ code: 'CONVERSATION_SESSION_VERSION_CONFLICT' });

    const restored = await authority.mutateSession(mutateSessionCommand(
      'restore-session-authority',
      'restore-session-event',
      3,
      { kind: 'set_status', status: 'active' },
      '2030-01-01T00:00:04.000Z'
    ));
    expect(restored.resultingSessionVersion).toBe(4);

    const database = new DatabaseSync(resolveConversationDatabasePath(root), { readOnly: true });
    try {
      expect(database.prepare(
        `SELECT version, title, status FROM conversation_session_versions
         WHERE session_id=? ORDER BY version`
      ).all('session-authority')).toEqual([
        { version: 1, title: 'Conversation', status: 'active' },
        { version: 2, title: 'Durable title', status: 'active' },
        { version: 3, title: 'Durable title', status: 'archived' },
        { version: 4, title: 'Durable title', status: 'active' }
      ]);
    } finally {
      database.close();
    }
  });

  it('serializes concurrent duplicates and fails closed on command payload drift', async () => {
    const root = tempRoot();
    const unit = track(new SqliteConversationRunHandoffUnitOfWork(root));
    const authority = new ConversationAuthorityService(unit);
    const create = createSessionCommand();
    const [createdLeft, createdRight] = await Promise.all([
      authority.createSession(create),
      authority.createSession(structuredClone(create))
    ]);
    expect([createdLeft.replayed, createdRight.replayed].sort()).toEqual([false, true]);
    await expect(authority.createSession({
      ...create,
      workspaceId: 'workspace-drift'
    })).rejects.toMatchObject({ code: 'CONVERSATION_COMMAND_CONFLICT' });
    await expect(authority.createSession({
      ...create,
      commandId: 'create-session-competing',
      eventId: 'session-created-competing'
    })).rejects.toMatchObject({ code: 'CONVERSATION_SESSION_ALREADY_EXISTS' });

    const accept = acceptMessageCommand();
    const [left, right] = await Promise.all([
      authority.acceptUserMessage(accept),
      authority.acceptUserMessage(structuredClone(accept))
    ]);
    expect([left.replayed, right.replayed].sort()).toEqual([false, true]);
    await expect(authority.acceptUserMessage({
      ...accept,
      content: 'payload drift'
    })).rejects.toMatchObject({ code: 'CONVERSATION_COMMAND_CONFLICT' });
    await expect(authority.acceptUserMessage({
      ...accept,
      expectedSessionVersion: 2
    })).rejects.toMatchObject({ code: 'CONVERSATION_COMMAND_CONFLICT' });
    await expect(authority.acceptUserMessage({
      ...accept,
      workspaceId: 'workspace-drift'
    })).rejects.toMatchObject({ code: 'CONVERSATION_COMMAND_CONFLICT' });
    expect(countRows(root, 'conversation_message_versions')).toBe(1);
    expect(countRows(root, 'conversation_handoff_sagas')).toBe(1);
  });

  it('snapshots create and accept commands before their first asynchronous boundary', async () => {
    const root = tempRoot();
    const unit = track(new SqliteConversationRunHandoffUnitOfWork(root));
    const authority = new ConversationAuthorityService(unit);

    const create = { ...createSessionCommand() };
    const creating = authority.createSession(create);
    create.commandId = 'mutated-create-command';
    create.eventId = 'mutated-create-event';
    create.sessionId = 'mutated-session';
    create.workspaceId = 'mutated-workspace';
    create.occurredAt = '2031-01-01T00:00:00.000Z';
    const created = await creating;
    expect(created).toMatchObject({
      replayed: false,
      session: {
        sessionId: 'session-authority',
        workspaceId: 'workspace-authority',
        createdAt: '2030-01-01T00:00:00.000Z'
      },
      receipt: { commandId: 'create-session-authority' }
    });
    expect((await authority.createSession(createSessionCommand())).replayed).toBe(true);

    const accept = { ...acceptMessageCommand() };
    const accepting = authority.acceptUserMessage(accept);
    accept.commandId = 'mutated-accept-command';
    accept.eventId = 'mutated-accept-event';
    accept.messageId = 'mutated-message';
    accept.content = 'mutated raw content';
    accept.sagaId = 'mutated-saga';
    accept.handoffCommandId = 'mutated-handoff-command';
    accept.handoffOutboxMessageId = 'mutated-handoff-outbox';
    accept.occurredAt = '2031-01-01T00:00:01.000Z';
    const accepted = await accepting;
    expect(accepted).toMatchObject({
      replayed: false,
      messageVersion: {
        messageId: 'message-authority',
        payload: { content: RAW_CONTENT },
        createdAt: '2030-01-01T00:00:01.000Z'
      },
      saga: { sagaId: 'saga-authority' },
      receipt: { commandId: 'accept-message-authority' }
    });
    expect(await digestConversationMessageContent(accepted.messageVersion.payload.content))
      .toBe(accepted.messageVersion.contentDigest);
    expect((await authority.acceptUserMessage(acceptMessageCommand())).replayed).toBe(true);
  });

  it('rejects a content digest forged below the authority Service boundary', async () => {
    const root = tempRoot();
    const unit = track(new SqliteConversationRunHandoffUnitOfWork(root));
    const authority = new ConversationAuthorityService(unit);
    await authority.createSession(createSessionCommand());
    const command = acceptMessageCommand();
    const forgedDigest = `sha256:${'f'.repeat(64)}`;
    const authorityFingerprint = await fingerprintConversationAuthorityCommand(
      command,
      forgedDigest
    );
    const handoffCommand: Extract<
      ConversationRunHandoffCommand,
      { readonly kind: 'handoff.accept_message' }
    > = {
      kind: 'handoff.accept_message',
      sagaId: command.sagaId,
      commandId: command.handoffCommandId,
      expectedVersion: null,
      inboxEventId: command.eventId,
      outboxMessageId: command.handoffOutboxMessageId,
      occurredAt: command.occurredAt,
      sessionId: command.sessionId,
      workspaceId: command.workspaceId,
      messageId: command.messageId,
      messageVersion: 1,
      objectiveDigest: forgedDigest
    };
    const handoffFingerprint = await fingerprintConversationRunHandoffCommand(
      handoffCommand
    );
    const handoff = transitionConversationRunHandoff(
      null,
      handoffCommand,
      handoffFingerprint
    );

    await expect(unit.authorityTransaction(async (transaction) => {
      const current = await transaction.loadSession(command.sessionId);
      const accepted = acceptConversationUserMessage(current, command, forgedDigest);
      const receipt = createConversationAuthorityReceipt(
        command,
        authorityFingerprint,
        accepted.session.version
      );
      if (receipt.kind !== 'conversation.accept_user_message') {
        throw new Error('accept_receipt_expected');
      }
      await transaction.commitAcceptedUserMessage({
        ...accepted,
        receipt,
        expectedSessionVersion: command.expectedSessionVersion,
        handoff: {
          commandId: handoffCommand.commandId,
          commandFingerprint: handoffFingerprint,
          sagaId: handoffCommand.sagaId,
          expectedVersion: null,
          resultingVersion: handoff.saga.version,
          ...handoff
        }
      });
    })).rejects.toMatchObject({ code: 'CONVERSATION_STORAGE_CORRUPTION' });
    expect(countRows(root, 'conversation_message_versions')).toBe(0);
    expect(countRows(root, 'conversation_handoff_sagas')).toBe(0);
  });

  it('rejects workspace and Session CAS mismatch before writing any Message or Saga', async () => {
    const root = tempRoot();
    const unit = track(new SqliteConversationRunHandoffUnitOfWork(root));
    const authority = new ConversationAuthorityService(unit);
    await authority.createSession(createSessionCommand());
    await expect(authority.acceptUserMessage({
      ...acceptMessageCommand(),
      commandId: 'workspace-command',
      eventId: 'workspace-event',
      handoffCommandId: 'workspace-handoff-command',
      handoffOutboxMessageId: 'workspace-handoff-outbox',
      workspaceId: 'workspace-wrong'
    })).rejects.toMatchObject({ code: 'CONVERSATION_WORKSPACE_MISMATCH' });
    await expect(authority.acceptUserMessage({
      ...acceptMessageCommand(),
      commandId: 'cas-command',
      eventId: 'cas-event',
      handoffCommandId: 'cas-handoff-command',
      handoffOutboxMessageId: 'cas-handoff-outbox',
      expectedSessionVersion: 2
    })).rejects.toMatchObject({ code: 'CONVERSATION_SESSION_VERSION_CONFLICT' });
    expect(countRows(root, 'conversation_message_heads')).toBe(0);
    expect(countRows(root, 'conversation_message_versions')).toBe(0);
    expect(countRows(root, 'conversation_handoff_sagas')).toBe(0);
  });

  it('replays exact authoritative results after reopen without putting raw content in receipts', async () => {
    const root = tempRoot();
    let unit = track(new SqliteConversationRunHandoffUnitOfWork(root));
    let authority = new ConversationAuthorityService(unit);
    await authority.createSession(createSessionCommand());
    const committed = await authority.acceptUserMessage(acceptMessageCommand());
    await authority.mutateSession(mutateSessionCommand(
      'rename-after-accept-authority',
      'rename-after-accept-event',
      2,
      { kind: 'rename', title: 'Later title' },
      '2030-01-01T00:00:02.000Z'
    ));
    await closeUnit(unit);
    units.delete(unit);

    unit = track(new SqliteConversationRunHandoffUnitOfWork(root));
    authority = new ConversationAuthorityService(unit);
    const createReplay = await authority.createSession(createSessionCommand());
    const replay = await authority.acceptUserMessage(acceptMessageCommand());
    expect(createReplay).toMatchObject({ replayed: true, session: { version: 1 } });
    expect(replay.replayed).toBe(true);
    expect(replay.session).toMatchObject({
      version: 2,
      title: 'Conversation',
      status: 'active'
    });
    await expect(unit.readSession('session-authority')).resolves.toMatchObject({
      version: 3,
      title: 'Later title'
    });
    expect(replay.receipt).toEqual(committed.receipt);
    expect(replay.messageVersion).toEqual(committed.messageVersion);
    expect(replay.saga).toEqual(committed.saga);

    const database = new DatabaseSync(resolveConversationDatabasePath(root), {
      readOnly: true
    });
    try {
      const receipts = database.prepare(
        `SELECT command_id, command_kind, command_fingerprint, event_id,
                session_id, workspace_id, expected_session_version,
                resulting_session_version, message_id, message_version,
                saga_id, committed_at
         FROM conversation_commands ORDER BY resulting_session_version`
      ).all();
      expect(JSON.stringify(receipts)).not.toContain(RAW_CONTENT);
    } finally {
      database.close();
    }
  });

  it('makes Message versions immutable and forbids SQLite-only Handoff acceptance', async () => {
    const root = tempRoot();
    const unit = track(new SqliteConversationRunHandoffUnitOfWork(root));
    const authority = new ConversationAuthorityService(unit);
    await authority.createSession(createSessionCommand());
    await authority.acceptUserMessage(acceptMessageCommand());

    const database = new DatabaseSync(resolveConversationDatabasePath(root));
    try {
      expect(() => database.prepare(
        `UPDATE conversation_message_versions SET payload_json=?
         WHERE message_id=? AND version=?`
      ).run(JSON.stringify({ content: 'mutated' }), 'message-authority', 1))
        .toThrow('conversation_message_version_immutable');
      expect(() => database.prepare(
        `DELETE FROM conversation_message_versions
         WHERE message_id=? AND version=?`
      ).run('message-authority', 1))
        .toThrow('conversation_message_version_immutable');
    } finally {
      database.close();
    }

    await authority.createSession(createSessionCommand('unbacked'));
    const direct = directHandoffAcceptCommand();
    await expect(new ConversationRunHandoffSagaService(unit).execute(direct))
      .rejects.toThrow('handoff_accept_requires_authoritative_message_version');
    expect(countRows(root, 'conversation_handoff_sagas')).toBe(1);
  });
});

function createSessionCommand(suffix = 'authority'): CreateConversationSessionCommand {
  return {
    kind: 'conversation.create_session',
    commandId: `create-session-${suffix}`,
    eventId: `session-created-${suffix}`,
    sessionId: `session-${suffix}`,
    workspaceId: `workspace-${suffix}`,
    expectedVersion: null,
    occurredAt: '2030-01-01T00:00:00.000Z'
  };
}

function acceptMessageCommand(): AcceptConversationUserMessageCommand {
  return {
    kind: 'conversation.accept_user_message',
    commandId: 'accept-message-authority',
    eventId: 'message-accepted-authority',
    sessionId: 'session-authority',
    workspaceId: 'workspace-authority',
    expectedSessionVersion: 1,
    messageId: 'message-authority',
    expectedMessageVersion: null,
    content: RAW_CONTENT,
    sagaId: 'saga-authority',
    handoffCommandId: 'handoff-accept-authority',
    handoffOutboxMessageId: 'handoff-outbox-authority',
    occurredAt: '2030-01-01T00:00:01.000Z'
  };
}

function directHandoffAcceptCommand(): Extract<
  ConversationRunHandoffCommand,
  { readonly kind: 'handoff.accept_message' }
> {
  return {
    kind: 'handoff.accept_message',
    sagaId: 'saga-unbacked',
    commandId: 'handoff-unbacked-command',
    expectedVersion: null,
    inboxEventId: 'handoff-unbacked-inbox',
    outboxMessageId: 'handoff-unbacked-outbox',
    occurredAt: '2030-01-01T00:00:01.000Z',
    sessionId: 'session-unbacked',
    workspaceId: 'workspace-unbacked',
    messageId: 'message-unbacked',
    messageVersion: 1,
    objectiveDigest: `sha256:${'a'.repeat(64)}`
  };
}

function tableCounts(database: DatabaseSync) {
  const count = (table: string): number => Number((database.prepare(
    `SELECT COUNT(*) AS count FROM ${table}`
  ).get() as { count: number }).count);
  return {
    sessions: count('conversation_sessions'),
    sessionVersions: count('conversation_session_versions'),
    heads: count('conversation_message_heads'),
    versions: count('conversation_message_versions'),
    commands: count('conversation_commands'),
    events: count('conversation_events'),
    sagas: count('conversation_handoff_sagas'),
    handoffCommands: count('conversation_handoff_commands'),
    handoffEvents: count('conversation_handoff_events'),
    handoffOutbox: count('conversation_handoff_outbox')
  };
}

function mutateSessionCommand(
  commandId: string,
  eventId: string,
  expectedSessionVersion: number,
  mutation: MutateConversationSessionCommand['mutation'],
  occurredAt: string
): MutateConversationSessionCommand {
  return {
    kind: 'conversation.mutate_session',
    commandId,
    eventId,
    sessionId: 'session-authority',
    workspaceId: 'workspace-authority',
    expectedSessionVersion,
    mutation,
    occurredAt
  };
}

function serializeSafeConversationState(database: DatabaseSync): string {
  return JSON.stringify({
    sessions: database.prepare('SELECT * FROM conversation_sessions').all(),
    heads: database.prepare('SELECT * FROM conversation_message_heads').all(),
    versionRefs: database.prepare(
      `SELECT message_id, version, session_id, workspace_id, role,
              content_digest, created_at FROM conversation_message_versions`
    ).all(),
    commands: database.prepare('SELECT * FROM conversation_commands').all(),
    events: database.prepare('SELECT * FROM conversation_events').all(),
    sagas: database.prepare('SELECT * FROM conversation_handoff_sagas').all(),
    handoffCommands: database.prepare(
      'SELECT * FROM conversation_handoff_commands'
    ).all(),
    handoffEvents: database.prepare('SELECT * FROM conversation_handoff_events').all(),
    handoffInbox: database.prepare('SELECT * FROM conversation_handoff_inbox').all(),
    handoffOutbox: database.prepare('SELECT * FROM conversation_handoff_outbox').all()
  });
}

function countRows(root: string, table: string): number {
  const allowed = new Set([
    'conversation_message_heads',
    'conversation_message_versions',
    'conversation_handoff_sagas'
  ]);
  if (!allowed.has(table)) throw new Error('authority_test_table_invalid');
  const database = new DatabaseSync(resolveConversationDatabasePath(root), {
    readOnly: true
  });
  try {
    return Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    }).count);
  } finally {
    database.close();
  }
}

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-conversation-authority-'));
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
