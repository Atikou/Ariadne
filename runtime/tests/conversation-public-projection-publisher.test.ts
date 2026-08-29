import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectionCommitV3 } from '@ariadne/protocol/public';

import { SqliteConversationRunHandoffUnitOfWork } from '../src/adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import { SqlitePublicProjectionStore } from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import type {
  AcceptConversationUserMessageCommand,
  CreateConversationSessionCommand,
  MutateConversationSessionCommand
} from '../src/conversation/ConversationAuthority.js';
import { ConversationAuthorityService } from '../src/control/conversation/ConversationAuthorityService.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';
import {
  ConversationPublicProjectionPublisher
} from '../src/projection/ConversationPublicProjectionPublisher.js';

const roots = new Set<string>();
const conversations = new Set<SqliteConversationRunHandoffUnitOfWork>();
const projections = new Set<SqlitePublicProjectionStore>();

afterEach(async () => {
  await Promise.all([...projections].map(closeProjection));
  await Promise.all([...conversations].map(closeConversation));
  projections.clear();
  conversations.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe('ConversationPublicProjectionPublisher', () => {
  it('rebuilds redacted Session and Message DTOs from the authority ledger', async () => {
    const root = tempRoot();
    const conversation = trackConversation(
      new SqliteConversationRunHandoffUnitOfWork(root)
    );
    const projection = trackProjection(new SqlitePublicProjectionStore(root));
    const authority = new ConversationAuthorityService(conversation);
    await authority.createSession(createSession());
    await authority.acceptUserMessage(acceptMessage(
      'inspect C:\\private\\repo and /srv/private; api_key=topsecretvalue',
      [{
        attachmentId: `sha256:${'a'.repeat(64)}`,
        mediaType: 'image/webp',
        bytes: 1_024,
        width: 800,
        height: 600,
        name: 'api_key=topsecretvalue.webp'
      }]
    ));

    const publisher = new ConversationPublicProjectionPublisher(
      conversation,
      projection,
      { readLimit: 1 }
    );
    const first = publisher.publishPending();
    expect(publisher.publishPending()).toBe(first);
    await expect(first).resolves.toEqual({
      readRecords: 1,
      projectedRecords: 1,
      afterCursor: 1
    });
    await expect(publisher.publishPending()).resolves.toEqual({
      readRecords: 1,
      projectedRecords: 1,
      afterCursor: 2
    });
    await expect(publisher.publishPending()).resolves.toEqual({
      readRecords: 0,
      projectedRecords: 0,
      afterCursor: 2
    });

    const snapshot = await projection.snapshot();
    expect(snapshot.sessions).toEqual([{
      sessionId: 'session-projection',
      workspaceId: 'workspace-projection',
      version: 2,
      title: 'Conversation',
      pinned: false,
      status: 'active',
      createdAt: at(0),
      updatedAt: at(1)
    }]);
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0]).toMatchObject({
      messageId: 'message-projection',
      sessionId: 'session-projection',
      version: 1,
      role: 'user',
      status: 'completed'
    });
    expect(snapshot.messages[0]?.content).toContain('[redacted path]');
    expect(snapshot.messages[0]?.content).toContain('[redacted credential]');
    expect(snapshot.messages[0]?.attachments).toEqual([{
      attachmentId: `sha256:${'a'.repeat(64)}`,
      mediaType: 'image/webp',
      bytes: 1_024,
      width: 800,
      height: 600,
      name: '[redacted credential]'
    }]);
    expect(JSON.stringify(snapshot)).not.toContain('C:\\private');
    expect(JSON.stringify(snapshot)).not.toContain('/srv/private');
    expect(JSON.stringify(snapshot)).not.toContain('topsecretvalue');
  });

  it('replays the full authority ledger after restart without duplicating commits', async () => {
    const root = tempRoot();
    let conversation = trackConversation(
      new SqliteConversationRunHandoffUnitOfWork(root)
    );
    let projection = trackProjection(new SqlitePublicProjectionStore(root));
    const authority = new ConversationAuthorityService(conversation);
    await authority.createSession(createSession());
    await authority.acceptUserMessage(acceptMessage('safe public message'));
    const initial = new ConversationPublicProjectionPublisher(conversation, projection);
    await drain(initial);
    const before = await projection.snapshot();

    await closeConversation(conversation);
    conversations.delete(conversation);
    await closeProjection(projection);
    projections.delete(projection);
    conversation = trackConversation(new SqliteConversationRunHandoffUnitOfWork(root));
    projection = trackProjection(new SqlitePublicProjectionStore(root));
    const replay = new ConversationPublicProjectionPublisher(conversation, projection);
    await drain(replay);

    const after = await projection.snapshot();
    expect({ ...after, capturedAt: before.capturedAt }).toEqual(before);
    expect(after.cursor).toBe(2);
  });

  it('projects the exact title and archive state for every immutable Session version', async () => {
    const root = tempRoot();
    const conversation = trackConversation(
      new SqliteConversationRunHandoffUnitOfWork(root)
    );
    const authority = new ConversationAuthorityService(conversation);
    await authority.createSession(createSession());
    await authority.mutateSession(sessionMutation(
      'command-rename-projection',
      'event-rename-projection',
      1,
      { kind: 'rename', title: 'Durable projection title' },
      at(1)
    ));
    await authority.mutateSession(sessionMutation(
      'command-archive-projection',
      'event-archive-projection',
      2,
      { kind: 'set_status', status: 'archived' },
      at(2)
    ));

    const commits: ProjectionCommitV3[] = [];
    const publisher = new ConversationPublicProjectionPublisher(conversation, {
      append: async (commit) => { commits.push(commit); }
    });
    await drain(publisher);

    expect(commits.map((commit) => commit.changes[0]?.dto)).toEqual([
      expect.objectContaining({ version: 1, title: 'Conversation', status: 'active' }),
      expect.objectContaining({ version: 2, title: 'Durable projection title', status: 'active' }),
      expect.objectContaining({ version: 3, title: 'Durable projection title', status: 'archived' })
    ]);
  });
});

