import { AgentEntityHandle } from '../../src/composition/agent-entity/AgentEntityHandle.js';
import {
  compileAgentEntityManifest,
  type AgentEntityManifest
} from '../../src/composition/agent-entity/AgentEntityManifest.js';

/** Test-only positional fixture adapter; production accepts only AgentEntityManifest. */
export class TestAgentEntityHandle extends AgentEntityHandle {
  public constructor(
    persistence: AgentEntityManifest['persistence'],
    options: AgentEntityManifest['options'] = {},
    executionPipeline?: AgentEntityManifest['executionPipeline'],
    modelCatalog?: AgentEntityManifest['modelCatalog'],
    projectionWakeEventSink?: AgentEntityManifest['projectionWakeEventSink'],
    authorizedWorkspaceIds: readonly string[] = [],
    observability?: AgentEntityManifest['observability'],
    liveWork?: AgentEntityManifest['liveWork'],
    humanSkillCatalog?: AgentEntityManifest['humanSkillCatalog']
  ) {
    super(compileAgentEntityManifest({
      persistence,
      options,
      authorizedWorkspaceIds,
      ...(executionPipeline === undefined ? {} : { executionPipeline }),
      ...(modelCatalog === undefined ? {} : { modelCatalog }),
      ...(projectionWakeEventSink === undefined ? {} : { projectionWakeEventSink }),
      ...(observability === undefined ? {} : { observability }),
      ...(liveWork === undefined ? {} : { liveWork }),
      ...(humanSkillCatalog === undefined ? {} : { humanSkillCatalog })
    }));
  }
}
