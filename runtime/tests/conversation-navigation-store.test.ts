import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  SqliteConversationRunHandoffUnitOfWork,
  type ConversationShutdownContext
} from '../src/adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import { ConversationAuthorityService } from '../src/control/conversation/ConversationAuthorityService.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';

const roots = new Set<string>();
const units = new Set<SqliteConversationRunHandoffUnitOfWork>();

afterEach(async () => {
  for (const unit of [...units]) await closeUnit(unit);
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
  units.clear();
});

describe('Conversation navigation authority', () => {
  it('forks at an immutable boundary and inherits history without copying messages', async () => {
    const root = tempRoot();
    const unit = track(new SqliteConversationRunHandoffUnitOfWork(root));
    const authority = new ConversationAuthorityService(unit);
    await authority.createSession(createSession('parent', 'create-parent'));
    const parent = await authority.acceptUserMessage(acceptMessage(
      'parent', 'parent-message', 'accept-parent', 1, 'parent objective'
    ));
    const boundary = {
      sessionId: parent.session.sessionId,
      messageId: parent.messageVersion.messageId,
      messageVersion: parent.messageVersion.version,
      contentDigest: parent.messageVersion.contentDigest
    };

    const fork = await unit.forkSession({
      commandId: 'fork-command',
      eventId: 'fork-event',
      sessionId: 'session-child',
      sourceSessionId: 'session-parent',
      workspaceId: 'workspace-navigation',
      expectedSourceSessionVersion: 2,
      boundary,
      occurredAt: at(2)
    });
    expect(fork).toMatchObject({
      replayed: false,
      session: { sessionId: 'session-child', version: 1 },
      lineage: { sourceSessionId: 'session-parent', boundary }
    });
    await expect(unit.forkSession({
      commandId: 'fork-command',
      eventId: 'fork-event',
      sessionId: 'session-child',
      sourceSessionId: 'session-parent',
      workspaceId: 'workspace-navigation',
      expectedSourceSessionVersion: 2,
      boundary,
      occurredAt: at(2)
    })).resolves.toMatchObject({ replayed: true });

    const child = await authority.acceptUserMessage(acceptMessage(
      'child', 'child-message', 'accept-child', 1, 'child follow-up'
    ));
    const history = await unit.authorityTransaction((transaction) => (
      transaction.loadSessionMessageHistoryThrough(
        child.session.sessionId,
        child.messageVersion.messageId,
        child.messageVersion.version
      )
    ));
    expect(history.map((message) => [message.sessionId, message.payload.content])).toEqual([
      ['session-parent', 'parent objective'],
      ['session-child', 'child follow-up']
    ]);
  });

  it('rejects fork drift and resolves exact stable references after process restart', async () => {
    const root = tempRoot();
    let unit = track(new SqliteConversationRunHandoffUnitOfWork(root));
    const authority = new ConversationAuthorityService(unit);
    await authority.createSession(createSession('parent', 'create-parent'));
    const accepted = await authority.acceptUserMessage(acceptMessage(
      'parent', 'parent-message', 'accept-parent', 1, 'restart-stable content'
    ));
    const reference = {
      sessionId: accepted.messageVersion.sessionId,
      messageId: accepted.messageVersion.messageId,
      messageVersion: accepted.messageVersion.version,
      contentDigest: accepted.messageVersion.contentDigest
    };
    const request = {
      commandId: 'fork-command',
      eventId: 'fork-event',
      sessionId: 'session-child',
      sourceSessionId: 'session-parent',
      workspaceId: 'workspace-navigation',
      expectedSourceSessionVersion: 2,
      boundary: reference,
      occurredAt: at(2)
    } as const;
    await unit.forkSession(request);
    await expect(unit.forkSession({ ...request, sessionId: 'session-drift' }))
      .rejects.toThrow('conversation_fork_command_conflict');

    await closeUnit(unit);
    units.delete(unit);
    unit = track(new SqliteConversationRunHandoffUnitOfWork(root));
    await expect(unit.resolveMessageReference(reference)).resolves.toMatchObject({
      reference,
      workspaceId: 'workspace-navigation',
      content: 'restart-stable content'
    });
    await expect(unit.resolveMessageReference({
      ...reference,
      contentDigest: `sha256:${'0'.repeat(64)}`
    })).rejects.toThrow('conversation_message_reference_not_found');

    const matches = await unit.querySessions({
      workspaceId: 'workspace-navigation',
      query: 'restart-stable',
      status: 'all',
      limit: 20
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      session: { sessionId: 'session-parent' },
      matches: [{ reference, role: 'user' }]
    });
    const child = await unit.querySessions({
      workspaceId: 'workspace-navigation',
      query: '(fork)',
      status: 'active',
      limit: 20
    });
    expect(child).toMatchObject([{
      session: { sessionId: 'session-child' },
      lineage: { sourceSessionId: 'session-parent', boundary: reference }
    }]);
  });
});

function createSession(suffix: string, command: string) {
  return {
    kind: 'conversation.create_session' as const,
    commandId: command,
    eventId: `${command}-event`,
    sessionId: `session-${suffix}`,
    workspaceId: 'workspace-navigation',
    expectedVersion: null,
    occurredAt: at(0)
  };
}

function acceptMessage(
  sessionSuffix: string,
  messageId: string,
  commandId: string,
  expectedSessionVersion: number,
  content: string
) {
  return {
    kind: 'conversation.accept_user_message' as const,
    commandId,
    eventId: `${commandId}-event`,
    sessionId: `session-${sessionSuffix}`,
    workspaceId: 'workspace-navigation',
    expectedSessionVersion,
    messageId,
    expectedMessageVersion: null,
    content,
    sagaId: `${commandId}-saga`,
    handoffCommandId: `${commandId}-handoff`,
    handoffOutboxMessageId: `${commandId}-outbox`,
    occurredAt: at(sessionSuffix === 'child' ? 3 : 1)
  };
}

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-conversation-navigation-'));
  roots.add(root);
  return root;
}

function track(unit: SqliteConversationRunHandoffUnitOfWork) {
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

function at(offsetSeconds: number): string {
  return new Date(Date.UTC(2030, 0, 1, 0, 0, offsetSeconds)).toISOString();
}
