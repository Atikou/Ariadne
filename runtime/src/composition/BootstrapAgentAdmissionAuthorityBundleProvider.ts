import { createHash } from 'node:crypto';

import {
  agentAdmissionAuthoritySourceSchema,
  type AgentAdmissionAuthoritySource,
  type AgentAdmissionAuthoritySourceManifest
} from '@ariadne/protocol/host';

import {
  createAgentAdmissionAuthorityBundle,
  type AgentAdmissionAuthorityBundle,
  type AgentAdmissionAuthorityBundleProvider,
  type AgentAdmissionAuthorityQueryV2
} from '../control/ports/AgentAdmissionAuthority.js';
import type {
  ExactAgentModelInferenceRuntime
} from '../control/ports/AgentModelInference.js';
import {
  compileEffectiveAgentExecutionAuthority
} from './EffectiveAgentExecutionAuthority.js';

export interface AgentAdmissionAuthorityClock {
  now(): number;
}

const systemClock: AgentAdmissionAuthorityClock = {
  now: () => Date.now()
};

/**
 * Compiles the already protocol-validated Main bootstrap source into the one
 * narrow Runtime authority port. Disabled and unmatched sources return null;
 * no legacy settings or AppContext fallback exists.
 */
export function compileBootstrapAgentAdmissionAuthoritySource(
  sourceInput: unknown,
  clock: AgentAdmissionAuthorityClock = systemClock,
  models?: ExactAgentModelInferenceRuntime
): AgentAdmissionAuthorityBundleProvider {
  const source = agentAdmissionAuthoritySourceSchema.parse(sourceInput);
  return new BootstrapAgentAdmissionAuthorityBundleProvider(source, clock, models);
}

class BootstrapAgentAdmissionAuthorityBundleProvider
implements AgentAdmissionAuthorityBundleProvider {
  private readonly manifestsByWorkspaceId: ReadonlyMap<
    string,
    AgentAdmissionAuthoritySourceManifest
  >;

  public constructor(
    source: AgentAdmissionAuthoritySource,
    private readonly clock: AgentAdmissionAuthorityClock,
    private readonly models?: ExactAgentModelInferenceRuntime
  ) {
    this.manifestsByWorkspaceId = source.status === 'enabled'
      ? new Map(source.manifests.map((manifest) => [
          manifest.workspace.workspaceId,
          manifest
        ]))
      : new Map();
  }

  public async readAuthorityBundle(
    query: AgentAdmissionAuthorityQueryV2,
    signal: AbortSignal
  ): Promise<AgentAdmissionAuthorityBundle | null> {
    signal.throwIfAborted();
    const manifest = this.manifestsByWorkspaceId.get(query.workspaceId);
    const now = this.clock.now();
    if (
      manifest === undefined
      || !Number.isFinite(now)
      || Date.parse(manifest.rootBudget.deadlinePolicy.deadlineAt) <= now
    ) {
      return null;
    }

    const execution = query.execution;
    const effectiveAuthority = compileEffectiveAgentExecutionAuthority(
      manifest,
      execution
    );
    if (effectiveAuthority === null) return null;
    const model = this.models?.resolveBinding(manifest.model.settingsRevision, {
      ...(execution.modelId === undefined ? {} : { modelId: execution.modelId }),
      ...(query.requiresVision === true ? { requiresVision: true } : {}),
      ...(execution.routingStrategy === undefined
        ? {}
        : { routingStrategy: execution.routingStrategy })
    })
      ?? (this.models === undefined ? manifest.model : null);
    if (model === null || !isAuthorizedModel(manifest, model)) return null;
    const bundleId = deriveAuthorityId('bundle', manifest, query);
    const budgetGrantId = deriveAuthorityId('budget-grant', manifest, query);
    const bundle = createAgentAdmissionAuthorityBundle({
      authorityBundleVersion: 2,
      bundleId,
      revision: manifest.revision,
      subject: {
        subjectVersion: 2,
        sessionId: query.sessionId,
        workspaceId: query.workspaceId,
        objectiveMessageId: query.objectiveMessageId,
        objectiveMessageVersion: query.objectiveMessageVersion,
        objectiveDigest: query.objectiveDigest,
        runId: query.runId,
        executionProfile: { mode: execution.mode }
      },
      workspace: {
        workspaceId: manifest.workspace.workspaceId,
        revision: manifest.workspace.revision,
        grantDigest: manifest.workspace.grantDigest,
        access: effectiveAuthority.workspaceAccess,
        scopeIds: [...manifest.workspace.scopeIds]
      },
      model: {
        ...model,
        ...(execution.inference === undefined
          ? {}
          : { inference: structuredClone(execution.inference) })
      },
      policy: { ...manifest.policy },
      capabilityGrant: {
        grantId: manifest.capabilityGrant.grantId,
        revision: manifest.capabilityGrant.revision,
        capabilities: effectiveAuthority.capabilities.map((capability) => ({
          capabilityId: capability.capabilityId,
          scopeIds: [...capability.scopeIds]
        }))
      },
      toolCatalog: {
        ...manifest.toolCatalog,
        allowedToolNames: [...effectiveAuthority.allowedToolNames]
      },
      rootBudget: {
        authorityId: manifest.rootBudget.authorityId,
        revision: manifest.rootBudget.revision,
        grantId: budgetGrantId,
        runId: query.runId,
        vector: { ...effectiveAuthority.budget },
        deadlineAt: manifest.rootBudget.deadlinePolicy.deadlineAt
      }
    });
    signal.throwIfAborted();
    return bundle;
  }
}

function isAuthorizedModel(
  manifest: AgentAdmissionAuthoritySourceManifest,
  model: { readonly providerId: string; readonly modelId: string; readonly settingsRevision: number }
): boolean {
  return (manifest.modelCandidates ?? [manifest.model]).some((candidate) => (
    candidate.providerId === model.providerId
    && candidate.settingsRevision === model.settingsRevision
    && (
      candidate.modelId === model.modelId
      || (
        candidate.providerId === 'ariadne.local'
        && candidate.modelId === '__runtime_selected_local__'
      )
    )
  ));
}

function deriveAuthorityId(
  kind: 'bundle' | 'budget-grant',
  manifest: AgentAdmissionAuthoritySourceManifest,
  query: AgentAdmissionAuthorityQueryV2
): string {
  const digest = createHash('sha256').update(JSON.stringify([
    'ariadne-agent-admission-authority.v1',
    kind,
    manifest.manifestId,
    manifest.revision,
    manifest.rootBudget.authorityId,
    manifest.rootBudget.revision,
    query.subjectVersion,
    query.sessionId,
    query.workspaceId,
    query.objectiveMessageId,
    query.objectiveMessageVersion,
    query.objectiveDigest,
    query.runId,
    query.execution
  ])).digest('hex');
  return `agent-admission-${kind}.v1:${digest}`;
}
