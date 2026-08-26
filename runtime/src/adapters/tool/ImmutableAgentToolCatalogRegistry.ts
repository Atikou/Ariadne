import {
  AgentRunInvariantError,
  cloneAgentPinnedToolIdentity,
  type AgentEffectExecutor,
  type AgentPinnedToolIdentity,
  type AgentToolAdmissionDecision,
  type AgentToolAdmissionPolicy,
  type AgentToolAdmissionRequest
} from '@ariadne/agent-core';

import type {
  AgentAdmissionToolCatalog,
  AgentAdmissionToolCatalogProvider,
  AgentAdmissionToolCatalogReferenceV1
} from '../../control/ports/AgentAdmissionAuthority.js';
import type {
  AgentInferenceToolContractDescriptorV1,
  AgentInferenceToolContractReader,
  ReadAgentInferenceToolContractsRequest
} from '../../control/ports/AgentInferenceToolContracts.js';
import { ImmutableAgentToolCatalog } from './ImmutableAgentToolCatalog.js';
import {
  assertTrustedAgentToolCatalogSnapshot,
  type TrustedAgentToolCatalogSnapshot
} from './TrustedAgentToolCatalogCompiler.js';

interface CatalogRecord {
  readonly identity: AgentAdmissionToolCatalogReferenceV1;
  readonly catalog: ImmutableAgentToolCatalog;
}

/**
 * Process-local registry of compiler-verified immutable Tool Catalogs.
 * Lookups require the complete pinned identity; there is no latest revision,
 * name-only lookup, refresh, or default catalog path.
 */
export class ImmutableAgentToolCatalogRegistry
implements
AgentAdmissionToolCatalogProvider,
AgentToolAdmissionPolicy,
AgentInferenceToolContractReader,
AgentEffectExecutor {
  private readonly records: ReadonlyMap<string, CatalogRecord>;
  private readonly executorsByTool: ReadonlyMap<string, ImmutableAgentToolCatalog>;

  public constructor(snapshots: readonly TrustedAgentToolCatalogSnapshot[] = []) {
    assertDenseArray(snapshots, 'toolCatalogRegistry.snapshots');
    const records = new Map<string, CatalogRecord>();
    const executorsByTool = new Map<string, ImmutableAgentToolCatalog>();
    for (const snapshot of snapshots) {
      assertTrustedAgentToolCatalogSnapshot(snapshot);
      const identity = Object.freeze<AgentAdmissionToolCatalogReferenceV1>({
        referenceVersion: 1,
        catalogId: snapshot.catalogId,
        revision: snapshot.revision,
        digest: snapshot.catalogDigest
      });
      const key = catalogKey(identity);
      if (records.has(key)) {
        throw invariant('Tool Catalog registry cannot contain duplicate identities.');
      }
      const catalog = new ImmutableAgentToolCatalog(snapshot);
      records.set(key, Object.freeze({
        identity,
        catalog
      }));
      for (const entry of snapshot.entries) {
        const executorKey = toolKey(entry.tool);
        if (executorsByTool.has(executorKey)) {
          throw invariant('Tool Catalog registry cannot contain duplicate Tool identities.');
        }
        executorsByTool.set(executorKey, catalog);
      }
    }
    this.records = records;
    this.executorsByTool = executorsByTool;
  }

  public async readToolCatalog(
    reference: AgentAdmissionToolCatalogReferenceV1,
    signal: AbortSignal
  ): Promise<AgentAdmissionToolCatalog | null> {
    signal.throwIfAborted();
    assertReference(reference);
    const record = this.records.get(catalogKey(reference));
    signal.throwIfAborted();
    return record?.catalog ?? null;
  }

  public hasExactCatalog(reference: AgentAdmissionToolCatalogReferenceV1): boolean {
    assertReference(reference);
    return this.records.has(catalogKey(reference));
  }

  public admit(
    request: AgentToolAdmissionRequest
  ): Promise<AgentToolAdmissionDecision> {
    const binding = request.run.binding.toolCatalog;
    const record = this.records.get(catalogKey({
      referenceVersion: 1,
      catalogId: binding.catalogId,
      revision: binding.revision,
      digest: binding.digest
    }));
    return record === undefined
      ? Promise.resolve({ status: 'deny', reason: 'catalog_mismatch' })
      : record.catalog.admit(request);
  }

  public readInferenceToolContracts(
    request: ReadAgentInferenceToolContractsRequest,
    signal: AbortSignal
  ): Promise<readonly AgentInferenceToolContractDescriptorV1[]> {
    signal.throwIfAborted();
    const record = this.records.get(catalogKey({
      referenceVersion: 1,
      catalogId: request.catalog.catalogId,
      revision: request.catalog.revision,
      digest: request.catalog.digest
    }));
    if (record === undefined) {
      return Promise.reject(invariant(
        'Inference Tool contracts require the exact immutable catalog.'
      ));
    }
    return record.catalog.readInferenceToolContracts(request, signal);
  }

  /**
   * Executes only a compiler-verified Tool matching the complete durable pin.
   * There is deliberately no catalog refresh, latest revision, provider
   * default, or name-only fallback path.
   */
  public execute(
    request: Parameters<AgentEffectExecutor['execute']>[0],
    signal: AbortSignal
  ): Promise<Awaited<ReturnType<AgentEffectExecutor['execute']>>> {
    const tool = cloneAgentPinnedToolIdentity(
      request.tool,
      'effectExecution.tool'
    );
    const catalog = this.executorsByTool.get(toolKey(tool));
    if (catalog === undefined) {
      return Promise.reject(invariant(
        'Effect execution requires the complete compiler-verified pinned Tool identity.'
      ));
    }
    return catalog.execute({
      runId: request.runId,
      effectId: request.effectId,
      toolCallId: request.toolCallId,
      tool,
      idempotencyKey: request.idempotencyKey,
      capabilityIds: request.capabilityIds,
      scope: request.scope,
      input: request.input
    }, signal);
  }
}

