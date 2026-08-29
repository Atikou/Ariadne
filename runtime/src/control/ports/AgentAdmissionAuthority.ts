import {
  AgentRunInvariantError,
  assertCanonicalPublicId,
  assertCanonicalSortedPublicIds,
  assertPositiveInteger,
  assertSha256Digest,
  assertValidAgentRunBinding,
  type AgentAvailableTool,
  type AgentBudgetVector,
  type AgentCapabilityGrant,
  type AgentExecutionProfile,
  type AgentRunBinding
} from '@ariadne/agent-core';
import type { ConversationMessageExecutionV3 } from '@ariadne/protocol/public';

const trustedAuthorityBundles = new WeakSet<object>();

export interface AgentAdmissionAuthoritySubjectV2 {
  readonly subjectVersion: 2;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly objectiveMessageId: string;
  readonly objectiveMessageVersion: number;
  readonly objectiveDigest: string;
  readonly runId: string;
  readonly executionProfile: AgentExecutionProfile;
}

export interface AgentAdmissionAuthorityBundleV2 {
  readonly authorityBundleVersion: 2;
  readonly bundleId: string;
  readonly revision: number;
  readonly subject: AgentAdmissionAuthoritySubjectV2;
  readonly workspace: {
    readonly workspaceId: string;
    readonly revision: number;
    readonly grantDigest: string;
    readonly access: 'read' | 'write';
    readonly scopeIds: readonly string[];
  };
  readonly model: {
    readonly providerId: string;
    readonly modelId: string;
    readonly settingsRevision: number;
    readonly inference?: AgentRunBinding['model']['inference'];
  };
  readonly policy: {
    readonly policyId: string;
    readonly revision: number;
    readonly permissionMode: 'ask' | 'trusted';
  };
  readonly capabilityGrant: {
    readonly grantId: string;
    readonly revision: number;
    readonly capabilities: readonly AgentCapabilityGrant[];
  };
  readonly toolCatalog: {
    readonly catalogId: string;
    readonly revision: number;
    readonly digest: string;
    readonly allowedToolNames: readonly string[];
  };
  readonly rootBudget: {
    readonly authorityId: string;
    readonly revision: number;
    readonly grantId: string;
    readonly runId: string;
    readonly vector: AgentBudgetVector;
    readonly deadlineAt: string;
  };
}

export type AgentAdmissionAuthorityBundle = AgentAdmissionAuthorityBundleV2;

export interface AgentAdmissionAuthorityQueryV2 {
  readonly queryVersion: 2;
  readonly subjectVersion: 2;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly objectiveMessageId: string;
  readonly objectiveMessageVersion: number;
  readonly objectiveDigest: string;
  readonly runId: string;
  readonly requiresVision?: true;
  readonly execution: ConversationMessageExecutionV3;
}

/** One exact immutable authority lookup; no mutable settings fallback exists. */
export interface AgentAdmissionAuthorityBundleProvider {
  readAuthorityBundle(
    query: AgentAdmissionAuthorityQueryV2,
    signal: AbortSignal
  ): Promise<AgentAdmissionAuthorityBundle | null>;
}

export interface AgentAdmissionToolCatalogReferenceV1 {
  readonly referenceVersion: 1;
  readonly catalogId: string;
  readonly revision: number;
  readonly digest: string;
}

/**
 * Narrow executable catalog view used at admission. Implemented by
 * ImmutableAgentToolCatalog without exposing catalog compilation internals.
 */
export interface AgentAdmissionToolCatalog {
  resolveAdmissionTools(binding: AgentRunBinding): readonly AgentAvailableTool[];
}

export interface AgentAdmissionToolCatalogProvider {
  readToolCatalog(
    reference: AgentAdmissionToolCatalogReferenceV1,
    signal: AbortSignal
  ): Promise<AgentAdmissionToolCatalog | null>;
}

/**
 * Validates, snapshots, and deeply freezes an authority bundle. Providers must
 * return values created here; copied, mutable, accessor-backed, or partial
 * objects are rejected by the production reader.
 */
