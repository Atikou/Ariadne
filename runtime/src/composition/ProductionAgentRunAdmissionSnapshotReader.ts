import {
  assertValidAgentRunBinding,
  cloneAgentAvailableTool,
  cloneAgentRunBinding,
  type AgentRunBinding
} from '@ariadne/agent-core';

import {
  digestConversationMessageContent,
  assertValidConversationMessageHead,
  assertValidConversationMessageVersion,
  assertValidConversationSession
} from '../conversation/ConversationAuthority.js';
import {
  assertValidConversationRunHandoffSaga
} from '../conversation/ConversationRunHandoffSaga.js';
import {
  assertAgentAdmissionAuthorityBundle,
  type AgentAdmissionAuthorityBundle,
  type AgentAdmissionAuthorityBundleProvider,
  type AgentAdmissionAuthorityQueryV2,
  type AgentAdmissionToolCatalogProvider
} from '../control/ports/AgentAdmissionAuthority.js';
import type {
  ConversationAuthorityUnitOfWork
} from '../control/ports/ConversationAuthorityPersistence.js';
import {
  deriveAgentAdmissionRunId,
  type AgentRunAdmissionSnapshot,
  type AgentRunAdmissionSnapshotReader,
  type AgentRunRequestedHandoffMessage
} from '../control/run/AgentRunAdmissionController.js';
import type { ConversationMessageExecutionV3 } from '@ariadne/protocol/public';

interface ExactConversationObjective {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly messageId: string;
  readonly messageVersion: number;
  readonly objectiveDigest: string;
  readonly content: string;
  readonly execution: ConversationMessageExecutionV3;
}

export interface AgentAdmissionInstructionSource {
  resolve(workspaceId: string): string;
}

export interface AgentAdmissionHookPolicy {
  apply(binding: AgentRunBinding, occurredAt: string): AgentRunBinding;
}

export class ProductionAgentRunAdmissionSnapshotError extends Error {
  public constructor(
    public readonly code:
      | 'AGENT_ADMISSION_CONVERSATION_AUTHORITY_MISSING'
      | 'AGENT_ADMISSION_CONVERSATION_AUTHORITY_MISMATCH'
      | 'AGENT_ADMISSION_AUTHORITY_MISSING'
      | 'AGENT_ADMISSION_AUTHORITY_INVALID'
      | 'AGENT_ADMISSION_INSTRUCTIONS_INVALID'
      | 'AGENT_ADMISSION_HOOK_REJECTED'
      | 'AGENT_ADMISSION_TOOL_CATALOG_MISSING'
      | 'AGENT_ADMISSION_TOOL_CATALOG_INVALID',
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'ProductionAgentRunAdmissionSnapshotError';
  }
}

/**
 * Pure Ariadne v3 admission snapshot adapter. Conversation owns the objective;
 * explicit authority bundles own grants; the compiler-backed immutable Tool
 * Catalog owns executable Tool identity. No AppContext or legacy store is read.
 */
