import type { SqliteAgentRunUnitOfWork } from '../../adapters/persistence/SqliteAgentRunUnitOfWork.js';
import type { SqliteConversationRunHandoffUnitOfWork } from '../../adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import type { SqliteProductivityStore } from '../../adapters/persistence/SqliteProductivityStore.js';
import type { ConversationAttachmentStore } from '../../control/ports/ConversationAttachmentStore.js';
import type { HumanSkillCatalog } from '../../control/ports/HumanSkillCatalog.js';
import type { LongMemoryAuthority } from '../../control/ports/LongMemoryAuthority.js';
import type { WorkspaceDocumentAuthority } from '../../control/ports/WorkspaceDocumentAuthority.js';
import { createProductivityTaskIsolationCommandOwners } from '../ProductivityTaskIsolationCommandHandler.js';
import { WorkspaceDocumentPublicCommandHandler,createWorkspaceDocumentCommandOwners } from '../WorkspaceDocumentPublicCommandHandler.js';
import { createLongMemoryCommandOwners, LongMemoryPublicCommandHandler } from '../LongMemoryPublicCommandHandler.js';
import { AgentInboxPublicCommandHandler } from '../AgentInboxPublicCommandHandler.js';
import { AgentSubagentInterruptPublicCommandHandler } from '../AgentSubagentInterruptPublicCommandHandler.js';
import {
  composeHumanSkillCommandOwners
} from '../HumanSkillPublicCommandHandler.js';
import {
  createProductivityCommandOwners,
  ProductivityPublicCommandHandler
} from '../ProductivityPublicCommandHandler.js';
import type { AgentControlExecutionPipeline } from '../ProductionAgentControlExecutionPipelineFactory.js';
import type { TaskCenterRuntimeService } from '../TaskCenterRuntimeService.js';
import { createTaskCenterCommandOwners } from '../TaskCenterPublicCommandOwner.js';
import {
  agentEntityCommandComponent,
  compileAgentEntityCommandManifest,
  type AgentEntityCommandManifest
} from './AgentEntityCompiler.js';
import type { AgentPublicCommandOwner } from './command-owners/AgentPublicCommandOwnerTable.js';
import { createAgentConversationComponent } from './components/conversation/AgentConversationComponent.js';
import { createAgentDecisionComponent } from './components/decision/AgentDecisionComponent.js';
import { createAgentRunControlComponent } from './components/run-control/AgentRunControlComponent.js';
import {
  createAgentToolResultDetailComponent
} from './components/tool-result-detail/AgentToolResultDetailComponent.js';

export interface AgentEntityCommandAssemblyInput {
  readonly unitOfWork: SqliteAgentRunUnitOfWork;
  readonly conversation: SqliteConversationRunHandoffUnitOfWork;
  readonly executionPipeline?: AgentControlExecutionPipeline;
  readonly projectionCommandOwners: readonly AgentPublicCommandOwner[];
  readonly wakeProjectionDrain: () => void;
  readonly authorizedWorkspaceIds?: readonly string[];
  readonly conversationCommandNow?: () => Date;
  readonly agentDecisionCommandNow?: () => Date;
  readonly agentInboxCommandNow?: () => Date;
  readonly attachmentStore?: ConversationAttachmentStore;
  readonly humanSkillCatalog?: HumanSkillCatalog;
  readonly productivityStore?: SqliteProductivityStore;
  readonly memoryAuthority?: LongMemoryAuthority;
  readonly workspaceDocuments?: WorkspaceDocumentAuthority;
  readonly taskCenter?: TaskCenterRuntimeService;
}

/** Composes command-owning Agent components and publishes one validated manifest. */
export function composeAgentEntityCommandManifest(
  input: AgentEntityCommandAssemblyInput
): AgentEntityCommandManifest {
  const conversation = createAgentConversationComponent({
    conversation: input.conversation,
    executionPipeline: input.executionPipeline,
    wakeProjectionDrain: input.wakeProjectionDrain,
    options: {
      authorizedWorkspaceIds: input.authorizedWorkspaceIds,
      commandNow: input.conversationCommandNow,
      attachmentStore: input.attachmentStore
    }
  });
  const runControl = createAgentRunControlComponent({
    unitOfWork: input.unitOfWork,
    executionPipeline: input.executionPipeline,
    wakeProjectionDrain: input.wakeProjectionDrain
  });
  const decisions = createAgentDecisionComponent({
    unitOfWork: input.unitOfWork,
    executionPipeline: input.executionPipeline,
    wakeProjectionDrain: input.wakeProjectionDrain,
    commandNow: input.agentDecisionCommandNow
  });
  const toolResultDetail = createAgentToolResultDetailComponent({
    executionPipeline: input.executionPipeline,
    authorizedWorkspaceIds: input.authorizedWorkspaceIds
  });
  const inbox = new AgentInboxPublicCommandHandler(input.unitOfWork, {
    wakeWorkScheduler: () => input.executionPipeline?.runWorkScheduler.wake(),
    wakeProjectionDrain: input.wakeProjectionDrain
  }, input.agentInboxCommandNow);
  const subagentInterrupt = new AgentSubagentInterruptPublicCommandHandler(
    input.unitOfWork,
    input.executionPipeline,
    input.wakeProjectionDrain
  );
  const productivity = input.productivityStore === undefined
    ? undefined
    : new ProductivityPublicCommandHandler(
        input.productivityStore,
        input.conversation,
        input.authorizedWorkspaceIds ?? [],
        input.executionPipeline !== undefined,
        input.executionPipeline?.assertGoalAutonomyAdmission,
        runId => input.unitOfWork.transaction(transaction => transaction.loadRun(runId))
      );

  return compileAgentEntityCommandManifest([
    agentEntityCommandComponent('agent.workspace-documents',createWorkspaceDocumentCommandOwners(new WorkspaceDocumentPublicCommandHandler(input.workspaceDocuments))),
    agentEntityCommandComponent('agent.memory', createLongMemoryCommandOwners(new LongMemoryPublicCommandHandler(
      input.memoryAuthority, input.conversation, input.authorizedWorkspaceIds ?? []))),
    agentEntityCommandComponent('agent.conversation', conversation.commandOwners()),
    agentEntityCommandComponent('agent.decision', decisions.commandOwners()),
    agentEntityCommandComponent('agent.run-control', runControl.commandOwners()),
    agentEntityCommandComponent('agent.tool-result-detail', toolResultDetail.commandOwners()),
    agentEntityCommandComponent('agent.inbox', inbox.commandOwners()),
    agentEntityCommandComponent(
      'agent.subagent-interrupt', subagentInterrupt.commandOwners()
    ),
    agentEntityCommandComponent('agent.skills-human', composeHumanSkillCommandOwners(input.humanSkillCatalog, input.authorizedWorkspaceIds ?? [])),
    agentEntityCommandComponent('agent.task-center', createTaskCenterCommandOwners(input.taskCenter)),
    agentEntityCommandComponent(
      'agent.productivity', createProductivityCommandOwners(productivity)
    ),
    agentEntityCommandComponent('agent.productivity-task-isolation', createProductivityTaskIsolationCommandOwners(
      input.productivityStore, input.conversation, input.authorizedWorkspaceIds ?? [],
      runId => input.unitOfWork.transaction(transaction => transaction.loadRun(runId)))),
    agentEntityCommandComponent('agent.projection', input.projectionCommandOwners)
  ]);
}