export function createAgentAdmissionAuthorityBundle(
  input: AgentAdmissionAuthorityBundleV2
): AgentAdmissionAuthorityBundle {
  assertBundleShape(input);
  const bundle: AgentAdmissionAuthorityBundle = Object.freeze({
    authorityBundleVersion: 2,
    bundleId: input.bundleId,
    revision: input.revision,
    subject: Object.freeze({
      ...input.subject,
      executionProfile: Object.freeze({ ...input.subject.executionProfile })
    }),
    workspace: Object.freeze({
      ...input.workspace,
      scopeIds: Object.freeze([...input.workspace.scopeIds])
    }),
    model: Object.freeze({ ...input.model }),
    policy: Object.freeze({ ...input.policy }),
    capabilityGrant: Object.freeze({
      grantId: input.capabilityGrant.grantId,
      revision: input.capabilityGrant.revision,
      capabilities: Object.freeze(input.capabilityGrant.capabilities.map((grant) => (
        Object.freeze({
          capabilityId: grant.capabilityId,
          scopeIds: Object.freeze([...grant.scopeIds])
        })
      )))
    }),
    toolCatalog: Object.freeze({
      ...input.toolCatalog,
      allowedToolNames: Object.freeze([...input.toolCatalog.allowedToolNames])
    }),
    rootBudget: Object.freeze({
      ...input.rootBudget,
      vector: Object.freeze({ ...input.rootBudget.vector })
    })
  });
  trustedAuthorityBundles.add(bundle);
  return bundle;
}

export function assertAgentAdmissionAuthorityBundle(
  value: unknown
): asserts value is AgentAdmissionAuthorityBundle {
  if (
    typeof value !== 'object'
    || value === null
    || !trustedAuthorityBundles.has(value)
  ) {
    throw new AgentRunInvariantError(
      'Agent admission requires a validated immutable authority bundle.'
    );
  }
}

function assertBundleShape(input: AgentAdmissionAuthorityBundleV2): void {
  assertExactDataObject(input, [
    'authorityBundleVersion',
    'bundleId',
    'revision',
    'subject',
    'workspace',
    'model',
    'policy',
    'capabilityGrant',
    'toolCatalog',
    'rootBudget'
  ], 'authorityBundle');
  if (input.authorityBundleVersion !== 2) {
    throw invariant('authorityBundle.authorityBundleVersion must be 2.');
  }
  assertCanonicalPublicId(input.bundleId, 'authorityBundle.bundleId');
  assertPositiveInteger(input.revision, 'authorityBundle.revision');

  assertExactDataObject(input.subject, [
    'subjectVersion',
    'sessionId',
    'workspaceId',
    'objectiveMessageId',
    'objectiveMessageVersion',
    'objectiveDigest',
    'runId',
    'executionProfile'
  ], 'authorityBundle.subject');
  if (input.subject.subjectVersion !== 2) {
    throw invariant('authorityBundle.subject.subjectVersion must be 2.');
  }
  assertCanonicalPublicId(input.subject.sessionId, 'authorityBundle.subject.sessionId');
  assertCanonicalPublicId(
    input.subject.workspaceId,
    'authorityBundle.subject.workspaceId'
  );
  assertCanonicalPublicId(
    input.subject.objectiveMessageId,
    'authorityBundle.subject.objectiveMessageId'
  );
  assertPositiveInteger(
    input.subject.objectiveMessageVersion,
    'authorityBundle.subject.objectiveMessageVersion'
  );
  assertSha256Digest(
    input.subject.objectiveDigest,
    'authorityBundle.subject.objectiveDigest'
  );
  assertCanonicalPublicId(input.subject.runId, 'authorityBundle.subject.runId');
  assertExactDataObject(
    input.subject.executionProfile,
    ['mode'],
    'authorityBundle.subject.executionProfile'
  );
  if (
    input.subject.executionProfile.mode !== 'chat'
    && input.subject.executionProfile.mode !== 'agent'
    && input.subject.executionProfile.mode !== 'plan'
  ) {
    throw invariant('authorityBundle.subject.executionProfile.mode is invalid.');
  }

  assertExactDataObject(input.workspace, [
    'workspaceId', 'revision', 'grantDigest', 'access', 'scopeIds'
  ], 'authorityBundle.workspace');
  assertNonEmptyCanonicalIds(input.workspace.scopeIds, 'authorityBundle.workspace.scopeIds');

  assertExactDataObject(input.model, [
    'providerId', 'modelId', 'settingsRevision',
    ...(input.model.inference === undefined ? [] : ['inference'])
  ], 'authorityBundle.model');
  assertExactDataObject(input.policy, [
    'policyId', 'revision', 'permissionMode'
  ], 'authorityBundle.policy');
  assertExactDataObject(input.capabilityGrant, [
    'grantId', 'revision', 'capabilities'
  ], 'authorityBundle.capabilityGrant');
  assertCanonicalPublicId(
    input.capabilityGrant.grantId,
    'authorityBundle.capabilityGrant.grantId'
  );
  assertPositiveInteger(
    input.capabilityGrant.revision,
    'authorityBundle.capabilityGrant.revision'
  );
  assertDenseDataArray(
    input.capabilityGrant.capabilities,
    'authorityBundle.capabilityGrant.capabilities'
  );
  if (input.capabilityGrant.capabilities.length === 0) {
    throw invariant('authorityBundle.capabilityGrant.capabilities cannot be empty.');
  }
  input.capabilityGrant.capabilities.forEach((grant, index) => {
    const field = `authorityBundle.capabilityGrant.capabilities[${String(index)}]`;
    assertExactDataObject(grant, ['capabilityId', 'scopeIds'], field);
    assertNonEmptyCanonicalIds(grant.scopeIds, `${field}.scopeIds`);
  });

  assertExactDataObject(input.toolCatalog, [
    'catalogId', 'revision', 'digest', 'allowedToolNames'
  ], 'authorityBundle.toolCatalog');
  assertNonEmptyCanonicalIds(
    input.toolCatalog.allowedToolNames,
    'authorityBundle.toolCatalog.allowedToolNames'
  );

  assertExactDataObject(input.rootBudget, [
    'authorityId', 'revision', 'grantId', 'runId', 'vector', 'deadlineAt'
  ], 'authorityBundle.rootBudget');
  assertCanonicalPublicId(
    input.rootBudget.authorityId,
    'authorityBundle.rootBudget.authorityId'
  );
  assertPositiveInteger(input.rootBudget.revision, 'authorityBundle.rootBudget.revision');

  const binding = bundleAsBinding(input);
  assertValidAgentRunBinding(binding);
  if (
    input.workspace.workspaceId !== input.subject.workspaceId
    || input.rootBudget.runId !== input.subject.runId
  ) {
    throw invariant('Agent admission authority subject bindings do not match.');
  }
  const workspaceScopes = new Set(input.workspace.scopeIds);
  if (input.capabilityGrant.capabilities.some((grant) => (
    grant.scopeIds.some((scopeId) => !workspaceScopes.has(scopeId))
  ))) {
    throw invariant('Capability scopes must be contained by the Workspace authority.');
  }
}