export class ProductionAgentRunAdmissionSnapshotReader
implements AgentRunAdmissionSnapshotReader {
  public constructor(
    private readonly conversation: ConversationAuthorityUnitOfWork,
    private readonly authorities: AgentAdmissionAuthorityBundleProvider,
    private readonly catalogs: AgentAdmissionToolCatalogProvider,
    private readonly instructions?: AgentAdmissionInstructionSource,
    private readonly hooks?: AgentAdmissionHookPolicy
  ) {}

  public async readAdmissionSnapshot(
    request: AgentRunRequestedHandoffMessage,
    signal: AbortSignal
  ): Promise<AgentRunAdmissionSnapshot> {
    signal.throwIfAborted();
    const runId = await deriveAgentAdmissionRunId(request);
    signal.throwIfAborted();
    const objective = await this.readExactConversationObjective(request, signal);
    const query = Object.freeze<AgentAdmissionAuthorityQueryV2>({
      queryVersion: 2,
      subjectVersion: 2,
      sessionId: objective.sessionId,
      workspaceId: objective.workspaceId,
      objectiveMessageId: objective.messageId,
      objectiveMessageVersion: objective.messageVersion,
      objectiveDigest: objective.objectiveDigest,
      runId,
      execution: structuredClone(objective.execution)
    });

    signal.throwIfAborted();
    const bundle = await this.authorities.readAuthorityBundle(query, signal);
    signal.throwIfAborted();
    if (bundle === null) {
      throw error(
        'AGENT_ADMISSION_AUTHORITY_MISSING',
        'No exact Agent admission authority bundle exists for the Conversation objective.'
      );
    }
    try {
      assertAgentAdmissionAuthorityBundle(bundle);
      assertExactBundleSubject(bundle, query);
    } catch (cause) {
      throw error(
        'AGENT_ADMISSION_AUTHORITY_INVALID',
        'Agent admission authority does not match the exact Conversation objective.',
        cause
      );
    }

    let binding = bindingFromAuthority(bundle);
    try {
      binding = this.hooks?.apply(binding, request.occurredAt) ?? binding;
    } catch (cause) {
      throw error(
        'AGENT_ADMISSION_HOOK_REJECTED',
        'A configured run.pre hook rejected or invalidated Agent admission.',
        cause
      );
    }
    try {
      assertValidAgentRunBinding(binding);
    } catch (cause) {
      throw error(
        'AGENT_ADMISSION_AUTHORITY_INVALID',
        'Agent admission authority cannot construct a valid versioned Run binding.',
        cause
      );
    }
    const catalogReference = Object.freeze({
      referenceVersion: 1 as const,
      catalogId: binding.toolCatalog.catalogId,
      revision: binding.toolCatalog.revision,
      digest: binding.toolCatalog.digest
    });
    signal.throwIfAborted();
    const catalog = await this.catalogs.readToolCatalog(catalogReference, signal);
    signal.throwIfAborted();
    if (catalog === null) {
      throw error(
        'AGENT_ADMISSION_TOOL_CATALOG_MISSING',
        'The exact immutable Agent Tool Catalog is unavailable.'
      );
    }

    let availableTools: AgentRunAdmissionSnapshot['input']['availableTools'];
    try {
      availableTools = catalog.resolveAdmissionTools(binding).map((tool, index) => (
        cloneAgentAvailableTool(tool, `admission.availableTools[${String(index)}]`)
      ));
    } catch (cause) {
      throw error(
        'AGENT_ADMISSION_TOOL_CATALOG_INVALID',
        'The immutable Agent Tool Catalog contradicts the admission authority.',
        cause
      );
    }

    let instructionText = '';
    try {
      instructionText = this.instructions?.resolve(objective.workspaceId) ?? '';
    } catch (cause) {
      throw error(
        'AGENT_ADMISSION_INSTRUCTIONS_INVALID',
        'Configured Workspace or Skill instructions could not be resolved safely.',
        cause
      );
    }
    return {
      sessionId: objective.sessionId,
      workspaceId: objective.workspaceId,
      messageId: objective.messageId,
      messageVersion: objective.messageVersion,
      objectiveDigest: objective.objectiveDigest,
      binding: cloneAgentRunBinding(binding),
      input: {
        messages: [
          ...(instructionText.length === 0 ? [] : [{
            kind: 'text' as const,
            role: 'system' as const,
            content: instructionText
          }]),
          ...(objective.execution.mode === 'plan' ? [{
            kind: 'text' as const,
            role: 'system' as const,
            content: 'Plan mode is read-only. Inspect with read-only tools when needed, then respond with a concrete implementation plan. Do not request or invoke write or shell tools.'
          }] : []),
          { kind: 'text', role: 'user', content: objective.content }
        ],
        availableTools
      }
    };
  }

  private readExactConversationObjective(
    request: AgentRunRequestedHandoffMessage,
    signal: AbortSignal
  ): Promise<ExactConversationObjective> {
    return this.conversation.authorityTransaction(async (transaction) => {
      signal.throwIfAborted();
      const session = await transaction.loadSession(request.sessionId);
      const saga = await transaction.loadSaga(request.sagaId);
      const head = await transaction.loadMessageHead(request.objectiveMessageId);
      const message = await transaction.loadMessageVersion(
        request.objectiveMessageId,
        request.objectiveMessageVersion
      );
      signal.throwIfAborted();
      if (session === null || saga === null || head === null || message === null) {
        throw error(
          'AGENT_ADMISSION_CONVERSATION_AUTHORITY_MISSING',
          'The exact Conversation Session, Handoff, Message head, or Message version is missing.'
        );
      }
      try {
        assertValidConversationSession(session);
        assertValidConversationRunHandoffSaga(saga);
        assertValidConversationMessageHead(head);
        assertValidConversationMessageVersion(message);
      } catch (cause) {
        throw error(
          'AGENT_ADMISSION_CONVERSATION_AUTHORITY_MISMATCH',
          'Conversation admission authority contains invalid data.',
          cause
        );
      }
      const actualDigest = await digestConversationMessageContent(message.payload.content);
      signal.throwIfAborted();
      if (
        session.sessionId !== request.sessionId
        || session.workspaceId !== request.workspaceId
        || saga.sagaId !== request.sagaId
        || saga.version !== request.sagaVersion
        || saga.sessionId !== request.sessionId
        || saga.workspaceId !== request.workspaceId
        || saga.messageId !== request.objectiveMessageId
        || saga.messageVersion !== request.objectiveMessageVersion
        || saga.objectiveDigest !== request.objectiveDigest
        || saga.stage.kind !== 'agent_run_requested'
        || saga.stage.runRequestId !== request.runRequestId
        || saga.stage.agentCommandId !== request.agentCommandId
        || saga.stage.requestedAt !== request.occurredAt
        || head.messageId !== request.objectiveMessageId
        || head.sessionId !== request.sessionId
        || head.workspaceId !== request.workspaceId
        || head.latestVersion !== request.objectiveMessageVersion
        || message.messageId !== request.objectiveMessageId
        || message.version !== request.objectiveMessageVersion
        || message.sessionId !== request.sessionId
        || message.workspaceId !== request.workspaceId
        || message.role !== 'user'
        || message.contentDigest !== request.objectiveDigest
        || actualDigest !== request.objectiveDigest
      ) {
        throw error(
          'AGENT_ADMISSION_CONVERSATION_AUTHORITY_MISMATCH',
          'Conversation admission authority drifted from the immutable Handoff request.'
        );
      }
      return Object.freeze({
        sessionId: session.sessionId,
        workspaceId: session.workspaceId,
        messageId: message.messageId,
        messageVersion: message.version,
        objectiveDigest: message.contentDigest,
        content: message.payload.content,
        execution: structuredClone(
          message.payload.execution ?? { mode: 'agent' as const }
        )
      });
    });
  }
}