function catalogKey(reference: AgentAdmissionToolCatalogReferenceV1): string {
  return JSON.stringify([
    reference.referenceVersion,
    reference.catalogId,
    reference.revision,
    reference.digest
  ]);
}

function toolKey(tool: AgentPinnedToolIdentity): string {
  return JSON.stringify([
    tool.catalogId,
    tool.revision,
    tool.digest,
    tool.toolName,
    tool.toolVersion,
    tool.providerId,
    tool.contractDigest
  ]);
}

function assertReference(
  value: AgentAdmissionToolCatalogReferenceV1
): void {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== 4
    || !hasDataField(value, 'referenceVersion')
    || !hasDataField(value, 'catalogId')
    || !hasDataField(value, 'revision')
    || !hasDataField(value, 'digest')
    || value.referenceVersion !== 1
    || typeof value.catalogId !== 'string'
    || value.catalogId.length === 0
    || value.catalogId.trim() !== value.catalogId
    || !Number.isSafeInteger(value.revision)
    || value.revision < 1
    || typeof value.digest !== 'string'
    || !/^sha256:[a-f0-9]{64}$/u.test(value.digest)
  ) {
    throw invariant('Tool Catalog reference must be one exact immutable identity.');
  }
}

function hasDataField(value: object, key: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined
    && descriptor.enumerable === true
    && Object.prototype.hasOwnProperty.call(descriptor, 'value');
}

function assertDenseArray(value: unknown, field: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw invariant(`${field} must be a dense data-only array.`);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== value.length + 1
    || keys[value.length] !== 'length'
    || keys.slice(0, -1).some((key, index) => (
      key !== String(index) || !hasDataField(value, String(index))
    ))
  ) {
    throw invariant(`${field} must be a dense data-only array.`);
  }
}

function invariant(message: string): AgentRunInvariantError {
  return new AgentRunInvariantError(message);
}