function bundleAsBinding(input: AgentAdmissionAuthorityBundleV2): AgentRunBinding {
  return {
    bindingVersion: 4,
    executionProfile: { ...input.subject.executionProfile },
    sessionId: input.subject.sessionId,
    objectiveRef: {
      kind: 'conversation_message',
      messageId: input.subject.objectiveMessageId,
      messageVersion: input.subject.objectiveMessageVersion,
      contentDigest: input.subject.objectiveDigest
    },
    workspace: input.workspace,
    model: input.model,
    policy: input.policy,
    capabilities: input.capabilityGrant.capabilities,
    toolCatalog: input.toolCatalog,
    budget: {
      grantId: input.rootBudget.grantId,
      runId: input.rootBudget.runId,
      vector: input.rootBudget.vector,
      deadlineAt: input.rootBudget.deadlineAt,
      source: { kind: 'root' }
    }
  };
}

function assertNonEmptyCanonicalIds(values: readonly string[], field: string): void {
  assertDenseDataArray(values, field);
  assertCanonicalSortedPublicIds(values, field);
  if (values.length === 0) throw invariant(`${field} cannot be empty.`);
}

function assertExactDataObject(
  value: unknown,
  expectedKeys: readonly string[],
  field: string
): asserts value is Record<string, unknown> {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)
  ) throw invariant(`${field} must be a plain data object.`);
  const actualKeys = Reflect.ownKeys(value);
  const expected = new Set(expectedKeys);
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key) => typeof key !== 'string' || !expected.has(key))
    || expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
    || actualKeys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor === undefined
        || !descriptor.enumerable
        || descriptor.get !== undefined
        || descriptor.set !== undefined;
    })
  ) throw invariant(`${field} has an unexpected or executable shape.`);
}

function assertDenseDataArray(value: unknown, field: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw invariant(`${field} must be an array.`);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== value.length + 1
    || keys[value.length] !== 'length'
    || keys.slice(0, -1).some((key, index) => {
      if (key !== String(index)) return true;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor === undefined
        || !descriptor.enumerable
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        || descriptor.get !== undefined
        || descriptor.set !== undefined;
    })
  ) throw invariant(`${field} must be a dense data-only array.`);
}

function invariant(message: string): AgentRunInvariantError {
  return new AgentRunInvariantError(message);
}
