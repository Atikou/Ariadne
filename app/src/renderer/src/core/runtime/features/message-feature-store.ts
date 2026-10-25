import type { RuntimeFeatureCommandGateway } from './runtime-feature-command-gateway';
import type { RuntimeMessage } from '../runtime-projection-presenter';
import type { SnapshotSource } from './feature-snapshot-store';
import type { AriadneApi } from '@shared/contract';
import type { DraftDeliveryBinding } from './input-delivery-binding';
import { ConversationInputDeliveryController } from './conversation-input-delivery-controller';
import { publicProjectionCanonicalIdSchema, publicProjectionDigestSchema,
  type PublicProjectionMessageWindow, type PublicMessageMetadataWindowResult } from '@ariadne/protocol/public';
import {
  sendConversationMessage,
  type MessageFeatureHost,
  type SendMessageOptions
} from './send-conversation-message';

export type { MessageFeatureHost, SendMessageOptions } from './send-conversation-message';

export interface MessageFeatureSnapshot {
  readonly messages: readonly RuntimeMessage[];
  readonly pendingOverlayIds: readonly string[];
  readonly messageWindow: Extract<PublicMessageMetadataWindowResult, { status: 'ok' }> | null;
}

export class MessageFeatureStore {
  private readonly deliveries: ConversationInputDeliveryController;
  constructor(
    private readonly gateway: RuntimeFeatureCommandGateway,
    private readonly host: MessageFeatureHost,
    readonly view: SnapshotSource<MessageFeatureSnapshot>,
    private readonly readWindow?: (window: PublicProjectionMessageWindow) => Promise<void>,
    private readonly readBody?: (messageId: string, sessionId: string, windowDigest: string) => Promise<void>,
    persistence?: AriadneApi['inputDeliveryOutbox']
  ) { this.deliveries = new ConversationInputDeliveryController(gateway, persistence); }
  selectDraftOwner(key: string | null): void { this.host.selectDraftOwner(key); this.host.publish(); }
  /** The composition owner shares one bounded Message/Inbox dispatch queue. */
  loadBody(messageId: string, sessionId: string, windowDigest: string): Promise<void> {
    if (this.readBody === undefined) return Promise.reject(new Error('projection_message_body_reads_unavailable'));
    publicProjectionCanonicalIdSchema.parse(messageId); publicProjectionCanonicalIdSchema.parse(sessionId); publicProjectionDigestSchema.parse(windowDigest);
    return this.readBody(messageId, sessionId, windowDigest);
  }
  showWindow(window: PublicProjectionMessageWindow): Promise<void> {
    if (this.readWindow === undefined) throw new Error('projection_message_reads_unavailable');
    return this.readWindow(window);
  }

  send(
    message: string,
    options: SendMessageOptions = {}
  ): Promise<{ messageId: string; sessionId: string }> {
    return sendConversationMessage(this.gateway, this.host, message, options, this.deliveries);
  }
  async reconcileDraftDelivery(submissionId: string, binding: DraftDeliveryBinding): Promise<{ messageId: string; sessionId: string }> {
    const accepted = await this.deliveries.reconcileDraft(submissionId, { ...binding, onSessionCreated: async sessionId => {
      await binding.onSessionCreated(sessionId, () => { if (binding.canSelectSession()) this.host.selectSession(sessionId); });
    } });
    this.host.acceptPendingChat(submissionId, accepted.sessionId); this.host.publish(); void this.host.synchronize();
    return accepted;
  }
  settleDraftDelivery(submissionId: string): Promise<void> { return this.deliveries.settleDraft(submissionId); }
}
