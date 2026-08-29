import { AgentRunInvariantError } from './errors.js';
import type { AgentRunId } from './values.js';
import type { AgentSubagentMode } from './directive.js';
import {
  assertCanonicalPublicId,
  assertNonNegativeInteger,
  assertPositiveInteger,
  assertSha256Digest,
  assertTimestamp
} from './values.js';

export interface AgentWorkspaceBinding {
  readonly workspaceId: string;
  readonly revision: number;
  readonly grantDigest: string;
  readonly access: 'read' | 'write';
  readonly scopeIds: readonly string[];
}

export interface AgentCapabilityGrant {
  readonly capabilityId: string;
  readonly scopeIds: readonly string[];
}

export interface AgentToolCatalogBinding {
  readonly catalogId: string;
  readonly revision: number;
  readonly digest: string;
  readonly allowedToolNames: readonly string[];
}

export interface AgentBudgetVector {
  readonly modelTurns: number;
  readonly toolCalls: number;
  readonly readCalls: number;
  readonly writeCalls: number;
  readonly shellCalls: number;
  readonly costMicrousd: number;
}

export type AgentBudgetGrantSource =
  | {
      readonly kind: 'root';
    }
  | {
      readonly kind: 'parent_allocation';
      readonly parentRunId: AgentRunId;
      readonly parentGrantId: string;
      readonly delegationId: string;
    };

export interface AgentBudgetGrant {
  readonly grantId: string;
  readonly runId: AgentRunId;
  readonly vector: AgentBudgetVector;
  readonly deadlineAt: string;
  readonly source: AgentBudgetGrantSource;
}

export interface AgentExecutionProfile {
  readonly mode: 'chat' | 'agent' | 'plan';
  readonly subagentProviders?: readonly AgentSubagentProviderBinding[];
}

export interface AgentSubagentProviderBinding {
  readonly providerId: string;
  readonly displayName: string;
  readonly configurationDigest: string;
  readonly transport: 'ordinary_run' | 'external_process';
  readonly supportedModes: readonly AgentSubagentMode[];
  readonly supportsStructuredReport: boolean;
  readonly inheritsParentContext: boolean;
  readonly usesParentTools: boolean;
}

export const DEFAULT_AGENT_SUBAGENT_PROVIDER_BINDING: AgentSubagentProviderBinding =
Object.freeze({
  providerId: 'ariadne.in_process',
  displayName: 'Ariadne ordinary Child Run',
  configurationDigest: 'sha256:7100da8c93bd1cb522a2d203f3285d3d8e2b12a4d1fb257ef2f6e7f40c3e7d07',
  transport: 'ordinary_run',
  supportedModes: Object.freeze(['one_shot', 'continuable'] as const),
  supportsStructuredReport: false,
  inheritsParentContext: true,
  usesParentTools: true
});

interface AgentRunBindingFields {
  readonly sessionId: string;
  /** Raw objective text remains in its authoritative protected store. */
  readonly objectiveRef: AgentObjectiveReference;
  readonly workspace: AgentWorkspaceBinding;
  readonly model: {
    readonly providerId: string;
    readonly modelId: string;
    readonly settingsRevision: number;
    readonly inference?: AgentModelInferenceOptions;
  };
  readonly policy: {
    readonly policyId: string;
    readonly revision: number;
    readonly permissionMode: 'ask' | 'trusted';
  };
  readonly capabilities: readonly AgentCapabilityGrant[];
  readonly toolCatalog: AgentToolCatalogBinding;
  readonly budget: AgentBudgetGrant;
}

export interface AgentRunBindingV3 extends AgentRunBindingFields {
  readonly bindingVersion: 3;
}

export interface AgentRunBindingV4 extends AgentRunBindingFields {
  readonly bindingVersion: 4;
  readonly executionProfile: AgentExecutionProfile;
}

export type AgentRunBinding = AgentRunBindingV3 | AgentRunBindingV4;

