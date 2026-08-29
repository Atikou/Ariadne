import { createHash } from 'node:crypto';

import {
  AgentRunInvariantError,
  assertCanonicalPublicId,
  assertCanonicalSortedPublicIds,
  assertPositiveInteger,
  assertSha256Digest,
  cloneCanonicalAgentToolInput,
  type AgentPinnedToolIdentity,
  type AgentToolJsonValue
} from '@ariadne/agent-core';

import type {
  AgentToolCatalogSnapshot,
  AgentToolCatalogSnapshotEntry,
  AgentToolContractDocumentV2,
  AgentToolExecutableImplementationV1
} from '../../control/ports/AgentToolExecution.js';

const MAX_CATALOG_TOOLS = 1_000;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_TOOL_TIMEOUT_MS = 3_600_000;

const trustedSnapshots = new WeakSet<object>();

export interface TrustedAgentToolCatalogCompilationInput {
  readonly catalogId: string;
  readonly revision: number;
  readonly tools: readonly TrustedAgentToolRegistrationV1[];
}

export interface TrustedAgentToolRegistrationV1 {
  readonly document: AgentToolContractDocumentV2;
  readonly executable: AgentToolExecutableImplementationV1;
}

export type TrustedAgentToolCatalogSnapshotEntry = AgentToolCatalogSnapshotEntry;
export type TrustedAgentToolCatalogSnapshot = AgentToolCatalogSnapshot;

/**
 * The sole authority that turns contract documents and implementation
 * artifacts into final Tool pins. No digest or pinned identity is accepted as
 * compilation input.
 */
export function compileTrustedAgentToolCatalog(
  input: TrustedAgentToolCatalogCompilationInput
): TrustedAgentToolCatalogSnapshot {
  assertExactDataObject(input, ['catalogId', 'revision', 'tools'], 'catalog');
  assertCanonicalPublicId(input.catalogId, 'catalog.catalogId');
  assertPositiveInteger(input.revision, 'catalog.revision');
  assertDenseArray(input.tools, 'catalog.tools');
  if (input.tools.length === 0 || input.tools.length > MAX_CATALOG_TOOLS) {
    throw new AgentRunInvariantError(
      'A trusted Agent Tool Catalog must contain between 1 and 1000 Tools.'
    );
  }

  const prepared = input.tools.map((registration, index) =>
    prepareRegistration(registration, `catalog.tools[${String(index)}]`)
  ).sort((left, right) => compareCodeUnits(
    left.document.toolName,
    right.document.toolName
  ));
  for (let index = 1; index < prepared.length; index += 1) {
    if (prepared[index - 1]?.document.toolName === prepared[index]?.document.toolName) {
      throw new AgentRunInvariantError(
        'A trusted Agent Tool Catalog cannot contain duplicate toolName values.'
      );
    }
  }

  const catalogDigest = digestCanonical(
    'ariadne-agent-tool-catalog-v1',
    {
      catalogId: input.catalogId,
      revision: input.revision,
      tools: prepared.map((entry) => ({
        toolName: entry.document.toolName,
        toolVersion: entry.document.toolVersion,
        providerId: entry.document.providerId,
        capabilityIds: [...entry.document.capabilityIds],
        contractDigest: entry.contractDigest
      }))
    }
  );
  const entries = prepared.map((entry) => {
    const tool = Object.freeze<AgentPinnedToolIdentity>({
      catalogId: input.catalogId,
      revision: input.revision,
      digest: catalogDigest,
      toolName: entry.document.toolName,
      toolVersion: entry.document.toolVersion,
      providerId: entry.document.providerId,
      contractDigest: entry.contractDigest
    });
    return Object.freeze<TrustedAgentToolCatalogSnapshotEntry>({
      document: entry.document,
      tool,
      executable: entry.executable
    });
  });
  const snapshot = Object.freeze<TrustedAgentToolCatalogSnapshot>({
    catalogId: input.catalogId,
    revision: input.revision,
    catalogDigest,
    entries: Object.freeze(entries)
  });
  trustedSnapshots.add(snapshot);
  return snapshot;
}