function assertExactBundleSubject(
  bundle: AgentAdmissionAuthorityBundle,
  query: AgentAdmissionAuthorityQueryV2
): void {
  const subject = bundle.subject;
  if (
    subject.subjectVersion !== query.subjectVersion
    || subject.sessionId !== query.sessionId
    || subject.workspaceId !== query.workspaceId
    || subject.objectiveMessageId !== query.objectiveMessageId
    || subject.objectiveMessageVersion !== query.objectiveMessageVersion
    || subject.objectiveDigest !== query.objectiveDigest
    || subject.runId !== query.runId
    || subject.executionProfile.mode !== query.execution.mode
  ) {
    throw new Error('agent_admission_authority_subject_mismatch');
  }
}

function bindingFromAuthority(
  bundle: AgentAdmissionAuthorityBundle
): AgentRunBinding {
  return {
    bindingVersion: 4,
    executionProfile: { ...bundle.subject.executionProfile },
    sessionId: bundle.subject.sessionId,
    objectiveRef: {
      kind: 'conversation_message',
      messageId: bundle.subject.objectiveMessageId,
      messageVersion: bundle.subject.objectiveMessageVersion,
      contentDigest: bundle.subject.objectiveDigest
    },
    workspace: {
      ...bundle.workspace,
      scopeIds: [...bundle.workspace.scopeIds]
    },
    model: { ...bundle.model },
    policy: { ...bundle.policy },
    capabilities: bundle.capabilityGrant.capabilities.map((grant) => ({
      capabilityId: grant.capabilityId,
      scopeIds: [...grant.scopeIds]
    })),
    toolCatalog: {
      ...bundle.toolCatalog,
      allowedToolNames: [...bundle.toolCatalog.allowedToolNames]
    },
    budget: {
      grantId: bundle.rootBudget.grantId,
      runId: bundle.rootBudget.runId,
      vector: { ...bundle.rootBudget.vector },
      deadlineAt: bundle.rootBudget.deadlineAt,
      source: { kind: 'root' }
    }
  };
}

function error(
  code: ProductionAgentRunAdmissionSnapshotError['code'],
  message: string,
  cause?: unknown
): ProductionAgentRunAdmissionSnapshotError {
  return new ProductionAgentRunAdmissionSnapshotError(
    code,
    message,
    cause === undefined ? undefined : { cause }
  );
}