async function drain(publisher: ConversationPublicProjectionPublisher): Promise<void> {
  while ((await publisher.publishPending()).readRecords > 0) {
    await Promise.resolve();
  }
}

function createSession(): CreateConversationSessionCommand {
  return {
    kind: 'conversation.create_session',
    commandId: 'command-create-projection',
    eventId: 'event-create-projection',
    sessionId: 'session-projection',
    workspaceId: 'workspace-projection',
    expectedVersion: null,
    occurredAt: at(0)
  };
}

function acceptMessage(
  content: string,
  attachments?: AcceptConversationUserMessageCommand['attachments']
): AcceptConversationUserMessageCommand {
  return {
    kind: 'conversation.accept_user_message',
    commandId: 'command-accept-projection',
    eventId: 'event-accept-projection',
    sessionId: 'session-projection',
    workspaceId: 'workspace-projection',
    expectedSessionVersion: 1,
    messageId: 'message-projection',
    expectedMessageVersion: null,
    content,
    ...(attachments === undefined ? {} : { attachments }),
    sagaId: 'saga-projection',
    handoffCommandId: 'handoff-command-projection',
    handoffOutboxMessageId: 'handoff-outbox-projection',
    occurredAt: at(1)
  };
}

function sessionMutation(
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
    sessionId: 'session-projection',
    workspaceId: 'workspace-projection',
    expectedSessionVersion,
    mutation,
    occurredAt
  };
}

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-conversation-projection-'));
  roots.add(root);
  return root;
}

function trackConversation(
  unit: SqliteConversationRunHandoffUnitOfWork
): SqliteConversationRunHandoffUnitOfWork {
  conversations.add(unit);
  return unit;
}

function trackProjection(store: SqlitePublicProjectionStore): SqlitePublicProjectionStore {
  projections.add(store);
  return store;
}

async function closeConversation(
  unit: SqliteConversationRunHandoffUnitOfWork
): Promise<void> {
  const context = createShutdownContext(Date.now() + 5_000);
  try {
    await unit.close(context);
  } finally {
    context.dispose();
  }
}

async function closeProjection(store: SqlitePublicProjectionStore): Promise<void> {
  const context = createShutdownContext(Date.now() + 5_000);
  try {
    await store.close(context);
  } finally {
    context.dispose();
  }
}

function at(offsetSeconds: number): string {
  return new Date(Date.UTC(2030, 0, 1, 0, 0, offsetSeconds)).toISOString();
}