export function assertTrustedAgentToolCatalogSnapshot(
  value: unknown
): asserts value is TrustedAgentToolCatalogSnapshot {
  if (
    typeof value !== 'object'
    || value === null
    || !trustedSnapshots.has(value)
  ) {
    throw new AgentRunInvariantError(
      'Tool Catalog construction requires a compiler-verified trusted snapshot.'
    );
  }
}

interface PreparedRegistration {
  readonly document: AgentToolContractDocumentV2;
  readonly contractDigest: string;
  readonly executable: TrustedAgentToolCatalogSnapshotEntry['executable'];
}

function prepareRegistration(
  registration: TrustedAgentToolRegistrationV1,
  field: string
): PreparedRegistration {
  assertExactDataObject(registration, ['document', 'executable'], field);
  const document = cloneAndValidateDocument(registration.document, `${field}.document`);
  const executable = snapshotAndVerifyExecutable(
    registration.executable,
    document,
    `${field}.executable`
  );
  return {
    document,
    contractDigest: digestCanonical(
      'ariadne-agent-tool-contract-v2',
      document as unknown as AgentToolJsonValue
    ),
    executable
  };
}

function cloneAndValidateDocument(
  input: AgentToolContractDocumentV2,
  field: string
): AgentToolContractDocumentV2 {
  const canonical = cloneCanonicalAgentToolInput(input, field);
  assertRecord(canonical, field);
  assertExactKeys(canonical, [
    'documentVersion',
    'toolName',
    'toolVersion',
    'providerId',
    'model',
    'presentation',
    'inputSchema',
    'outputSchema',
    'capabilityIds',
    'requiredWorkspaceAccess',
    'permission',
    'scopeSemantics',
    'resourceSemantics',
    'lifecycleSemantics',
    'sideEffect',
    'idempotency',
    'recovery',
    'timeoutMs',
    'implementationArtifacts'
  ], field);
  if (canonical.documentVersion !== 2) {
    throw new AgentRunInvariantError(`${field}.documentVersion must be 2.`);
  }
  assertCanonicalPublicId(asString(canonical.toolName), `${field}.toolName`);
  assertCanonicalPublicId(asString(canonical.toolVersion), `${field}.toolVersion`);
  assertCanonicalPublicId(asString(canonical.providerId), `${field}.providerId`);
  assertRecord(canonical.model, `${field}.model`);
  assertExactKeys(canonical.model, ['description', 'guidance'], `${field}.model`);
  assertBoundedText(canonical.model.description, 2_048, `${field}.model.description`);
  assertDenseArray(canonical.model.guidance, `${field}.model.guidance`);
  if (canonical.model.guidance.length > 8) {
    throw new AgentRunInvariantError(`${field}.model.guidance exceeds 8 entries.`);
  }
  canonical.model.guidance.forEach((entry, index) => {
    assertBoundedText(entry, 512, `${field}.model.guidance[${String(index)}]`);
  });
  assertRecord(canonical.presentation, `${field}.presentation`);
  assertExactKeys(
    canonical.presentation,
    ['kind', 'label', 'resultVisibility'],
    `${field}.presentation`
  );
  assertOneOf(canonical.presentation.kind, [
    'generic',
    'file_read',
    'file_search',
    'file_change',
    'command',
    'terminal',
    'browser',
    'skill',
    'external'
  ], `${field}.presentation.kind`);
  assertBoundedText(canonical.presentation.label, 128, `${field}.presentation.label`);
  if (canonical.presentation.resultVisibility !== 'protected') {
    throw new AgentRunInvariantError(
      `${field}.presentation.resultVisibility must be protected.`
    );
  }
  assertCanonicalSortedPublicIds(canonical.capabilityIds, `${field}.capabilityIds`);
  if (canonical.capabilityIds.length > 100) {
    throw new AgentRunInvariantError(`${field}.capabilityIds exceeds 100 entries.`);
  }
  assertOneOf(
    canonical.requiredWorkspaceAccess,
    ['read', 'write'],
    `${field}.requiredWorkspaceAccess`
  );
  assertRecord(canonical.permission, `${field}.permission`);
  assertExactKeys(
    canonical.permission,
    ['authority', 'approval'],
    `${field}.permission`
  );
  if (canonical.permission.authority !== 'run_grant') {
    throw new AgentRunInvariantError(
      `${field}.permission.authority must be run_grant.`
    );
  }
  assertOneOf(
    canonical.permission.approval,
    ['never', 'required'],
    `${field}.permission.approval`
  );
  assertOneOf(canonical.scopeSemantics, [
    'none',
    'all_requested_workspace_scopes_must_be_granted'
  ], `${field}.scopeSemantics`);
  assertOneOf(canonical.resourceSemantics, [
    'none',
    'workspace_relative_path',
    'workspace_resource_id',
    'external_resource_id'
  ], `${field}.resourceSemantics`);
  assertOneOf(canonical.lifecycleSemantics, [
    'bounded_invocation',
    'resource_create',
    'resource_observe',
    'resource_mutate',
    'resource_close'
  ], `${field}.lifecycleSemantics`);
  assertOneOf(
    canonical.sideEffect,
    ['none', 'read', 'write', 'external'],
    `${field}.sideEffect`
  );
  assertOneOf(
    canonical.idempotency,
    ['not_idempotent', 'idempotency_key_required'],
    `${field}.idempotency`
  );
  assertOneOf(canonical.recovery, [
    'none',
    'retry_same_idempotency_key',
    'reconcile_before_retry'
  ], `${field}.recovery`);
  if (
    !Number.isSafeInteger(canonical.timeoutMs)
    || (canonical.timeoutMs as number) < 1
    || (canonical.timeoutMs as number) > MAX_TOOL_TIMEOUT_MS
  ) {
    throw new AgentRunInvariantError(
      `${field}.timeoutMs must be between 1 and ${String(MAX_TOOL_TIMEOUT_MS)}.`
    );
  }
  assertRecord(canonical.implementationArtifacts, `${field}.implementationArtifacts`);
  assertExactKeys(canonical.implementationArtifacts, [
    'providerDigest',
    'normalizerDigest',
    'preparedValidatorDigest',
    'executeDigest'
  ], `${field}.implementationArtifacts`);
  for (const name of [
    'providerDigest',
    'normalizerDigest',
    'preparedValidatorDigest',
    'executeDigest'
  ] as const) {
    assertSha256Digest(
      asString(canonical.implementationArtifacts[name]),
      `${field}.implementationArtifacts.${name}`
    );
  }
  return deepFreezeJson(canonical) as unknown as AgentToolContractDocumentV2;
}

