import { imageAttachmentRefV3Schema } from '@ariadne/protocol/public';

import type {
  ConversationAttachmentReader,
  ConversationAttachmentOwnerReader,
  ConversationAttachmentStore,
  OwnedConversationImageAttachment,
  StoredConversationImageAttachment
} from '../ports/ConversationAttachmentStore.js';

/** Rebinds every protected image reference to its exact immutable Message owner. */
export class ProductionConversationAttachmentReader
implements ConversationAttachmentReader {
  public constructor(
    private readonly conversation: ConversationAttachmentOwnerReader,
    private readonly store: ConversationAttachmentStore
  ) {}

  public async readOwnedImage(
    input: OwnedConversationImageAttachment,
    signal?: AbortSignal
  ): Promise<StoredConversationImageAttachment> {
    signal?.throwIfAborted();
    const message = await this.conversation.readMessageVersion(
      input.owner.messageId,
      input.owner.messageVersion
    );
    signal?.throwIfAborted();
    if (
      message === null
      || message.role !== 'user'
      || message.sessionId !== input.owner.sessionId
      || message.workspaceId !== input.owner.workspaceId
      || !message.payload.attachments?.some((candidate) => sameRef(candidate, input.ref))
    ) throw new Error('conversation_attachment_owner_mismatch');
    return this.store.readImage(input.ref, signal);
  }
}

function sameRef(left: unknown, right: unknown): boolean {
  const parsedLeft = imageAttachmentRefV3Schema.safeParse(left);
  const parsedRight = imageAttachmentRefV3Schema.safeParse(right);
  return parsedLeft.success
    && parsedRight.success
    && JSON.stringify(parsedLeft.data) === JSON.stringify(parsedRight.data);
}
