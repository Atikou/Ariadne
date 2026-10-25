import type {
  EncodedImageAttachment,
  ImageAttachmentRef
} from '@ariadne/protocol/public';
import type { ConversationMessageVersion } from '../../conversation/ConversationAuthority.js';

export interface StoredConversationImageAttachment {
  readonly ref: ImageAttachmentRef;
  readonly data: Uint8Array;
}

export interface OwnedConversationImageAttachment {
  readonly owner: {
    readonly sessionId: string;
    readonly workspaceId: string;
    readonly messageId: string;
    readonly messageVersion: number;
  };
  readonly ref: ImageAttachmentRef;
}

export interface ConversationAttachmentReader {
  readOwnedImage(
    input: OwnedConversationImageAttachment,
    signal?: AbortSignal
  ): Promise<StoredConversationImageAttachment>;
}

/** Narrow immutable authority read used to prove an attachment owner. */
export interface ConversationAttachmentOwnerReader {
  readMessageVersion(
    messageId: string,
    version: number
  ): Promise<ConversationMessageVersion | null>;
}

/** Immutable binary owner below the v3 Conversation data root. */
export interface ConversationAttachmentStore {
  saveImages(
    inputs: readonly EncodedImageAttachment[],
    signal?: AbortSignal
  ): Promise<readonly ImageAttachmentRef[]>;

  readImage(
    ref: ImageAttachmentRef,
    signal?: AbortSignal
  ): Promise<StoredConversationImageAttachment>;
}
