import { createHash } from 'node:crypto';

import type { RuntimeBootstrap } from '@ariadne/protocol/host';

import type { TrustedAgentToolRegistrationV1 } from '../../adapters/tool/TrustedAgentToolCatalogCompiler.js';
import type { WorkspaceBinding } from '../first-party-tools/FirstPartyAgentToolSupport.js';
import {
  assertProductionSkillCandidate,
  assertProductionSkillDefinition,
  assertProductionSkillResourceDescriptor,
  createProductionSkillCatalogSnapshot,
  normalizeSkillProviderObservation,
  renderProductionSkillCatalog,
  retainedSkillKey,
  validateSkillResourcePath,
  validateAndSortSkillProviders,
  waitForSkillProvider
} from './ProductionSkillCatalogSupport.js';
import { createProductionSkillToolRegistrations } from './ProductionSkillLoadTool.js';
import { createProductionLocalSkillProviders } from './ProductionLocalSkillProviders.js';
import type {
  ProductionSkillCandidate,
  ProductionSkillCatalog,
  ProductionSkillCatalogSnapshot,
  ProductionSkillDefinition,
  ProductionSkillProvider,
  ProductionSkillProviderObservation,
  ProductionSkillResource
} from './ProductionSkillContracts.js';

export type {
  ProductionSkillCandidate,
  ProductionSkillCatalog,
  ProductionSkillCatalogSnapshot,
  ProductionSkillDefinition,
  ProductionSkillDescriptor,
  ProductionSkillInvocationPolicy,
  ProductionSkillLayer,
  ProductionSkillLookup,
  ProductionSkillProvider,
  ProductionSkillProviderObservation,
  ProductionSkillResource,
  ProductionSkillResourceDescriptor
} from './ProductionSkillContracts.js';

const MAX_RETAINED_SKILL_REVISIONS = 1_024;

interface IndexedSkill {
  readonly candidate: ProductionSkillCandidate;
  readonly provider: ProductionSkillProvider;
}

interface WorkspaceCatalogState {
  readonly snapshot: ProductionSkillCatalogSnapshot;
}

export interface ProductionSkillCatalogOptions {
  /** Replaces local providers in tests or an explicitly audited composition. */
  readonly providers?: readonly ProductionSkillProvider[];
}

/** Static Manifest providers with cancellable, per-Workspace observations. */
export function createProductionSkillCatalog(
  bootstrap: RuntimeBootstrap,
  workspaces: ReadonlyMap<string, WorkspaceBinding>,
  options: ProductionSkillCatalogOptions = {}
): ProductionSkillCatalog {
  const providers = options.providers ?? createProductionLocalSkillProviders({
    installRoot: bootstrap.installRoot,
    ...(bootstrap.runtimePolicy.skills.userDirectory === undefined
      ? {}
      : { userDirectory: bootstrap.runtimePolicy.skills.userDirectory })
  });
  return new ProductionSkillCatalogService(
    bootstrap.runtimePolicy.skills.enabled,
    workspaces,
    providers
  );
}

class ProductionSkillCatalogService implements ProductionSkillCatalog {
  private readonly enabled: readonly string[];
  private readonly providers: readonly ProductionSkillProvider[];
  private readonly lastGood = new Map<string, WorkspaceCatalogState>();
  private readonly retained = new Map<string, Map<string, IndexedSkill>>();
  private readonly lifetime = new AbortController();
  private closePromise: Promise<void> | null = null;

  public constructor(
    enabled: readonly string[],
    private readonly workspaces: ReadonlyMap<string, WorkspaceBinding>,
    providers: readonly ProductionSkillProvider[]
  ) {
    this.enabled = Object.freeze([...new Set(enabled)].sort(compareCodeUnits));
    this.providers = validateAndSortSkillProviders(providers);
  }

