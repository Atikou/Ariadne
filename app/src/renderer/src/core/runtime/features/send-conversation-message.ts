import {
  PERSONAL_ASSISTANT_WORKSPACE_ID,
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  type ConversationMessageExecution,
  type EncodedImageAttachment,
  type ModelInferenceOptions,
  type PublicSessionProjection,
  type RuntimeStatus
} from '@ariadne/protocol/public';
import { deriveConversationTitle } from '@renderer/modules/chat/conversation-title';
import type { RuntimeFeatureCommandGateway } from './runtime-feature-command-gateway';
import type { InputDeliveryOutboxStageRequest } from '@shared/contract';
import type { DraftDeliveryBinding } from './input-delivery-binding';
import { ConversationInputDeliveryController } from './conversation-input-delivery-controller';

export interface SendMessageOptions {
  modelId?: string;
  inference?: ModelInferenceOptions;
  localFallbackModelId?: string | null;
  workspaceId?: string;
  sessionId?: string | null;
  selectSession?: boolean;
  attachments?: readonly EncodedImageAttachment[];
  draft?: DraftDeliveryBinding;
}

export interface MessageFeatureHost {
  selectedSessionId(): string | null;
  projectionSessions(): readonly PublicSessionProjection[];
  resolveSendSession(sessionId: string): Promise<PublicSessionProjection | null>;
  hasCapability(capability: RuntimeStatus['capabilities'][number]): boolean;
  isPlanModeEnabled(sessionId: string | null): boolean;
  beginPendingChat(message: string, now: string, clientMessageId?: string, sessionId?: string | null, draftOwnerKey?: string): { readonly clientMessageId: string };
  selectDraftOwner(key: string | null): void;
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
  options: SendMessageOptions,
  delivery: ConversationInputDeliveryController = new ConversationInputDeliveryController(gateway)
): Promise<{ messageId: string; sessionId: string }> {
  const originalSelection = host.selectedSessionId();
  const selectedSessionId = (options.sessionId === undefined ? originalSelection : options.sessionId) ?? undefined;
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
  const execution: ConversationMessageExecution = {
    mode: workspaceId === PERSONAL_ASSISTANT_WORKSPACE_ID ? 'chat' : planMode ? 'plan' : 'agent',
    ...(options.modelId === undefined ? {} : { modelId: options.modelId }),
    ...(options.inference === undefined ? {} : { inference: options.inference }),
    ...(options.localFallbackModelId === undefined ? {} : { localFallbackModelId: options.localFallbackModelId })
  };
  const pending = host.beginPendingChat(message, new Date().toISOString(), options.draft?.submissionId, selectedSessionId ?? null, options.draft?.draftOwnerKey);
  host.publish();

  try {
    const requests: InputDeliveryOutboxStageRequest[] = [];
    let sessionId = selectedSessionId;
    let expectedSessionVersion = selectedSession?.version;
    if (sessionId !== undefined) {
      const current = await host.resolveSendSession(sessionId);
      if (current === null || current.status !== 'active' || current.workspaceId !== workspaceId) {
        throw new Error('conversation_session_projection_missing');
      }
      expectedSessionVersion = current.version;
    }
    if (!sessionId) {
      sessionId = crypto.randomUUID();
      requests.push({ commandId: crypto.randomUUID(), ...(options.draft ? { draftSubmissionId: options.draft.submissionId } : {}), command: {
        kind: 'conversation.session.create',
        contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
        sessionId,
        workspaceId,
        title: deriveConversationTitle(message, options.attachments !== undefined && options.attachments.length > 0)
      } });
      expectedSessionVersion = 1;
    }
    if (expectedSessionVersion === undefined) {
      throw new Error('conversation_session_projection_missing');
    }
    requests.push({ commandId: crypto.randomUUID(), ...(options.draft ? { draftSubmissionId: options.draft.submissionId } : {}), command: {
      kind: 'conversation.message.accept',
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
    } });
    const binding = options.draft && { ...options.draft, onSessionCreated: async (createdId: string) => {
      await options.draft!.onSessionCreated(createdId, () => {
        if (planMode) host.moveNewSessionPlanMode(createdId);
        if (options.selectSession !== false && options.draft!.canSelectSession()) host.selectSession(createdId);
      });
    } };
    const result = await delivery.send(requests, binding);
    if (!selectedSessionId && !binding) {
      if (planMode) host.moveNewSessionPlanMode(sessionId);
      if (options.selectSession !== false && host.selectedSessionId() === originalSelection) host.selectSession(sessionId);
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
    execution: ConversationMessageExecution;
  }
): Promise<void> {
  try {
    const generated = await gateway.execute({
      kind: 'conversation.session.title.generate',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      expectedSessionVersion: input.expectedSessionVersion,
      content: input.content,
      execution: input.execution
    });
    if (
      generated.kind !== 'conversation.session.title.generated'
      || generated.sessionId !== input.sessionId
      || generated.sessionVersion !== input.expectedSessionVersion
    ) return;
    const renamed = await gateway.execute({
      kind: 'conversation.session.rename',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      expectedSessionVersion: input.expectedSessionVersion,
      title: generated.title
    });
    if (
      renamed.kind === 'conversation.session.updated'
      && renamed.sessionId === input.sessionId
    ) void host.synchronize();
  } catch {
    // The compact local title remains usable when the optional model request fails.
  }
}
