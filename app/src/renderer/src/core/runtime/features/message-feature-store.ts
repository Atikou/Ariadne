import {
  PERSONAL_ASSISTANT_WORKSPACE_ID,
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  type ChatRoutingStrategy,
  type EncodedImageAttachmentV3,
  type ModelInferenceOptions,
  type PublicSessionProjectionV3,
  type RuntimeStatus
} from '@ariadne/protocol/public';
import type { RuntimeFeatureCommandGateway } from './runtime-feature-command-gateway';
import type { RuntimeMessage } from '../runtime-projection-presenter';
import type { SnapshotSource } from './feature-snapshot-store';

export interface MessageFeatureSnapshot {
  readonly messages: readonly RuntimeMessage[];
  readonly pendingOverlayIds: readonly string[];
}

export interface SendMessageOptions {
  modelId?: string;
  inference?: ModelInferenceOptions;
  routingStrategy?: ChatRoutingStrategy;
  workspaceId?: string;
  sessionId?: string;
  selectSession?: boolean;
  attachments?: readonly EncodedImageAttachmentV3[];
}

export interface MessageFeatureHost {
  selectedSessionId(): string | null;
  projectionSessions(): readonly PublicSessionProjectionV3[];
  hasCapability(capability: RuntimeStatus['capabilities'][number]): boolean;
  isPlanModeEnabled(sessionId: string | null): boolean;
  beginPendingChat(message: string, now: string): { readonly clientMessageId: string };
  moveNewSessionPlanMode(sessionId: string): void;
  selectSession(sessionId: string): void;
  acceptPendingChat(clientMessageId: string, sessionId: string): void;
  failPendingChat(clientMessageId: string, message: string): void;
  errorMessage(error: unknown): string;
  publish(): void;
  synchronize(): Promise<void>;
}

export class MessageFeatureStore {
  constructor(
    private readonly gateway: RuntimeFeatureCommandGateway,
    private readonly host: MessageFeatureHost,
    readonly view: SnapshotSource<MessageFeatureSnapshot>
  ) {}

  async send(
    message: string,
    options: SendMessageOptions = {}
  ): Promise<{ messageId: string; sessionId: string }> {
    const selectedSessionId = options.sessionId ?? this.host.selectedSessionId() ?? undefined;
    const selectedSession = this.host.projectionSessions().find(
      (session) => session.sessionId === selectedSessionId && session.status === 'active'
    );
    const workspaceId = selectedSession?.workspaceId
      ?? options.workspaceId
      ?? PERSONAL_ASSISTANT_WORKSPACE_ID;
    const planMode = workspaceId !== PERSONAL_ASSISTANT_WORKSPACE_ID
      && this.host.isPlanModeEnabled(selectedSessionId ?? null);
    if (planMode && !this.host.hasCapability('companion.agent-plan')) {
      throw new Error('runtime_capability_missing:companion.agent-plan');
    }
    const executionMode = workspaceId === PERSONAL_ASSISTANT_WORKSPACE_ID
      ? 'chat' as const
      : planMode ? 'plan' as const : 'agent' as const;
    const pending = this.host.beginPendingChat(message, new Date().toISOString());
    this.host.publish();

    try {
      let sessionId = selectedSessionId;
      let expectedSessionVersion = selectedSession?.version;
      if (!sessionId) {
        sessionId = crypto.randomUUID();
        const created = await this.gateway.execute({
          kind: 'conversation.session.create.v3',
          contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
          sessionId,
          workspaceId
        });
        if (created.kind !== 'conversation.session.created.v3' || created.sessionId !== sessionId) {
          throw new Error(`runtime_result_invalid:${created.kind}`);
        }
        expectedSessionVersion = created.version;
        if (planMode) this.host.moveNewSessionPlanMode(sessionId);
        if (options.selectSession !== false) this.host.selectSession(sessionId);
        this.host.acceptPendingChat(pending.clientMessageId, sessionId);
        this.host.publish();
      }
      if (expectedSessionVersion === undefined) {
        throw new Error('conversation_session_projection_missing');
      }
      const result = await this.gateway.execute({
        kind: 'conversation.message.accept.v3',
        contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
        sessionId,
        workspaceId,
        expectedSessionVersion,
        messageId: pending.clientMessageId,
        content: message,
        ...(options.attachments === undefined
          ? {}
          : { attachments: options.attachments.map((attachment) => ({ ...attachment })) }),
        execution: {
          mode: executionMode,
          ...(options.modelId === undefined ? {} : { modelId: options.modelId }),
          ...(options.inference === undefined ? {} : { inference: options.inference }),
          ...(options.routingStrategy === undefined ? {} : { routingStrategy: options.routingStrategy })
        }
      });
      if (result.kind !== 'conversation.message.accepted.v3'
        || result.sessionId !== sessionId
        || result.messageId !== pending.clientMessageId) {
        throw new Error(`runtime_result_invalid:${result.kind}`);
      }
      this.host.acceptPendingChat(pending.clientMessageId, result.sessionId);
      this.host.publish();
      void this.host.synchronize();
      return { messageId: result.messageId, sessionId: result.sessionId };
    } catch (error) {
      this.host.failPendingChat(pending.clientMessageId, this.host.errorMessage(error));
      this.host.publish();
      throw error;
    }
  }
}