  public async snapshot(
    workspaceId: string,
    signal: AbortSignal
  ): Promise<ProductionSkillCatalogSnapshot> {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace === undefined) throw new Error('skill_workspace_unknown');
    const operationSignal = AbortSignal.any([signal, this.lifetime.signal]);
    operationSignal.throwIfAborted();
    if (this.enabled.length === 0) {
      return createProductionSkillCatalogSnapshot(workspaceId, true, 'fresh', [], []);
    }

    const observed = await this.collect(workspaceId, workspace.rootPath, operationSignal);
    operationSignal.throwIfAborted();
    const missing = this.enabled.filter((name) => !observed.entries.has(name));
    if (observed.complete) {
      const snapshot = createProductionSkillCatalogSnapshot(
        workspaceId,
        true,
        'fresh',
        [...observed.entries.values()].map((entry) => entry.candidate),
        missing
      );
      if (missing.length > 0) {
        this.lastGood.delete(workspaceId);
      } else {
        this.retain(workspaceId, observed.entries);
        this.lastGood.set(workspaceId, Object.freeze({
          snapshot
        }));
      }
      return snapshot;
    }

    const previous = this.lastGood.get(workspaceId);
    return previous === undefined
      ? createProductionSkillCatalogSnapshot(
          workspaceId,
          false,
          'fresh',
          [...observed.entries.values()].map((entry) => entry.candidate),
          missing
        )
      : Object.freeze({
          ...previous.snapshot,
          complete: false,
          source: 'last_good' as const
        });
  }

  public async renderAdmissionCatalog(
    workspaceId: string,
    signal: AbortSignal
  ): Promise<string> {
    const snapshot = await this.snapshot(workspaceId, signal);
    signal.throwIfAborted();
    if (!snapshot.complete && snapshot.source !== 'last_good') {
      throw new Error(`skill_catalog_incomplete:${workspaceId}`);
    }
    if (snapshot.missing.length > 0) {
      throw new Error(`skill_not_found:${workspaceId}:${snapshot.missing.join(',')}`);
    }
    return renderProductionSkillCatalog(snapshot);
  }

  public createToolRegistrations(): readonly TrustedAgentToolRegistrationV1[] {
    return createProductionSkillToolRegistrations({
      workspaces: this.workspaces,
      load: (workspaceId, name, revision, signal) => this.load(
        workspaceId,
        name,
        revision,
        signal
      ),
      readResource: (workspaceId, name, revision, relativePath, signal) => this.readResource(
        workspaceId,
        name,
        revision,
        relativePath,
        signal
      )
    });
  }

  public close(): Promise<void> {
    this.closePromise ??= this.closeOwned();
    return this.closePromise;
  }

  private async closeOwned(): Promise<void> {
    if (!this.lifetime.signal.aborted) {
      this.lifetime.abort(new Error('skill_catalog_closed'));
    }
    const results = await Promise.allSettled(this.providers.map(
      async (provider) => provider.close?.()
    ));
    this.lastGood.clear();
    this.retained.clear();
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length > 0) throw new AggregateError(failures, 'skill_provider_close_failed');
  }

  private async collect(
    workspaceId: string,
    workspaceRoot: string,
    signal: AbortSignal
  ): Promise<{ readonly complete: boolean; readonly entries: ReadonlyMap<string, IndexedSkill> }> {
    const entries = new Map<string, IndexedSkill>();
    let complete = true;
    for (const provider of this.providers) {
      signal.throwIfAborted();
      let output: readonly ProductionSkillCandidate[] | ProductionSkillProviderObservation;
      try {
        output = await waitForSkillProvider(
          provider.list({ workspaceId, workspaceRoot, signal }),
          signal
        );
      } catch (error) {
        if (signal.aborted) signal.throwIfAborted();
        complete = false;
        continue;
      }
      const observation = normalizeSkillProviderObservation(output, provider.providerId);
      if (!observation.complete) complete = false;
      const seen = new Set<string>();
      for (const candidate of observation.candidates) {
        assertProductionSkillCandidate(candidate, provider.providerId);
        if (seen.has(candidate.name)) {
          throw new Error(`skill_provider_candidate_duplicate:${provider.providerId}:${candidate.name}`);
        }
        seen.add(candidate.name);
        if (this.enabled.includes(candidate.name)) {
          entries.set(candidate.name, Object.freeze({ candidate, provider }));
        }
      }
    }
    return Object.freeze({ complete, entries: new Map(entries) });
  }

  private retain(workspaceId: string, entries: ReadonlyMap<string, IndexedSkill>): void {
    let retained = this.retained.get(workspaceId);
    if (retained === undefined) {
      retained = new Map();
      this.retained.set(workspaceId, retained);
    }
    for (const entry of entries.values()) {
      const key = retainedSkillKey(entry.candidate.name, entry.candidate.revision);
      if (retained.has(key)) continue;
      if (retained.size >= MAX_RETAINED_SKILL_REVISIONS) {
        throw new Error(`skill_revision_retention_exhausted:${workspaceId}`);
      }
      retained.set(key, entry);
    }
  }

  private async load(
    workspaceId: string,
    name: string,
    revision: string,
    callerSignal: AbortSignal
  ): Promise<ProductionSkillDefinition> {
    const indexed = this.retained.get(workspaceId)?.get(retainedSkillKey(name, revision));
    if (indexed === undefined) throw new Error('skill_revision_not_pinned');
    const workspace = this.workspaces.get(workspaceId);
    if (workspace === undefined) throw new Error('skill_workspace_unknown');
    const signal = AbortSignal.any([callerSignal, this.lifetime.signal]);
    const definition = await waitForSkillProvider(indexed.provider.get(
      indexed.candidate,
      { workspaceId, workspaceRoot: workspace.rootPath, signal }
    ), signal);
    signal.throwIfAborted();
    if (definition === undefined) throw new Error('skill_source_unavailable');
    assertProductionSkillDefinition(definition, indexed.candidate);
    if (!definition.invocation.modelInvocable) throw new Error('skill_model_invocation_disabled');
    return definition;
  }

  private async readResource(
    workspaceId: string,
    name: string,
    revision: string,
    relativePath: string,
    callerSignal: AbortSignal
  ): Promise<ProductionSkillResource> {
    validateSkillResourcePath(relativePath);
    const definition = await this.load(workspaceId, name, revision, callerSignal);
    const descriptor = definition.resources.find((entry) => entry.relativePath === relativePath);
    if (descriptor === undefined) throw new Error('skill_resource_not_found');
    const indexed = this.retained.get(workspaceId)?.get(retainedSkillKey(name, revision));
    if (indexed === undefined) throw new Error('skill_revision_not_pinned');
    if (indexed.provider.readResource === undefined) throw new Error('skill_resource_unavailable');
    const workspace = this.workspaces.get(workspaceId);
    if (workspace === undefined) throw new Error('skill_workspace_unknown');
    const signal = AbortSignal.any([callerSignal, this.lifetime.signal]);
    const resource = await waitForSkillProvider(indexed.provider.readResource(
      indexed.candidate,
      relativePath,
      { workspaceId, workspaceRoot: workspace.rootPath, signal }
    ), signal);
    signal.throwIfAborted();
    if (resource === undefined) throw new Error('skill_resource_unavailable');
    assertProductionSkillResourceDescriptor(resource);
    if (
      resource.relativePath !== descriptor.relativePath
      || resource.mediaType !== descriptor.mediaType
      || resource.byteLength !== descriptor.byteLength
      || resource.revision !== descriptor.revision
      || !(resource.bytes instanceof Uint8Array)
      || resource.bytes.byteLength !== descriptor.byteLength
      || digestBytes(resource.bytes) !== descriptor.revision
    ) throw new Error('skill_resource_drifted');
    return Object.freeze({
      ...descriptor,
      bytes: new Uint8Array(resource.bytes)
    });
  }
}

function digestBytes(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
