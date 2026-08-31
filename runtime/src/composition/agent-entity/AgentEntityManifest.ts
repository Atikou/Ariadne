import type { PublicAgentObservability } from '../../adapters/observability/PublicAgentObservability.js';
import type { AgentControlRuntimeServices } from '../../ingress/AgentControlLifecycle.js';
import type { AgentControlLiveWorkService } from '../../control/ports/AgentLiveWork.js';
import type { RuntimePublicEventSink } from '../../ingress/RuntimePublicEventSink.js';
import type { ModelCatalogProjectionSource } from '../../projection/ModelCatalogProjectionPorts.js';
import type { AgentControlExecutionPipeline } from '../ProductionAgentControlExecutionPipelineFactory.js';
import type { AgentPersistenceComponentHandle } from './components/persistence/AgentPersistenceComponent.js';
import type { AgentProjectionComponentOptions } from './components/projection/AgentProjectionComponent.js';

export interface AgentEntityHandleOptions extends AgentProjectionComponentOptions {
  readonly agentDecisionCommandNow?: () => Date;
  readonly agentInboxCommandNow?: () => Date;
}

export interface AgentEntityManifest {
  readonly persistence: AgentPersistenceComponentHandle;
  readonly options: AgentEntityHandleOptions;
  readonly executionPipeline?: AgentControlExecutionPipeline;
  readonly modelCatalog?: ModelCatalogProjectionSource;
  readonly projectionWakeEventSink?: RuntimePublicEventSink;
  readonly authorizedWorkspaceIds: readonly string[];
  readonly observability?: PublicAgentObservability;
  readonly liveWork?: AgentControlLiveWorkService;
  readonly humanSkillCatalog?: NonNullable<AgentControlRuntimeServices['humanSkillCatalog']>;
}

/** Freezes the one complete assembly input consumed by a started Agent Entity. */
export function compileAgentEntityManifest(
  input: AgentEntityManifest
): AgentEntityManifest {
  const workspaceIds = [...input.authorizedWorkspaceIds];
  if (
    workspaceIds.some((id) => id.length === 0)
    || new Set(workspaceIds).size !== workspaceIds.length
  ) throw new Error('agent_entity_manifest_workspace_ids_invalid');

  return Object.freeze({
    ...input,
    options: Object.freeze({ ...input.options }),
    authorizedWorkspaceIds: Object.freeze(workspaceIds)
  });
}
