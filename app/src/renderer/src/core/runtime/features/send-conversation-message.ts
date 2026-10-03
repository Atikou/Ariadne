import {
  PERSONAL_ASSISTANT_WORKSPACE_ID,
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  type ChatRoutingStrategy,
  type ConversationMessageExecutionV3,
  type EncodedImageAttachmentV3,
  type ModelInferenceOptions,
  type PublicSessionProjectionV3,
  type RuntimeStatus
} from '@ariadne/protocol/public';
import { deriveConversationTitle } from '@renderer/modules/chat/conversation-title';
import type { RuntimeFeatureCommandGateway } from './runtime-feature-command-gateway';

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

export async function sendConversationMessage(
  gateway: RuntimeFeatureCommandGateway,
  host: MessageFeatureHost,
  message: string,
  options: SendMessageOptions
): Promise<{ messageId: string; sessionId: string }> {
  const selectedSessionId = options.sessionId ?? host.selectedSessionId() ?? undefined;
  const selectedSession = host.projectionSessions().find(
    (session) => session.sessionId === selectedSessionId && session.status === 'active'
  );
  const workspaceId = selectedSession?.workspaceId
    ?? options.workspaceId
    ?? PERSONAL_ASSISTANT_WORKSPACE_ID;
  const planMode = workspaceId !== PERSONAL_ASSISTANT_WORKSPACE_ID
    && host.isPlanModeEnabled(selectedSessionId ?? null);
  if (planMode && !host.hasCapability('companion.agent-plan')) {
    throw new Error('runtime_capability_missing:companion.agent-plan');
  }
  const execution: ConversationMessageExecutionV3 = {
    mode: workspaceId === PERSONAL_ASSISTANT_WORKSPACE_ID ? 'chat' : planMode ? 'plan' : 'agent',
    ...(options.modelId === undefined ? {} : { modelId: options.modelId }),
    ...(options.inference === undefined ? {} : { inference: options.inference }),
    ...(options.routingStrategy === undefined ? {} : { routingStrategy: options.routingStrategy })
  };
  const pending = host.beginPendingChat(message, new Date().toISOString());
  host.publish();

  try {
    let sessionId = selectedSessionId;
    let expectedSessionVersion = selectedSession?.version;
    if (!sessionId) {
      sessionId = crypto.randomUUID();
      const created = await gateway.execute({
        kind: 'conversation.session.create.v3',
        contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
        sessionId,
        workspaceId,
        title: deriveConversationTitle(message, options.attachments !== undefined && options.attachments.length > 0)
      });
      if (created.kind !== 'conversation.session.created.v3' || created.sessionId !== sessionId) {
        throw new Error(`runtime_result_invalid:${created.kind}`);
      }
      expectedSessionVersion = created.version;
      if (planMode) host.moveNewSessionPlanMode(sessionId);
      if (options.selectSession !== false) host.selectSession(sessionId);
      host.acceptPendingChat(pending.clientMessageId, sessionId);
      host.publish();
    }
    if (expectedSessionVersion === undefined) {
      throw new Error('conversation_session_projection_missing');
    }
    const result = await gateway.execute({
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
      execution
    });
    if (result.kind !== 'conversation.message.accepted.v3'
      || result.sessionId !== sessionId
      || result.messageId !== pending.clientMessageId) {
      throw new Error(`runtime_result_invalid:${result.kind}`);
    }
    host.acceptPendingChat(pending.clientMessageId, result.sessionId);
    host.publish();
    if (
      result.sessionVersion === 2
      && (!selectedSession || (selectedSession.version === 1 && selectedSession.title === 'Conversation'))
      && message.trim().length > 0
    ) {
      void generateAndApplyTitle(gateway, host, {
        sessionId,
        workspaceId,
        expectedSessionVersion: result.sessionVersion,
        content: message,
        execution
      });
    }
    void host.synchronize();
    return { messageId: result.messageId, sessionId: result.sessionId };
  } catch (error) {
    host.failPendingChat(pending.clientMessageId, host.errorMessage(error));
    host.publish();
    throw error;
  }
}

async function generateAndApplyTitle(
  gateway: RuntimeFeatureCommandGateway,
  host: MessageFeatureHost,
  input: {
    sessionId: string;
    workspaceId: string;
    expectedSessionVersion: number;
    content: string;
    execution: ConversationMessageExecutionV3;
  }
): Promise<void> {
  try {
    const generated = await gateway.execute({
      kind: 'conversation.session.title.generate.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      expectedSessionVersion: input.expectedSessionVersion,
      content: input.content,
      execution: input.execution
    });
    if (
      generated.kind !== 'conversation.session.title.generated.v3'
      || generated.sessionId !== input.sessionId
      || generated.sessionVersion !== input.expectedSessionVersion
    ) return;
    const renamed = await gateway.execute({
      kind: 'conversation.session.rename.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      expectedSessionVersion: input.expectedSessionVersion,
      title: generated.title
    });
    if (
      renamed.kind === 'conversation.session.updated.v3'
      && renamed.sessionId === input.sessionId
    ) void host.synchronize();
  } catch {
    // The compact local title remains usable when the optional model request fails.
  }
}