export interface AgentModelInferenceOptions {
  readonly reasoningMode?: 'off' | 'on' | 'auto' | 'pro';
  readonly reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export type AgentObjectiveReference =
  | {
      readonly kind: 'conversation_message';
      readonly messageId: string;
      readonly messageVersion: number;
      readonly contentDigest: string;
    }
  | {
      readonly kind: 'parent_delegation';
      readonly parentRunId: AgentRunId;
      readonly delegationId: string;
      readonly objectiveDigest: string;
      readonly mode: AgentSubagentMode;
      readonly providerId: string;
    };

export function assertValidAgentRunBinding(binding: AgentRunBinding): void {
  const version = (binding as { readonly bindingVersion?: unknown }).bindingVersion;
  assertPlainDataObjectWithExactKeys(
    binding,
    [
      'bindingVersion',
      ...(version === 4 ? ['executionProfile'] : []),
      'sessionId',
      'objectiveRef',
      'workspace',
      'model',
      'policy',
      'capabilities',
      'toolCatalog',
      'budget'
    ],
    'run.binding'
  );
  if (binding.bindingVersion !== 3 && binding.bindingVersion !== 4) {
    throw new AgentRunInvariantError('run.binding.bindingVersion must be 3 or 4.');
  }
  if (binding.bindingVersion === 4) {
    assertValidExecutionProfile(binding.executionProfile);
  }
  assertCanonicalPublicId(binding.sessionId, 'run.binding.sessionId');
  assertValidObjectiveReference(binding.objectiveRef);
  assertValidWorkspace(binding.workspace);
  assertValidModel(binding.model);
  assertValidPolicy(binding.policy);
  assertValidCapabilities(binding.capabilities);
  assertValidToolCatalog(binding.toolCatalog);
  assertValidBudgetGrant(binding.budget);
}

export function cloneAgentRunBinding(binding: AgentRunBinding): AgentRunBinding {
  assertValidAgentRunBinding(binding);
  const fields: AgentRunBindingFields = {
    sessionId: binding.sessionId,
    objectiveRef: cloneObjectiveReference(binding.objectiveRef),
    workspace: {
      workspaceId: binding.workspace.workspaceId,
      revision: binding.workspace.revision,
      grantDigest: binding.workspace.grantDigest,
      access: binding.workspace.access,
      scopeIds: [...binding.workspace.scopeIds]
    },
    model: { ...binding.model },
    policy: { ...binding.policy },
    capabilities: binding.capabilities.map((capability) => ({
      capabilityId: capability.capabilityId,
      scopeIds: [...capability.scopeIds]
    })),
    toolCatalog: {
      catalogId: binding.toolCatalog.catalogId,
      revision: binding.toolCatalog.revision,
      digest: binding.toolCatalog.digest,
      allowedToolNames: [...binding.toolCatalog.allowedToolNames]
    },
    budget: {
      grantId: binding.budget.grantId,
      runId: binding.budget.runId,
      vector: { ...binding.budget.vector },
      deadlineAt: binding.budget.deadlineAt,
      source: { ...binding.budget.source }
    }
  };
  return binding.bindingVersion === 3
    ? { bindingVersion: 3, ...fields }
    : {
        bindingVersion: 4,
        executionProfile: cloneAgentExecutionProfile(binding.executionProfile),
        ...fields
      };
}

export function cloneAgentExecutionProfile(
  profile: AgentExecutionProfile
): AgentExecutionProfile {
  assertValidExecutionProfile(profile);
  return {
    mode: profile.mode,
    ...(profile.subagentProviders === undefined
      ? {}
      : {
          subagentProviders: profile.subagentProviders.map((provider) => ({
            ...provider,
            supportedModes: [...provider.supportedModes]
          }))
        })
  };
}

export function agentRunExecutionMode(
  binding: AgentRunBinding
): AgentExecutionProfile['mode'] {
  assertValidAgentRunBinding(binding);
  return binding.bindingVersion === 4 ? binding.executionProfile.mode : 'agent';
}

/**
 * Proves that a child Run binding cannot expand any immutable parent grant.
 * This function is pure and performs no lookup, normalization, or persistence.
 */
export function assertAgentChildRunBindingSubset(
  parentRunId: AgentRunId,
  parent: AgentRunBinding,
  child: AgentRunBinding
): void {
  assertCanonicalPublicId(parentRunId, 'parentRunId');
  assertValidAgentRunBinding(parent);
  assertValidAgentRunBinding(child);
  if (
    agentRunExecutionMode(parent) === 'plan'
    && agentRunExecutionMode(child) !== 'plan'
  ) {
    throw subsetError('A child cannot expand its parent execution profile.');
  }
  if (
    parent.bindingVersion === 4
    && child.bindingVersion === 4
    && !sameSubagentProviderBindings(
      parent.executionProfile.subagentProviders,
      child.executionProfile.subagentProviders
    )
  ) {
    throw subsetError('A child must retain the exact SubAgent Provider Catalog snapshot.');
  }
  if (parent.budget.runId !== parentRunId) {
    throw subsetError('The parent Budget grant must belong to parentRunId.');
  }
  if (child.sessionId !== parent.sessionId) {
    throw subsetError('A child cannot change the parent session.');
  }
  if (
    child.objectiveRef.kind !== 'parent_delegation'
    || child.objectiveRef.parentRunId !== parentRunId
  ) {
    throw subsetError('A child objective must reference the exact parent Run.');
  }
  if (
    child.workspace.workspaceId !== parent.workspace.workspaceId
    || child.workspace.revision !== parent.workspace.revision
    || child.workspace.grantDigest !== parent.workspace.grantDigest
  ) {
    throw subsetError('A child must retain the exact parent workspace snapshot.');
  }
  if (parent.workspace.access === 'read' && child.workspace.access !== 'read') {
    throw subsetError('A child cannot expand workspace access.');
  }
  assertStringSubset(
    child.workspace.scopeIds,
    parent.workspace.scopeIds,
    'workspace scopes'
  );
  if (!sameModel(parent.model, child.model)) {
    throw subsetError('A child cannot change the pinned model.');
  }
  if (
    child.policy.policyId !== parent.policy.policyId
    || child.policy.revision !== parent.policy.revision
    || (
      parent.policy.permissionMode === 'ask'
      && child.policy.permissionMode !== 'ask'
    )
  ) {
    throw subsetError('A child cannot expand or replace the parent policy.');
  }
  assertCapabilitySubset(parent.capabilities, child.capabilities);
  if (
    child.toolCatalog.catalogId !== parent.toolCatalog.catalogId
    || child.toolCatalog.revision !== parent.toolCatalog.revision
    || child.toolCatalog.digest !== parent.toolCatalog.digest
  ) {
    throw subsetError('A child must retain the exact pinned Tool Catalog.');
  }
  assertStringSubset(
    child.toolCatalog.allowedToolNames,
    parent.toolCatalog.allowedToolNames,
    'allowed Tool names'
  );
  if (
    child.budget.runId === parentRunId
    || child.budget.grantId === parent.budget.grantId
    || child.budget.source.kind !== 'parent_allocation'
    || child.budget.source.parentRunId !== parentRunId
    || child.budget.source.parentGrantId !== parent.budget.grantId
    || child.budget.source.delegationId !== child.objectiveRef.delegationId
  ) {
    throw subsetError('A child Budget source must match its parent delegation.');
  }
  assertBudgetVectorSubset(parent.budget.vector, child.budget.vector);
  if (Date.parse(child.budget.deadlineAt) > Date.parse(parent.budget.deadlineAt)) {
    throw subsetError('A child deadline cannot exceed the parent deadline.');
  }
}

function assertValidObjectiveReference(reference: AgentObjectiveReference): void {
  if (!isPlainDataObject(reference)) {
    throw new AgentRunInvariantError('run.binding.objectiveRef must be a plain data object.');
  }
  if (reference.kind === 'conversation_message') {
    assertPlainDataObjectWithExactKeys(
      reference,
      ['kind', 'messageId', 'messageVersion', 'contentDigest'],
      'run.binding.objectiveRef'
    );
    assertCanonicalPublicId(
      reference.messageId,
      'run.binding.objectiveRef.messageId'
    );
    assertPositiveInteger(
      reference.messageVersion,
      'run.binding.objectiveRef.messageVersion'
    );
    assertSha256Digest(
      reference.contentDigest,
      'run.binding.objectiveRef.contentDigest'
    );
    return;
  }
  if (reference.kind === 'parent_delegation') {
    assertPlainDataObjectWithExactKeys(
      reference,
      ['kind', 'parentRunId', 'delegationId', 'objectiveDigest', 'mode', 'providerId'],
      'run.binding.objectiveRef'
    );
    assertCanonicalPublicId(
      reference.parentRunId,
      'run.binding.objectiveRef.parentRunId'
    );
    assertCanonicalPublicId(
      reference.delegationId,
      'run.binding.objectiveRef.delegationId'
    );
    assertSha256Digest(
      reference.objectiveDigest,
      'run.binding.objectiveRef.objectiveDigest'
    );
    if (reference.mode !== 'one_shot' && reference.mode !== 'continuable') {
      throw new AgentRunInvariantError('run.binding.objectiveRef.mode is invalid.');
    }
    assertCanonicalPublicId(
      reference.providerId,
      'run.binding.objectiveRef.providerId'
    );
    return;
  }
  throw new AgentRunInvariantError('run.binding.objectiveRef kind is invalid.');
}

function assertValidExecutionProfile(profile: AgentExecutionProfile): void {
  assertPlainDataObjectWithExactKeys(
    profile,
    profile.subagentProviders === undefined
      ? ['mode']
      : ['mode', 'subagentProviders'],
    'run.binding.executionProfile'
  );
  if (profile.mode !== 'chat' && profile.mode !== 'agent' && profile.mode !== 'plan') {
    throw new AgentRunInvariantError('run.binding.executionProfile.mode is invalid.');
  }
  if (profile.subagentProviders !== undefined) {
    assertDenseDataArray(
      profile.subagentProviders,
      'run.binding.executionProfile.subagentProviders'
    );
    if (profile.subagentProviders.length === 0 || profile.subagentProviders.length > 16) {
      throw new AgentRunInvariantError(
        'run.binding.executionProfile.subagentProviders has an invalid size.'
      );
    }
    let previous: string | undefined;
    profile.subagentProviders.forEach((provider, index) => {
      const field = `run.binding.executionProfile.subagentProviders[${String(index)}]`;
      assertPlainDataObjectWithExactKeys(provider, [
        'providerId',
        'displayName',
        'configurationDigest',
        'transport',
        'supportedModes',
        'supportsStructuredReport',
        'inheritsParentContext',
        'usesParentTools'
      ], field);
      assertCanonicalPublicId(provider.providerId, `${field}.providerId`);
      assertSha256Digest(provider.configurationDigest, `${field}.configurationDigest`);
      if (previous !== undefined && compareCanonicalId(previous, provider.providerId) >= 0) {
        throw new AgentRunInvariantError(
          'run.binding.executionProfile.subagentProviders must be sorted without duplicates.'
        );
      }
      previous = provider.providerId;
      if (
        provider.displayName.length === 0
        || provider.displayName.trim() !== provider.displayName
        || provider.displayName.length > 256
        || (provider.transport !== 'ordinary_run' && provider.transport !== 'external_process')
        || typeof provider.supportsStructuredReport !== 'boolean'
        || typeof provider.inheritsParentContext !== 'boolean'
        || typeof provider.usesParentTools !== 'boolean'
      ) throw new AgentRunInvariantError(`${field} has invalid metadata.`);
      assertDenseDataArray(provider.supportedModes, `${field}.supportedModes`);
      if (
        provider.supportedModes.length === 0
        || provider.supportedModes.length > 2
        || new Set(provider.supportedModes).size !== provider.supportedModes.length
        || provider.supportedModes.some(
          (mode) => mode !== 'one_shot' && mode !== 'continuable'
        )
      ) throw new AgentRunInvariantError(`${field}.supportedModes is invalid.`);
    });
  }
}

function sameSubagentProviderBindings(
  left: readonly AgentSubagentProviderBinding[] | undefined,
  right: readonly AgentSubagentProviderBinding[] | undefined
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((provider, index) => {
    const candidate = right[index];
    return candidate !== undefined
      && provider.providerId === candidate.providerId
      && provider.displayName === candidate.displayName
      && provider.configurationDigest === candidate.configurationDigest
      && provider.transport === candidate.transport
      && provider.supportsStructuredReport === candidate.supportsStructuredReport
      && provider.inheritsParentContext === candidate.inheritsParentContext
      && provider.usesParentTools === candidate.usesParentTools
      && provider.supportedModes.length === candidate.supportedModes.length
      && provider.supportedModes.every(
        (mode, modeIndex) => mode === candidate.supportedModes[modeIndex]
      );
  });
}

function assertValidWorkspace(workspace: AgentWorkspaceBinding): void {
  assertPlainDataObjectWithExactKeys(
    workspace,
    ['workspaceId', 'revision', 'grantDigest', 'access', 'scopeIds'],
    'run.binding.workspace'
  );
  assertCanonicalPublicId(workspace.workspaceId, 'run.binding.workspace.workspaceId');
  assertPositiveInteger(workspace.revision, 'run.binding.workspace.revision');
  assertSha256Digest(workspace.grantDigest, 'run.binding.workspace.grantDigest');
  if (workspace.access !== 'read' && workspace.access !== 'write') {
    throw new AgentRunInvariantError('run.binding.workspace.access is invalid.');
  }
  assertCanonicalSortedIds(workspace.scopeIds, 'run.binding.workspace.scopeIds');
}

function assertValidModel(model: AgentRunBinding['model']): void {
  assertPlainDataObjectWithExactKeys(
    model,
    model.inference === undefined
      ? ['providerId', 'modelId', 'settingsRevision']
      : ['providerId', 'modelId', 'settingsRevision', 'inference'],
    'run.binding.model'
  );
  assertCanonicalPublicId(model.providerId, 'run.binding.model.providerId');
  assertCanonicalPublicId(model.modelId, 'run.binding.model.modelId');
  assertPositiveInteger(model.settingsRevision, 'run.binding.model.settingsRevision');
  if (model.inference !== undefined) assertValidInference(model.inference);
}

function assertValidInference(inference: AgentModelInferenceOptions): void {
  const reasoningMode = inference.reasoningMode;
  const reasoningEffort = inference.reasoningEffort;
  const keys = [
    ...(reasoningMode === undefined ? [] : ['reasoningMode']),
    ...(reasoningEffort === undefined ? [] : ['reasoningEffort'])
  ];
  assertPlainDataObjectWithExactKeys(inference, keys, 'run.binding.model.inference');
  if (
    reasoningMode !== undefined
    && !['off', 'on', 'auto', 'pro'].includes(reasoningMode)
  ) {
    throw new AgentRunInvariantError('run.binding.model.inference.reasoningMode is invalid.');
  }
  if (
    reasoningEffort !== undefined
    && !['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(
      reasoningEffort
    )
  ) {
    throw new AgentRunInvariantError('run.binding.model.inference.reasoningEffort is invalid.');
  }
}

function assertValidPolicy(policy: AgentRunBinding['policy']): void {
  assertPlainDataObjectWithExactKeys(
    policy,
    ['policyId', 'revision', 'permissionMode'],
    'run.binding.policy'
  );
  assertCanonicalPublicId(policy.policyId, 'run.binding.policy.policyId');
  assertPositiveInteger(policy.revision, 'run.binding.policy.revision');
  if (policy.permissionMode !== 'ask' && policy.permissionMode !== 'trusted') {
    throw new AgentRunInvariantError('run.binding.policy.permissionMode is invalid.');
  }
}

function assertValidCapabilities(capabilities: readonly AgentCapabilityGrant[]): void {
  assertDenseDataArray(capabilities, 'run.binding.capabilities');
  let previous: string | undefined;
  capabilities.forEach((capability, index) => {
    const path = `run.binding.capabilities[${String(index)}]`;
    assertPlainDataObjectWithExactKeys(
      capability,
      ['capabilityId', 'scopeIds'],
      path
    );
    assertCanonicalPublicId(capability.capabilityId, `${path}.capabilityId`);
    if (previous !== undefined && compareCanonicalId(previous, capability.capabilityId) >= 0) {
      throw new AgentRunInvariantError(
        'run.binding.capabilities must be strictly sorted by capabilityId without duplicates.'
      );
    }
    previous = capability.capabilityId;
    assertCanonicalSortedIds(capability.scopeIds, `${path}.scopeIds`);
  });
}

function assertValidToolCatalog(toolCatalog: AgentToolCatalogBinding): void {
  assertPlainDataObjectWithExactKeys(
    toolCatalog,
    ['catalogId', 'revision', 'digest', 'allowedToolNames'],
    'run.binding.toolCatalog'
  );
  assertCanonicalPublicId(toolCatalog.catalogId, 'run.binding.toolCatalog.catalogId');
  assertPositiveInteger(toolCatalog.revision, 'run.binding.toolCatalog.revision');
  assertSha256Digest(toolCatalog.digest, 'run.binding.toolCatalog.digest');
  assertCanonicalSortedIds(
    toolCatalog.allowedToolNames,
    'run.binding.toolCatalog.allowedToolNames'
  );
}

function assertValidBudgetGrant(budget: AgentBudgetGrant): void {
  assertPlainDataObjectWithExactKeys(
    budget,
    ['grantId', 'runId', 'vector', 'deadlineAt', 'source'],
    'run.binding.budget'
  );
  assertCanonicalPublicId(budget.grantId, 'run.binding.budget.grantId');
  assertCanonicalPublicId(budget.runId, 'run.binding.budget.runId');
  assertValidBudgetVector(budget.vector);
  assertTimestamp(budget.deadlineAt, 'run.binding.budget.deadlineAt');
  assertValidBudgetSource(budget.source);
}

function assertValidBudgetVector(vector: AgentBudgetVector): void {
  assertPlainDataObjectWithExactKeys(
    vector,
    [
      'modelTurns',
      'toolCalls',
      'readCalls',
      'writeCalls',
      'shellCalls',
      'costMicrousd'
    ],
    'run.binding.budget.vector'
  );
  for (const key of BUDGET_VECTOR_KEYS) {
    assertNonNegativeInteger(vector[key], `run.binding.budget.vector.${key}`);
  }
}

function assertValidBudgetSource(source: AgentBudgetGrantSource): void {
  if (!isPlainDataObject(source)) {
    throw new AgentRunInvariantError('run.binding.budget.source must be a plain data object.');
  }
  if (source.kind === 'root') {
    assertPlainDataObjectWithExactKeys(source, ['kind'], 'run.binding.budget.source');
    return;
  }
  if (source.kind === 'parent_allocation') {
    assertPlainDataObjectWithExactKeys(
      source,
      ['kind', 'parentRunId', 'parentGrantId', 'delegationId'],
      'run.binding.budget.source'
    );
    assertCanonicalPublicId(source.parentRunId, 'run.binding.budget.source.parentRunId');
    assertCanonicalPublicId(source.parentGrantId, 'run.binding.budget.source.parentGrantId');
    assertCanonicalPublicId(source.delegationId, 'run.binding.budget.source.delegationId');
    return;
  }
  throw new AgentRunInvariantError('run.binding.budget.source.kind is invalid.');
}

function assertCanonicalSortedIds(values: readonly string[], field: string): void {
  assertDenseDataArray(values, field);
  let previous: string | undefined;
  for (const value of values) {
    assertCanonicalPublicId(value, field);
    if (previous !== undefined && compareCanonicalId(previous, value) >= 0) {
      throw new AgentRunInvariantError(
        `${field} must be strictly sorted without duplicates.`
      );
    }
    previous = value;
  }
}

function assertDenseDataArray(value: unknown, field: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new AgentRunInvariantError(`${field} must be an array.`);
  }
  const ownKeys = Reflect.ownKeys(value);
  const expected = new Set<string>(['length']);
  for (let index = 0; index < value.length; index += 1) expected.add(String(index));
  if (
    ownKeys.length !== expected.size
    || ownKeys.some((key) => typeof key === 'symbol' || !expected.has(key))
  ) {
    throw new AgentRunInvariantError(`${field} must be a dense data-only array.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !('value' in descriptor)
    ) {
      throw new AgentRunInvariantError(`${field} must be a dense data-only array.`);
    }
  }
}

function assertPlainDataObjectWithExactKeys(
  value: unknown,
  keys: readonly string[],
  field: string
): asserts value is Record<string, unknown> {
  if (!isPlainDataObject(value)) {
    throw new AgentRunInvariantError(`${field} must be a plain data object.`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === 'symbol')) {
    throw new AgentRunInvariantError(`${field} must not contain symbol fields.`);
  }
  const actual = ownKeys as string[];
  const allowed = new Set(keys);
  const unexpected = actual.find((key) => !allowed.has(key));
  const missing = keys.find((key) => !actual.includes(key));
  if (unexpected !== undefined) {
    throw new AgentRunInvariantError(
      `${field} contains unsupported field "${unexpected}".`
    );
  }
  if (missing !== undefined) {
    throw new AgentRunInvariantError(`${field} is missing required field "${missing}".`);
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !('value' in descriptor)
    ) {
      throw new AgentRunInvariantError(`${field}.${key} must be an enumerable data field.`);
    }
  }
}

function isPlainDataObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneObjectiveReference(reference: AgentObjectiveReference): AgentObjectiveReference {
  return reference.kind === 'conversation_message'
    ? {
        kind: 'conversation_message',
        messageId: reference.messageId,
        messageVersion: reference.messageVersion,
        contentDigest: reference.contentDigest
      }
    : {
        kind: 'parent_delegation',
        parentRunId: reference.parentRunId,
        delegationId: reference.delegationId,
        objectiveDigest: reference.objectiveDigest,
        mode: reference.mode,
        providerId: reference.providerId
      };
}

function compareCanonicalId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertStringSubset(
  child: readonly string[],
  parent: readonly string[],
  field: string
): void {
  if (child.some((value) => !parent.includes(value))) {
    throw subsetError(`A child cannot expand ${field}.`);
  }
}

function assertCapabilitySubset(
  parent: readonly AgentCapabilityGrant[],
  child: readonly AgentCapabilityGrant[]
): void {
  const parentById = new Map(
    parent.map((capability) => [capability.capabilityId, capability] as const)
  );
  for (const capability of child) {
    const parentCapability = parentById.get(capability.capabilityId);
    if (
      parentCapability === undefined
      || capability.scopeIds.some((scopeId) => !parentCapability.scopeIds.includes(scopeId))
    ) {
      throw subsetError('A child cannot expand capability grants or scopes.');
    }
  }
}

function assertBudgetVectorSubset(
  parent: AgentBudgetVector,
  child: AgentBudgetVector
): void {
  if (BUDGET_VECTOR_KEYS.some((key) => child[key] > parent[key])) {
    throw subsetError('A child cannot expand its parent Budget vector.');
  }
}

function sameModel(
  left: AgentRunBinding['model'],
  right: AgentRunBinding['model']
): boolean {
  return left.providerId === right.providerId
    && left.modelId === right.modelId
    && left.settingsRevision === right.settingsRevision
    && left.inference?.reasoningMode === right.inference?.reasoningMode
    && left.inference?.reasoningEffort === right.inference?.reasoningEffort;
}

function subsetError(message: string): AgentRunInvariantError {
  return new AgentRunInvariantError(message);
}

const BUDGET_VECTOR_KEYS = [
  'modelTurns',
  'toolCalls',
  'readCalls',
  'writeCalls',
  'shellCalls',
  'costMicrousd'
] as const;
