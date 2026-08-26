import {
  AgentRunInvariantError,
  assertCanonicalSortedPublicIds,
  assertValidAgentAvailableTool,
  assertValidAgentRunBinding,
  cloneCanonicalAgentToolInput,
  cloneAgentAvailableTool,
  cloneAgentPinnedToolIdentity,
  cloneAgentRunBinding,
  sameAgentPinnedToolIdentity,
  type AgentAvailableTool,
  type AgentEffectExecutor,
  type AgentRunBinding,
  type AgentToolAdmissionDecision,
  type AgentToolAdmissionPolicy,
  type AgentToolAdmissionRequest,
  type AgentToolJsonValue
} from '@ariadne/agent-core';

import type {
  AgentAdmissionToolCatalog
} from '../../control/ports/AgentAdmissionAuthority.js';
import type {
  AgentInferenceToolContractDescriptorV1,
  AgentInferenceToolContractReader,
  ReadAgentInferenceToolContractsRequest
} from '../../control/ports/AgentInferenceToolContracts.js';
import type {
  AgentToolExecutionContext
} from '../../control/ports/AgentToolExecution.js';
import {
  assertTrustedAgentToolCatalogSnapshot,
  type TrustedAgentToolCatalogSnapshot,
  type TrustedAgentToolCatalogSnapshotEntry
} from './TrustedAgentToolCatalogCompiler.js';

interface CatalogEntry {
  readonly document: TrustedAgentToolCatalogSnapshotEntry['document'];
  readonly executable: TrustedAgentToolCatalogSnapshotEntry['executable'];
  readonly available: AgentAvailableTool;
}

interface AdmissionSnapshot {
  readonly binding: AgentRunBinding;
  readonly availableTools: readonly AgentAvailableTool[];
  readonly invocation: {
    readonly tool: AgentAvailableTool['tool'];
    readonly input: AgentToolJsonValue;
    readonly capabilityIds: readonly string[];
    readonly scope: readonly string[];
  };
}

interface ExecutionSnapshot {
  readonly runId: string;
  readonly effectId: string;
  readonly toolCallId: string;
  readonly tool: AgentAvailableTool['tool'];
  readonly idempotencyKey: string;
  readonly capabilityIds: readonly string[];
  readonly scope: readonly string[];
  readonly input: AgentToolJsonValue;
}

export interface AgentToolLifecycleHook {
  enforce(
    event: 'tool.dispatch.pre',
    eventId: string,
    occurredAt: string
  ): void;
}

/**
 * Process-local executable view of one immutable, already-pinned Tool Catalog.
 * It has no name-based refresh or provider replacement path: a new catalog
 * revision creates a new instance, while active Runs retain this exact one.
 */
