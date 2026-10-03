import type { RuntimeFeatureCommandGateway } from './runtime-feature-command-gateway';
import type { RuntimeMessage } from '../runtime-projection-presenter';
import type { SnapshotSource } from './feature-snapshot-store';
import {
  sendConversationMessage,
  type MessageFeatureHost,
  type SendMessageOptions
} from './send-conversation-message';

export type { MessageFeatureHost, SendMessageOptions } from './send-conversation-message';

export interface MessageFeatureSnapshot {
  readonly messages: readonly RuntimeMessage[];
  readonly pendingOverlayIds: readonly string[];
}

export class MessageFeatureStore {
  constructor(
    private readonly gateway: RuntimeFeatureCommandGateway,
    private readonly host: MessageFeatureHost,
    readonly view: SnapshotSource<MessageFeatureSnapshot>
  ) {}

  send(
    message: string,
    options: SendMessageOptions = {}
  ): Promise<{ messageId: string; sessionId: string }> {
    return sendConversationMessage(this.gateway, this.host, message, options);
  }
}
