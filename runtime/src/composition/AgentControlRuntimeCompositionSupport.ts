import type {
  AgentDirectivePayloadLookup,
  AgentPlanReference
} from '@ariadne/agent-core';

import type { SqliteAgentRunUnitOfWork } from '../adapters/persistence/SqliteAgentRunUnitOfWork.js';
import type { AgentControlRuntimeFactoryInput } from '../ingress/AgentControlLifecycle.js';
import type { AgentRunVersionReader } from '../projection/AgentRunProjectionPorts.js';
import {
  ProductionAgentControlExecutionPipelineFactory,
  type AgentControlExecutionPipelineFactory
} from './ProductionAgentControlExecutionPipelineFactory.js';
import { HostCredentialResolver } from './HostCredentialResolver.js';

export function createProductionExecutionPipelineFactory(
  input: AgentControlRuntimeFactoryInput
): AgentControlExecutionPipelineFactory | undefined {
  if (input.workspaces === undefined) {
    return undefined;
  }
  if (input.agentToolCatalogSnapshots === undefined) return undefined;
  if (input.runtimeServices?.instructionAssembly === undefined) return undefined;
  if (input.runtimeServices.lifecycleHooks === undefined) return undefined;
  return new ProductionAgentControlExecutionPipelineFactory({
    toolCatalogSnapshots: input.agentToolCatalogSnapshots,
    credentialEnvironment: input.credentialEnvironment,
    credentialResolver: new HostCredentialResolver(input.hostCapabilities),
    instructionAssembly: input.runtimeServices.instructionAssembly,
    lifecycleHooks: input.runtimeServices.lifecycleHooks,
    liveWorkLifecycle: input.runtimeServices.liveWorkLifecycle,
    recoveryReporter: {
      reportExecutionIntentRecovery: async (notice) => {
        console.error('[agent-control] execution intent requires recovery', {
          state: notice.state,
          reason: notice.reason
        });
      }
    }
  });
}

export function createAgentRunVersionReader(
  unitOfWork: SqliteAgentRunUnitOfWork
): AgentRunVersionReader {
  return Object.freeze({
    loadCommittedCommandReceipt: (commandId: string) => (
      unitOfWork.loadCommittedCommandReceipt(commandId)
    ),
    loadRunVersion: (runId: string, version: number) => (
      unitOfWork.loadRunVersion(runId, version)
    ),
    loadPlanVersion: (reference: AgentPlanReference) => unitOfWork.transaction(
      (transaction) => {
        if (transaction.loadPlanVersion === undefined) {
          throw new Error('agent_control_plan_version_reader_unavailable');
        }
        return transaction.loadPlanVersion(reference);
      }
    ),
    loadDirectivePayload: (reference: AgentDirectivePayloadLookup) => (
      unitOfWork.loadDirectivePayload(reference)
    )
  });
}