export class ImmutableAgentToolCatalog
implements
AgentToolAdmissionPolicy,
AgentEffectExecutor,
AgentAdmissionToolCatalog,
AgentInferenceToolContractReader {
  private readonly entriesByName = new Map<string, CatalogEntry>();
  private readonly tools: readonly AgentAvailableTool[];
  private readonly identity: {
    readonly catalogId: string;
    readonly revision: number;
    readonly digest: string;
  };

  public constructor(
    snapshot: TrustedAgentToolCatalogSnapshot,
    private readonly lifecycleHook?: AgentToolLifecycleHook
  ) {
    assertTrustedAgentToolCatalogSnapshot(snapshot);
    this.identity = Object.freeze({
      catalogId: snapshot.catalogId,
      revision: snapshot.revision,
      digest: snapshot.catalogDigest
    });
    const available: AgentAvailableTool[] = [];
    for (const compiled of snapshot.entries) {
      const tool = cloneAgentPinnedToolIdentity(compiled.tool);
      const candidate: AgentAvailableTool = {
        tool,
        capabilityIds: [...compiled.document.capabilityIds]
      };
      assertValidAgentAvailableTool(candidate);
      const executableSnapshot = Object.freeze({
        normalizeAndValidate: compiled.executable.normalizeAndValidate,
        validatePrepared: compiled.executable.validatePrepared,
        execute: compiled.executable.execute
      });
      const entry = {
        document: compiled.document,
        executable: executableSnapshot,
        available: candidate
      };
      this.entriesByName.set(tool.toolName, entry);
      available.push(candidate);
    }
    this.tools = Object.freeze(available);
  }

  public availableTools(): readonly AgentAvailableTool[] {
    return this.tools.map((available) => ({
      tool: cloneAgentPinnedToolIdentity(available.tool),
      capabilityIds: [...available.capabilityIds]
    }));
  }

  /**
   * Returns only the exact contract data required to prompt a model. Executable
   * callbacks, output schemas, permission internals, and provider refresh paths
   * never cross this boundary.
   */
  public async readInferenceToolContracts(
    request: ReadAgentInferenceToolContractsRequest,
    signal: AbortSignal
  ): Promise<readonly AgentInferenceToolContractDescriptorV1[]> {
    signal.throwIfAborted();
    if (
      request.catalog.catalogId !== this.identity.catalogId
      || request.catalog.revision !== this.identity.revision
      || request.catalog.digest !== this.identity.digest
      || request.catalog.allowedToolNames.length !== request.availableTools.length
    ) {
      throw new AgentRunInvariantError(
        'Inference Tool contract request does not match the immutable catalog.'
      );
    }
    const descriptors = request.availableTools.map((available, index) => {
      assertValidAgentAvailableTool(
        available,
        `inference.availableTools[${String(index)}]`
      );
      const expectedName = request.catalog.allowedToolNames[index];
      const entry = this.entriesByName.get(available.tool.toolName);
      if (
        expectedName !== available.tool.toolName
        || entry === undefined
        || !sameAgentPinnedToolIdentity(entry.available.tool, available.tool)
        || !sameSortedValues(entry.available.capabilityIds, available.capabilityIds)
      ) {
        throw new AgentRunInvariantError(
          'Inference Tool contract request drifted from the exact admission snapshot.'
        );
      }
      return Object.freeze<AgentInferenceToolContractDescriptorV1>({
        descriptorVersion: 1,
        tool: Object.freeze(cloneAgentPinnedToolIdentity(entry.available.tool)),
        inputSchema: deepFreezeJson(
          cloneCanonicalAgentToolInput(
            entry.document.inputSchema,
            `inferenceToolContract.${entry.available.tool.toolName}.inputSchema`
          )
        ),
        scopeSemantics: entry.document.scopeSemantics,
        lifecycleSemantics: entry.document.lifecycleSemantics
      });
    });
    signal.throwIfAborted();
    return Object.freeze(descriptors);
  }

  /**
   * Produces the exact admission-time intersection of the pinned catalog and
   * one fully validated Run binding. Any contradictory authority is rejected
   * instead of silently refreshing, widening, or dropping a configured Tool.
   */
  public resolveAdmissionTools(
    binding: AgentRunBinding
  ): readonly AgentAvailableTool[] {
    assertValidAgentRunBinding(binding);
    if (
      binding.toolCatalog.catalogId !== this.identity.catalogId
      || binding.toolCatalog.revision !== this.identity.revision
      || binding.toolCatalog.digest !== this.identity.digest
    ) {
      throw new AgentRunInvariantError(
        'Admission Tool Catalog identity does not match the immutable catalog.'
      );
    }
    if (
      binding.workspace.scopeIds.length === 0
      || binding.capabilities.length === 0
      || binding.capabilities.some((grant) => grant.scopeIds.length === 0)
    ) {
      throw new AgentRunInvariantError(
        'Admission authority cannot contain an empty Workspace or Capability scope.'
      );
    }
    const workspaceScopes = new Set(binding.workspace.scopeIds);
    const grants = new Map(binding.capabilities.map((grant) => [
      grant.capabilityId,
      grant
    ] as const));
    if (binding.capabilities.some((grant) => (
      grant.scopeIds.some((scopeId) => !workspaceScopes.has(scopeId))
    ))) {
      throw new AgentRunInvariantError(
        'Admission Capability scopes must be contained by the Workspace grant.'
      );
    }
    const resolved = binding.toolCatalog.allowedToolNames.map((toolName) => {
      const entry = this.entriesByName.get(toolName);
      if (entry === undefined) {
        throw new AgentRunInvariantError(
          'Admission authority names a Tool absent from the immutable catalog.'
        );
      }
      if (
        entry.document.requiredWorkspaceAccess === 'write'
        && binding.workspace.access !== 'write'
      ) {
        throw new AgentRunInvariantError(
          'Admission authority grants a Tool beyond its Workspace access.'
        );
      }
      if (entry.available.capabilityIds.some((capabilityId) => (
        !grants.has(capabilityId)
      ))) {
        throw new AgentRunInvariantError(
          'Admission authority grants a Tool without all required Capabilities.'
        );
      }
      return Object.freeze(cloneAgentAvailableTool(entry.available));
    });
    return Object.freeze(resolved);
  }

  public async admit(
    request: AgentToolAdmissionRequest
  ): Promise<AgentToolAdmissionDecision> {
    const snapshot = snapshotAdmissionRequest(request);
    try {
      this.lifecycleHook?.enforce(
        'tool.dispatch.pre',
        request.invocation.toolCallId,
        new Date().toISOString()
      );
    } catch {
      return { status: 'deny', reason: 'policy_denied' };
    }
    const entry = this.entriesByName.get(snapshot.invocation.tool.toolName);
    if (entry === undefined) return { status: 'deny', reason: 'tool_not_available' };
    if (
      snapshot.binding.toolCatalog.catalogId !== entry.available.tool.catalogId
      || snapshot.binding.toolCatalog.revision !== entry.available.tool.revision
      || snapshot.binding.toolCatalog.digest !== entry.available.tool.digest
      || !snapshot.binding.toolCatalog.allowedToolNames.includes(
        entry.available.tool.toolName
      )
    ) {
      return { status: 'deny', reason: 'catalog_mismatch' };
    }
    if (
      !sameAgentPinnedToolIdentity(entry.available.tool, snapshot.invocation.tool)
      || !snapshot.availableTools.some((available) => (
        sameAgentPinnedToolIdentity(available.tool, snapshot.invocation.tool)
        && sameSortedValues(available.capabilityIds, snapshot.invocation.capabilityIds)
      ))
    ) {
      return { status: 'deny', reason: 'tool_identity_mismatch' };
    }
    if (!sameSortedValues(
      entry.available.capabilityIds,
      snapshot.invocation.capabilityIds
    )) {
      return { status: 'deny', reason: 'capability_mismatch' };
    }
    if (
      entry.document.requiredWorkspaceAccess === 'write'
      && snapshot.binding.workspace.access !== 'write'
    ) {
      return { status: 'deny', reason: 'workspace_access_denied' };
    }
    if (!isScopeAuthorized(snapshot)) {
      return { status: 'deny', reason: 'scope_denied' };
    }
    let normalizedInput: AgentToolJsonValue;
    const preparationInput = cloneCanonicalAgentToolInput(snapshot.invocation.input);
    const preparation = entry.executable.normalizeAndValidate(preparationInput);
    if (preparation.status === 'rejected') {
      return { status: 'deny', reason: 'input_invalid' };
    }
    normalizedInput = cloneCanonicalAgentToolInput(
      preparation.input,
      'normalizedToolInput'
    );
    return {
      status: entry.document.permission.approval === 'required' ? 'wait' : 'allow',
      tool: cloneAgentPinnedToolIdentity(entry.available.tool),
      capabilityIds: [...entry.available.capabilityIds],
      scope: [...snapshot.invocation.scope],
      normalizedInput
    };
  }

  public async execute(
    request: Parameters<AgentEffectExecutor['execute']>[0],
    signal: AbortSignal
  ): Promise<Awaited<ReturnType<AgentEffectExecutor['execute']>>> {
    const snapshot = snapshotExecutionRequest(request);
    const entry = this.entriesByName.get(snapshot.tool.toolName);
    if (
      entry === undefined
      || !sameAgentPinnedToolIdentity(entry.available.tool, snapshot.tool)
      || !sameSortedValues(entry.available.capabilityIds, snapshot.capabilityIds)
    ) {
      throw new AgentRunInvariantError(
        'Effect execution requires the exact immutable Tool identity and capability grant.'
      );
    }
    if (signal.aborted) {
      return {
        status: 'cancelled',
        reason: 'effect_execution_cancelled_before_tool_io'
      };
    }
    const durableInput = cloneCanonicalAgentToolInput(
      snapshot.input,
      'effectExecution.input'
    );
    const validationInput = cloneCanonicalAgentToolInput(durableInput);
    const validation = entry.executable.validatePrepared(validationInput);
    if (validation.status === 'rejected') {
      throw new AgentRunInvariantError(
        'Durable Effect input no longer satisfies the pinned Tool contract.'
      );
    }
    const revalidated = cloneCanonicalAgentToolInput(
      validation.input,
      'effectExecution.revalidatedInput'
    );
    if (JSON.stringify(revalidated) !== JSON.stringify(durableInput)) {
      throw new AgentRunInvariantError(
        'Durable Effect input must already equal the Tool contract normalized form.'
      );
    }
    if (signal.aborted) {
      return {
        status: 'cancelled',
        reason: 'effect_execution_cancelled_before_tool_io'
      };
    }
    const context: AgentToolExecutionContext = {
      runId: snapshot.runId,
      effectId: snapshot.effectId,
      toolCallId: snapshot.toolCallId,
      idempotencyKey: snapshot.idempotencyKey,
      capabilityIds: Object.freeze([...snapshot.capabilityIds]),
      scope: Object.freeze([...snapshot.scope]),
      signal
    };
    return entry.executable.execute(
      deepFreezeJson(cloneCanonicalAgentToolInput(durableInput)),
      Object.freeze(context)
    );
  }
}