function snapshotAndVerifyExecutable(
  input: AgentToolExecutableImplementationV1,
  document: AgentToolContractDocumentV2,
  field: string
): TrustedAgentToolCatalogSnapshotEntry['executable'] {
  assertExactDataObject(input, [
    'artifacts',
    'normalizeAndValidate',
    'validatePrepared',
    'execute'
  ], field);
  assertExactDataObject(input.artifacts, [
    'provider',
    'normalizer',
    'preparedValidator',
    'execute'
  ], `${field}.artifacts`);
  if (
    typeof input.normalizeAndValidate !== 'function'
    || typeof input.validatePrepared !== 'function'
    || typeof input.execute !== 'function'
  ) {
    throw new AgentRunInvariantError(`${field} must contain all executable callbacks.`);
  }
  const actual = {
    providerDigest: digestArtifact(input.artifacts.provider, `${field}.artifacts.provider`),
    normalizerDigest: digestArtifact(
      input.artifacts.normalizer,
      `${field}.artifacts.normalizer`
    ),
    preparedValidatorDigest: digestArtifact(
      input.artifacts.preparedValidator,
      `${field}.artifacts.preparedValidator`
    ),
    executeDigest: digestArtifact(input.artifacts.execute, `${field}.artifacts.execute`)
  };
  for (const name of Object.keys(actual) as (keyof typeof actual)[]) {
    if (actual[name] !== document.implementationArtifacts[name]) {
      throw new AgentRunInvariantError(
        `${field} ${name} does not match the contract document artifact.`
      );
    }
  }
  return Object.freeze({
    normalizeAndValidate: input.normalizeAndValidate,
    validatePrepared: input.validatePrepared,
    execute: input.execute
  });
}

