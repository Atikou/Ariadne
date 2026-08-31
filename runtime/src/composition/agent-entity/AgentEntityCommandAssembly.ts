import type { SqliteAgentRunUnitOfWork } from '../../adapters/persistence/SqliteAgentRunUnitOfWork.js';
import type { SqliteConversationRunHandoffUnitOfWork } from '../../adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import type { SqliteProductivityStore } from '../../adapters/persistence/SqliteProductivityStore.js';
import type { ConversationAttachmentStore } from '../../control/ports/ConversationAttachmentStore.js';
import type { HumanSkillCatalog } from '../../control/ports/HumanSkillCatalog.js';
import { AgentInboxPublicCommandHandler } from '../AgentInboxPublicCommandHandler.js';
import { AgentSubagentInterruptPublicCommandHandler } from '../AgentSubagentInterruptPublicCommandHandler.js';
import {
  createHumanSkillCommandOwners,
  HumanSkillPublicCommandHandler
} from '../HumanSkillPublicCommandHandler.js';
import {
  createProductivityCommandOwners,
  ProductivityPublicCommandHandler
} from '../ProductivityPublicCommandHandler.js';
import type { AgentControlExecutionPipeline } from '../ProductionAgentControlExecutionPipelineFactory.js';
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
  const humanSkills = input.humanSkillCatalog === undefined
    ? undefined
    : new HumanSkillPublicCommandHandler(
        input.humanSkillCatalog,
        input.authorizedWorkspaceIds ?? []
      );
  const productivity = input.productivityStore === undefined
    ? undefined
    : new ProductivityPublicCommandHandler(
        input.productivityStore,
        input.conversation,
        input.authorizedWorkspaceIds ?? []
      );

  return compileAgentEntityCommandManifest([
    agentEntityCommandComponent('agent.conversation', conversation.commandOwners()),
    agentEntityCommandComponent('agent.decision', decisions.commandOwners()),
    agentEntityCommandComponent('agent.run-control', runControl.commandOwners()),
    agentEntityCommandComponent(
      'agent.tool-result-detail', toolResultDetail.commandOwners()
    ),
    agentEntityCommandComponent('agent.inbox', inbox.commandOwners()),
    agentEntityCommandComponent(
      'agent.subagent-interrupt', subagentInterrupt.commandOwners()
    ),
    agentEntityCommandComponent(
      'agent.skills-human', createHumanSkillCommandOwners(humanSkills)
    ),
    agentEntityCommandComponent(
      'agent.productivity', createProductivityCommandOwners(productivity)
    ),
    agentEntityCommandComponent('agent.projection', input.projectionCommandOwners)
  ]);
}
