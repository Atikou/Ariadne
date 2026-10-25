import { TaskCenterRuntimeService } from '../TaskCenterRuntimeService.js';
import { ScheduleWorker } from '../ScheduleWorker.js';
import { WorkflowAgentWorker } from '../WorkflowAgentWorker.js';
import { GoalAutonomyWorker } from '../GoalAutonomyWorker.js';
import { composeAgentEntityCommandManifest } from './AgentEntityCommandAssembly.js';
import type { AgentEntityManifest } from './AgentEntityManifest.js';
import type { AgentProjectionComponentHandle } from './components/projection/AgentProjectionComponent.js';
import type { RuntimeCommandEnvelope } from '../../ingress/RuntimeIngress.js';
import type { RuntimeApplicationCommandResult } from '../../ingress/RuntimeApplication.js';

/** Composes original workers and one disposable read-model observer under the same Entity lifecycle. */
export function composeAgentEntityServices(manifest: AgentEntityManifest, projection: AgentProjectionComponentHandle,
  execute: (envelope: RuntimeCommandEnvelope) => Promise<RuntimeApplicationCommandResult | null>) {
  const { unitOfWork, conversation, productivity, attachmentStore, taskQuerySnapshots } = manifest.persistence;
  const loadRun = (runId: string) => unitOfWork.transaction(transaction => transaction.loadRun(runId));
  const taskCenter = taskQuerySnapshots === undefined ? undefined : new TaskCenterRuntimeService({
    projection: manifest.persistence.publicProjection, conversation, productivity, index: taskQuerySnapshots,
    authorizedWorkspaceIds: manifest.authorizedWorkspaceIds, loadRun });
  const commandManifest = composeAgentEntityCommandManifest({ unitOfWork, conversation,
    executionPipeline: manifest.executionPipeline, memoryAuthority: manifest.memoryAuthority,
    workspaceDocuments: manifest.workspaceDocuments, projectionCommandOwners: projection.commandOwners(),
    wakeProjectionDrain: () => projection.wake(), authorizedWorkspaceIds: manifest.authorizedWorkspaceIds,
    conversationCommandNow: projection.conversationCommandNow,
    agentDecisionCommandNow: manifest.options.agentDecisionCommandNow, agentInboxCommandNow: manifest.options.agentInboxCommandNow,
    attachmentStore, humanSkillCatalog: manifest.humanSkillCatalog, productivityStore: productivity, taskCenter });
  const schedule = productivity === undefined ? undefined : new ScheduleWorker(productivity, conversation, execute);
  const workflow = productivity === undefined || manifest.executionPipeline === undefined ? undefined
    : new WorkflowAgentWorker(productivity, conversation, loadRun, execute);
  const goal = productivity === undefined || manifest.executionPipeline?.assertGoalAutonomyAdmission === undefined ? undefined
    : new GoalAutonomyWorker(productivity, conversation, loadRun, execute);
  return { commandManifest, workers: { schedule, workflow, goal }, taskCenter };
}
