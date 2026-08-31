import {
  AgentEffectDispatchService,
  type AgentRunBinding
} from '@ariadne/agent-core';
import type {
  AgentAdmissionAuthoritySource,
  AgentAdmissionAuthoritySourceManifest
} from '@ariadne/protocol/host';

import {
  ImmutableAgentToolCatalogRegistry
} from '../../../../adapters/tool/ImmutableAgentToolCatalogRegistry.js';
import type {
  TrustedAgentToolCatalogSnapshot
} from '../../../../adapters/tool/TrustedAgentToolCatalogCompiler.js';
import type {
  SqliteAgentRunUnitOfWork
} from '../../../../adapters/persistence/SqliteAgentRunUnitOfWork.js';
import {
  V3AgentEffectDispatchCheckpointFactory
} from '../../../../control/execution/AgentEffectDispatchCheckpointFactory.js';
import {
  ProductionAgentEffectExecutionInputReader
} from '../../../../control/execution/ProductionAgentEffectExecutionInputReader.js';
import type { AgentLifecycleHooks } from '../../../../control/ports/AgentLifecycleHooks.js';
import {
  ProtectedAgentEffectResultReader
} from '../../../../control/resources/ProtectedAgentEffectResultReader.js';
import type { ProductionAgentLifecycleBridge } from '../../../ProductionAgentLifecycleBridge.js';
import { ProductionAgentControlExecutionPipelineError } from '../../AgentExecutionPipelineErrors.js';

const PREFLIGHT_DIGEST = `sha256:${'0'.repeat(64)}`;

export interface AgentToolExecutionComponentInput {
  readonly unitOfWork: SqliteAgentRunUnitOfWork;
  readonly authoritySource: Extract<
    AgentAdmissionAuthoritySource,
    { readonly status: 'enabled' }
  >;
  readonly catalogSnapshots: readonly TrustedAgentToolCatalogSnapshot[];
  readonly lifecycleHooks: AgentLifecycleHooks;
}

export interface AgentToolExecutionComponentHandle {
  readonly catalogs: ImmutableAgentToolCatalogRegistry;
  readonly effectInputReader: ProductionAgentEffectExecutionInputReader;
  readonly protectedEffectResultReader: ProtectedAgentEffectResultReader;
  hasExactAuthority(manifest: AgentAdmissionAuthoritySourceManifest): boolean;
  createEffectDispatch(lifecycle: ProductionAgentLifecycleBridge): AgentEffectDispatchService;
}

/** Owns the immutable Tool Catalog and every protected Effect execution seam. */
export async function createAgentToolExecutionComponent(
  input: AgentToolExecutionComponentInput
): Promise<AgentToolExecutionComponentHandle> {
  const protectedEffectResultReader = new ProtectedAgentEffectResultReader(
    input.unitOfWork
  );
  const catalogs = new ImmutableAgentToolCatalogRegistry(
    input.catalogSnapshots,
    input.lifecycleHooks,
    { protectedEffectResults: protectedEffectResultReader }
  );
  await assertCatalogAuthorities(input.authoritySource, catalogs);
  const effectInputReader = new ProductionAgentEffectExecutionInputReader(
    input.unitOfWork
  );

  return Object.freeze({
    catalogs,
    effectInputReader,
    protectedEffectResultReader,
    hasExactAuthority: (manifest: AgentAdmissionAuthoritySourceManifest): boolean => (
      catalogs.hasExactCatalog(catalogReference(manifest))
    ),
    createEffectDispatch: (lifecycle: ProductionAgentLifecycleBridge) => (
      new AgentEffectDispatchService(
        input.unitOfWork,
        effectInputReader,
        catalogs,
        new V3AgentEffectDispatchCheckpointFactory(),
        undefined,
        lifecycle
      )
    )
  });
}

async function assertCatalogAuthorities(
  source: Extract<AgentAdmissionAuthoritySource, { readonly status: 'enabled' }>,
  catalogs: ImmutableAgentToolCatalogRegistry
): Promise<void> {
  for (const manifest of source.manifests) {
    const reference = catalogReference(manifest);
    if (!catalogs.hasExactCatalog(reference)) {
      throw missingCatalog();
    }
    const catalog = await catalogs.readToolCatalog(
      reference,
      new AbortController().signal
    );
    if (catalog === null) throw missingCatalog();
    try {
      catalog.resolveAdmissionTools(preflightBinding(manifest));
    } catch (cause) {
      throw new ProductionAgentControlExecutionPipelineError(
        'AGENT_EXECUTION_TOOL_CATALOG_INVALID',
        'An enabled Agent authority contradicts its immutable Tool Catalog.',
        { cause }
      );
    }
  }
}

function missingCatalog(): ProductionAgentControlExecutionPipelineError {
  return new ProductionAgentControlExecutionPipelineError(
    'AGENT_EXECUTION_TOOL_CATALOG_MISSING',
    'An enabled Agent authority references an unavailable Tool Catalog.'
  );
}

function catalogReference(manifest: AgentAdmissionAuthoritySourceManifest) {
  return {
    referenceVersion: 1 as const,
    catalogId: manifest.toolCatalog.catalogId,
    revision: manifest.toolCatalog.revision,
    digest: manifest.toolCatalog.digest
  };
}

function preflightBinding(
  manifest: AgentAdmissionAuthoritySourceManifest
): AgentRunBinding {
  const runId = 'agent-tool-execution-preflight-run';
  return {
    bindingVersion: 3,
    sessionId: 'agent-tool-execution-preflight-session',
    objectiveRef: {
      kind: 'conversation_message',
      messageId: 'agent-tool-execution-preflight-message',
      messageVersion: 1,
      contentDigest: PREFLIGHT_DIGEST
    },
    workspace: {
      ...manifest.workspace,
      scopeIds: [...manifest.workspace.scopeIds]
    },
    model: { ...manifest.model },
    policy: { ...manifest.policy },
    capabilities: manifest.capabilityGrant.capabilities.map((capability) => ({
      capabilityId: capability.capabilityId,
      scopeIds: [...capability.scopeIds]
    })),
    toolCatalog: {
      ...manifest.toolCatalog,
      allowedToolNames: [...manifest.toolCatalog.allowedToolNames]
    },
    budget: {
      grantId: manifest.rootBudget.authorityId,
      runId,
      vector: { ...manifest.rootBudget.vector },
      deadlineAt: manifest.rootBudget.deadlinePolicy.deadlineAt,
      source: { kind: 'root' }
    }
  };
}
