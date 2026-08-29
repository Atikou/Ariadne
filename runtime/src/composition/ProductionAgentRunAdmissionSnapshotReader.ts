import {
  assertValidAgentRunBinding,
  cloneAgentAvailableTool,
  cloneAgentRunBinding,
  type AgentCapabilityGrant,
  type AgentRunBinding,
  type AgentSubagentProviderBinding
} from '@ariadne/agent-core';

import {
  digestConversationMessagePayload,
  assertValidConversationMessageHead,
  assertValidConversationMessageVersion,
  assertValidConversationSession,
  type ConversationMessageVersion
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
import type {
  AgentInstructionAssemblyRequest,
  AgentInstructionAssemblyService
} from '../control/ports/AgentInstructionAssembly.js';
import {
  deriveAgentAdmissionRunId,
  type AgentRunAdmissionSnapshot,
  type AgentRunAdmissionSnapshotReader,
  type AgentRunRequestedHandoffMessage
} from '../control/run/AgentRunAdmissionController.js';
import type { ConversationMessageExecutionV3 } from '@ariadne/protocol/public';
import { renderAgentInstructionSnapshot } from './instructions/ProductionAgentInstructionAssembly.js';

interface ExactConversationObjective {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly messageId: string;
  readonly messageVersion: number;
  readonly objectiveDigest: string;
  readonly content: string;
  readonly execution: ConversationMessageExecutionV3;
  readonly history: readonly ConversationMessageVersion[];
}

export interface AgentAdmissionHookPolicy {
  applyAdmission(binding: AgentRunBinding, occurredAt: string): Promise<AgentRunBinding>;
}

export class ProductionAgentRunAdmissionSnapshotError extends Error {
  public constructor(
    public readonly code:
      | 'AGENT_ADMISSION_CONVERSATION_AUTHORITY_MISSING'
      | 'AGENT_ADMISSION_CONVERSATION_AUTHORITY_MISMATCH'
      | 'AGENT_ADMISSION_CONTEXT_INVALID'
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
    private readonly instructions: AgentInstructionAssemblyService,
    private readonly hooks?: AgentAdmissionHookPolicy,
    private readonly subagentProviders?: readonly AgentSubagentProviderBinding[]
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
      ...(objective.history.some((message) => (message.payload.attachments?.length ?? 0) > 0)
        ? { requiresVision: true as const }
        : {}),
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

    const admittedBinding = bindingFromAuthority(bundle, this.subagentProviders);
    let binding = admittedBinding;
    try {
      binding = await this.hooks?.applyAdmission(binding, request.occurredAt) ?? binding;
      assertAdmissionBindingAttenuation(admittedBinding, binding);
    } catch (cause) {
      throw error(
        'AGENT_ADMISSION_HOOK_REJECTED',
        'A configured run.admission.pre Hook rejected or invalidated Agent admission.',
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

    let instructionMessages: readonly string[];
    try {
      const instructionRequest = Object.freeze<AgentInstructionAssemblyRequest>({
        runId,
        sessionId: objective.sessionId,
        workspaceId: objective.workspaceId,
        executionMode: objective.execution.mode
      });
      const instructionSnapshot = await this.instructions.assemble(instructionRequest, signal);
      signal.throwIfAborted();
      instructionMessages = renderAgentInstructionSnapshot(
        instructionSnapshot,
        instructionRequest
      );
    } catch (cause) {
      if (signal.aborted) signal.throwIfAborted();
      throw error(
        'AGENT_ADMISSION_INSTRUCTIONS_INVALID',
        'Configured Workspace or Skill instructions could not be resolved safely.',
        cause
      );
    }
    const contextMessages = objective.history.flatMap((message) => [
      ...(message.payload.content.length === 0
        ? []
        : [{
            kind: 'text' as const,
            role: message.role,
            content: message.payload.content
          }]),
      ...(message.payload.attachments ?? []).map((attachment) => ({
        kind: 'image' as const,
        role: 'user' as const,
        owner: {
          sessionId: message.sessionId,
          workspaceId: message.workspaceId,
          messageId: message.messageId,
          messageVersion: message.version
        },
        attachment: { ...attachment }
      }))
    ]);
    const systemMessages = instructionMessages.map((content) => ({
        kind: 'text' as const,
        role: 'system' as const,
        content
      }));
    if (systemMessages.length + contextMessages.length > 2_047) {
      throw error(
        'AGENT_ADMISSION_CONTEXT_INVALID',
        'Conversation history exceeds the protected v3 Turn collection bound.'
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
          ...systemMessages,
          ...contextMessages
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
      const history = await transaction.loadSessionMessageHistoryThrough(
        request.sessionId,
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
      const actualDigest = await digestConversationMessagePayload(message.payload);
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
      if (
        history.length === 0
        || history.length > 2_048
        || history.some((entry) => {
          try {
            assertValidConversationMessageVersion(entry);
          } catch {
            return true;
          }
          return entry.sessionId !== session.sessionId
            || entry.workspaceId !== session.workspaceId;
        })
        || history.at(-1)?.messageId !== message.messageId
        || history.at(-1)?.version !== message.version
        || history.at(-1)?.contentDigest !== message.contentDigest
      ) {
        throw error(
          'AGENT_ADMISSION_CONTEXT_INVALID',
          'Conversation history does not terminate at the exact immutable objective.'
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
        ),
        history: history.map((entry) => structuredClone(entry))
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

/**
 * Hooks may reject an admission or reduce authority, but cannot replace any
 * identity/version snapshot or add grants. This protects the boundary even
 * when AgentAdmissionHookPolicy has a non-built-in implementation.
 */
function assertAdmissionBindingAttenuation(
  admitted: AgentRunBinding,
  candidate: AgentRunBinding
): void {
  assertValidAgentRunBinding(admitted);
  assertValidAgentRunBinding(candidate);
  const unchanged = (left: unknown, right: unknown, label: string): void => {
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      throw new Error(`agent_admission_hook_replaced_${label}`);
    }
  };
  const subset = (
    child: readonly string[],
    parent: readonly string[],
    label: string
  ): void => {
    const allowed = new Set(parent);
    if (child.some((value) => !allowed.has(value))) {
      throw new Error(`agent_admission_hook_expanded_${label}`);
    }
  };

  if (candidate.bindingVersion !== admitted.bindingVersion) {
    throw new Error('agent_admission_hook_replaced_binding_version');
  }
  if (admitted.bindingVersion === 4 && candidate.bindingVersion === 4) {
    unchanged(candidate.executionProfile, admitted.executionProfile, 'execution_profile');
  }
  unchanged(candidate.sessionId, admitted.sessionId, 'session');
  unchanged(candidate.objectiveRef, admitted.objectiveRef, 'objective');
  unchanged(candidate.model, admitted.model, 'model');

  unchanged(candidate.workspace.workspaceId, admitted.workspace.workspaceId, 'workspace');
  unchanged(candidate.workspace.revision, admitted.workspace.revision, 'workspace_revision');
  unchanged(candidate.workspace.grantDigest, admitted.workspace.grantDigest, 'workspace_grant');
  if (admitted.workspace.access === 'read' && candidate.workspace.access !== 'read') {
    throw new Error('agent_admission_hook_expanded_workspace_access');
  }
  subset(candidate.workspace.scopeIds, admitted.workspace.scopeIds, 'workspace_scopes');

  unchanged(candidate.policy.policyId, admitted.policy.policyId, 'policy');
  unchanged(candidate.policy.revision, admitted.policy.revision, 'policy_revision');
  if (
    admitted.policy.permissionMode === 'ask'
    && candidate.policy.permissionMode !== 'ask'
  ) {
    throw new Error('agent_admission_hook_expanded_permission_mode');
  }
  assertCapabilityAttenuation(admitted.capabilities, candidate.capabilities, subset);

  unchanged(candidate.toolCatalog.catalogId, admitted.toolCatalog.catalogId, 'tool_catalog');
  unchanged(candidate.toolCatalog.revision, admitted.toolCatalog.revision, 'tool_catalog_revision');
  unchanged(candidate.toolCatalog.digest, admitted.toolCatalog.digest, 'tool_catalog_digest');
  subset(
    candidate.toolCatalog.allowedToolNames,
    admitted.toolCatalog.allowedToolNames,
    'tool_catalog'
  );

  unchanged(candidate.budget.grantId, admitted.budget.grantId, 'budget_grant');
  unchanged(candidate.budget.runId, admitted.budget.runId, 'budget_run');
  unchanged(candidate.budget.source, admitted.budget.source, 'budget_source');
  if (Date.parse(candidate.budget.deadlineAt) > Date.parse(admitted.budget.deadlineAt)) {
    throw new Error('agent_admission_hook_expanded_budget_deadline');
  }
  for (const key of Object.keys(admitted.budget.vector) as Array<
    keyof typeof admitted.budget.vector
  >) {
    if (candidate.budget.vector[key] > admitted.budget.vector[key]) {
      throw new Error(`agent_admission_hook_expanded_budget_${key}`);
    }
  }
}

function assertCapabilityAttenuation(
  admitted: readonly AgentCapabilityGrant[],
  candidate: readonly AgentCapabilityGrant[],
  assertSubset: (
    child: readonly string[],
    parent: readonly string[],
    label: string
  ) => void
): void {
  const byId = new Map(admitted.map((grant) => [grant.capabilityId, grant]));
  for (const grant of candidate) {
    const parent = byId.get(grant.capabilityId);
    if (parent === undefined) {
      throw new Error('agent_admission_hook_expanded_capabilities');
    }
    assertSubset(grant.scopeIds, parent.scopeIds, `capability_${grant.capabilityId}`);
  }
}

function bindingFromAuthority(
  bundle: AgentAdmissionAuthorityBundle,
  subagentProviders: readonly AgentSubagentProviderBinding[] | undefined
): AgentRunBinding {
  return {
    bindingVersion: 4,
    executionProfile: {
      ...bundle.subject.executionProfile,
      ...(subagentProviders === undefined
        ? {}
        : {
            subagentProviders: subagentProviders.map((provider) => ({
              ...provider,
              supportedModes: [...provider.supportedModes]
            }))
          })
    },
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
