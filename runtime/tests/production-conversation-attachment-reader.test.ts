import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';

import { LocalConversationAttachmentStore } from '../src/adapters/attachment/LocalConversationAttachmentStore.js';
import { SqliteConversationRunHandoffUnitOfWork } from '../src/adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import { ProductionConversationAttachmentReader } from '../src/control/conversation/ProductionConversationAttachmentReader.js';
import { ConversationAuthorityService } from '../src/control/conversation/ConversationAuthorityService.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';

const roots: string[] = [];
const units: SqliteConversationRunHandoffUnitOfWork[] = [];

afterEach(async () => {
  for (const unit of units.splice(0)) {
    const context = createShutdownContext(Date.now() + 5_000);
    try {
      await unit.close(context);
    } finally {
      context.dispose();
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ProductionConversationAttachmentReader', () => {
  it('reads bytes only when the exact immutable Message owns the exact reference', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ariadne-owned-attachment-'));
    roots.push(root);
    const conversation = new SqliteConversationRunHandoffUnitOfWork(root);
    units.push(conversation);
    const store = new LocalConversationAttachmentStore(root);
    const [ref] = await store.saveImages([{
      mediaType: 'image/png',
      data: (await sharp({
        create: { width: 4, height: 3, channels: 3, background: '#123456' }
      }).png().toBuffer()).toString('base64'),
      name: 'screen.png'
    }]);
    const authority = new ConversationAuthorityService(conversation);
    await authority.createSession({
      kind: 'conversation.create_session',
      commandId: 'command-create-owned-image',
      eventId: 'event-create-owned-image',
      sessionId: 'session-owned-image',
      workspaceId: 'workspace-owned-image',
      expectedVersion: null,
      occurredAt: '2030-01-01T00:00:00.000Z'
    });
    await authority.acceptUserMessage({
      kind: 'conversation.accept_user_message',
      commandId: 'command-accept-owned-image',
      eventId: 'event-accept-owned-image',
      sessionId: 'session-owned-image',
      workspaceId: 'workspace-owned-image',
      expectedSessionVersion: 1,
      messageId: 'message-owned-image',
      expectedMessageVersion: null,
      content: '',
      attachments: [ref!],
      sagaId: 'saga-owned-image',
      handoffCommandId: 'handoff-command-owned-image',
      handoffOutboxMessageId: 'handoff-outbox-owned-image',
      occurredAt: '2030-01-01T00:00:01.000Z'
    });
    const reader = new ProductionConversationAttachmentReader(conversation, store);
    const owned = {
      owner: {
        sessionId: 'session-owned-image',
        workspaceId: 'workspace-owned-image',
        messageId: 'message-owned-image',
        messageVersion: 1
      },
      ref: ref!
    };

    await expect(reader.readOwnedImage(owned)).resolves.toMatchObject({ ref });
    await expect(reader.readOwnedImage({
      ...owned,
      owner: { ...owned.owner, messageId: 'message-copied-image' }
    })).rejects.toThrow('conversation_attachment_owner_mismatch');
    await expect(reader.readOwnedImage({
      ...owned,
      ref: { ...ref!, name: 'renamed.png' }
    })).rejects.toThrow('conversation_attachment_owner_mismatch');
  });
});