function digestArtifact(value: Uint8Array, field: string): string {
  if (
    !(value instanceof Uint8Array)
    || !(value.buffer instanceof ArrayBuffer)
    || value.byteLength < 1
    || value.byteLength > MAX_ARTIFACT_BYTES
  ) {
    throw new AgentRunInvariantError(
      `${field} must be 1 to ${String(MAX_ARTIFACT_BYTES)} verified artifact bytes.`
    );
  }
  const owned = new Uint8Array(value.byteLength);
  owned.set(value);
  return `sha256:${createHash('sha256').update(owned).digest('hex')}`;
}

function digestCanonical(domain: string, value: AgentToolJsonValue): string {
  const canonical = canonicalizeJson(value);
  return `sha256:${createHash('sha256')
    .update(`${domain}\u0000${canonical}`, 'utf8')
    .digest('hex')}`;
}

function canonicalizeJson(value: AgentToolJsonValue): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(',')}]`;
  const record = value as Readonly<Record<string, AgentToolJsonValue>>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalizeJson(record[key] as AgentToolJsonValue)}`
  ).join(',')}}`;
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

function assertExactDataObject(
  value: unknown,
  keys: readonly string[],
  field: string
): asserts value is Record<string, unknown> {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)
  ) {
    throw new AgentRunInvariantError(`${field} must be a plain data object.`);
  }
  assertExactKeys(value as Record<string, unknown>, keys, field);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      throw new AgentRunInvariantError(`${field} must not contain symbol fields.`);
    }
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

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  field: string
): void {
  const actual = Reflect.ownKeys(value);
  const expected = new Set(keys);
  if (
    actual.length !== expected.size
    || actual.some((key) => typeof key !== 'string' || !expected.has(key))
  ) {
    throw new AgentRunInvariantError(`${field} must contain only exact contract fields.`);
  }
}

function assertDenseArray(value: unknown, field: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new AgentRunInvariantError(`${field} must be an array.`);
  }
  const expected = new Set<string>(['length']);
  for (let index = 0; index < value.length; index += 1) expected.add(String(index));
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== expected.size
    || ownKeys.some((key) => typeof key !== 'string' || !expected.has(key))
  ) {
    throw new AgentRunInvariantError(`${field} must be a dense data-only array.`);
  }
}

function assertRecord(
  value: AgentToolJsonValue | undefined,
  field: string
): asserts value is { readonly [key: string]: AgentToolJsonValue } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AgentRunInvariantError(`${field} must be a JSON object.`);
  }
}

function asString(value: AgentToolJsonValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

function assertBoundedText(
  value: AgentToolJsonValue | undefined,
  maximum: number,
  field: string
): asserts value is string {
  if (
    typeof value !== 'string'
    || value.trim() !== value
    || value.length < 1
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new AgentRunInvariantError(`${field} must be bounded canonical text.`);
  }
}

function assertOneOf<T extends string>(
  value: AgentToolJsonValue | undefined,
  options: readonly T[],
  field: string
): asserts value is T {
  if (typeof value !== 'string' || !options.includes(value as T)) {
    throw new AgentRunInvariantError(`${field} has an unsupported value.`);
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