function isScopeAuthorized(snapshot: AdmissionSnapshot): boolean {
  const requested = snapshot.invocation.scope;
  if (requested.some((scopeId) => !snapshot.binding.workspace.scopeIds.includes(scopeId))) {
    return false;
  }
  const grants = new Map(
    snapshot.binding.capabilities.map((grant) => [grant.capabilityId, grant] as const)
  );
  return snapshot.invocation.capabilityIds.every((capabilityId) => {
    const grant = grants.get(capabilityId);
    return grant !== undefined
      && requested.every((scopeId) => grant.scopeIds.includes(scopeId));
  });
}

function snapshotAdmissionRequest(
  request: AgentToolAdmissionRequest
): AdmissionSnapshot {
  const binding = cloneAgentRunBinding(request.run.binding);
  const availableTools = request.availableTools.map((available, index) => (
    cloneAgentAvailableTool(available, `availableTools[${String(index)}]`)
  ));
  const capabilityIds = snapshotCanonicalIds(
    request.invocation.capabilityIds,
    'invocation.capabilityIds'
  );
  const scope = snapshotCanonicalIds(request.invocation.scope, 'invocation.scope');
  return {
    binding,
    availableTools,
    invocation: {
      tool: cloneAgentPinnedToolIdentity(request.invocation.tool),
      input: cloneCanonicalAgentToolInput(request.invocation.input),
      capabilityIds,
      scope
    }
  };
}

function snapshotExecutionRequest(
  request: Parameters<AgentEffectExecutor['execute']>[0]
): ExecutionSnapshot {
  return {
    runId: request.runId,
    effectId: request.effectId,
    toolCallId: request.toolCallId,
    tool: cloneAgentPinnedToolIdentity(request.tool),
    idempotencyKey: request.idempotencyKey,
    capabilityIds: snapshotCanonicalIds(
      request.capabilityIds,
      'effectExecution.capabilityIds'
    ),
    scope: snapshotCanonicalIds(request.scope, 'effectExecution.scope'),
    input: cloneCanonicalAgentToolInput(request.input, 'effectExecution.input')
  };
}

function snapshotCanonicalIds(
  values: readonly string[],
  field: string
): readonly string[] {
  assertCanonicalSortedPublicIds(values, field);
  return [...values];
}

function deepFreezeJson(value: AgentToolJsonValue): AgentToolJsonValue {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    value.forEach((entry) => deepFreezeJson(entry));
    return Object.freeze(value);
  }
  Object.values(value).forEach((entry) => deepFreezeJson(entry));
  return Object.freeze(value);
}

function sameSortedValues(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}
