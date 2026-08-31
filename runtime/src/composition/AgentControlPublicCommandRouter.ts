import type {
  SqliteAgentRunUnitOfWork
} from '../adapters/persistence/SqliteAgentRunUnitOfWork.js';
import type {
  SqliteConversationRunHandoffUnitOfWork
} from '../adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import type { SqliteProductivityStore } from '../adapters/persistence/SqliteProductivityStore.js';
import type {
  RuntimeApplicationCommandResult
} from '../ingress/RuntimeApplication.js';
import type { RuntimeCommandEnvelope } from '../ingress/RuntimeIngress.js';
import type { RuntimeCommandReconciliation } from '../control/ports/RuntimeCommandJournal.js';
import type { ConversationAttachmentStore } from '../control/ports/ConversationAttachmentStore.js';
import type {
  AgentControlExecutionPipeline
} from './ProductionAgentControlExecutionPipelineFactory.js';
import { AgentInboxPublicCommandHandler } from './AgentInboxPublicCommandHandler.js';
import { AgentSubagentInterruptPublicCommandHandler } from './AgentSubagentInterruptPublicCommandHandler.js';
import {
  createHumanSkillCommandOwners,
  HumanSkillPublicCommandHandler
} from './HumanSkillPublicCommandHandler.js';
import type { HumanSkillCatalog } from '../control/ports/HumanSkillCatalog.js';
import {
  createProductivityCommandOwners,
  ProductivityPublicCommandHandler
} from './ProductivityPublicCommandHandler.js';
import {
  type AgentPublicCommandOwner,
  type AgentPublicCommandOwnerTable
} from './agent-entity/command-owners/AgentPublicCommandOwnerTable.js';
import {
  agentEntityCommandComponent,
  compileAgentEntityCommandManifest
} from './agent-entity/AgentEntityCompiler.js';
import {
  createAgentConversationComponent,
  type AgentConversationComponentHandle
} from './agent-entity/components/conversation/AgentConversationComponent.js';
import {
  createAgentRunControlComponent,
  type AgentRunControlComponentHandle
} from './agent-entity/components/run-control/AgentRunControlComponent.js';
import {
  createAgentToolResultDetailComponent,
  type AgentToolResultDetailComponentHandle
} from './agent-entity/components/tool-result-detail/AgentToolResultDetailComponent.js';

export interface AgentControlPublicCommandRouterOptions {
  readonly authorizedWorkspaceIds?: readonly string[];
  readonly conversationCommandNow?: () => Date;
  readonly agentDecisionCommandNow?: () => Date;
  readonly agentInboxCommandNow?: () => Date;
  readonly attachmentStore?: ConversationAttachmentStore;
  readonly humanSkillCatalog?: HumanSkillCatalog;
  readonly productivityStore?: SqliteProductivityStore;
}

export interface AgentControlPublicCommandRouterCallbacks {
  readonly wakeProjectionDrain: () => void;
  readonly projectionCommandOwners: readonly AgentPublicCommandOwner[];
}

/**
 * Owns the public command surface and its domain-error translation.
 * Runtime lifecycle, projection scheduling and store ownership stay outside.
 */
export class AgentControlPublicCommandRouter {
  private readonly conversationComponent: AgentConversationComponentHandle;
  private readonly runControlComponent: AgentRunControlComponentHandle;
  private readonly toolResultDetailComponent: AgentToolResultDetailComponentHandle;
  private readonly agentInbox: AgentInboxPublicCommandHandler;
  private readonly subagentInterrupt: AgentSubagentInterruptPublicCommandHandler;
  private readonly humanSkills: HumanSkillPublicCommandHandler | undefined;
  private readonly productivity: ProductivityPublicCommandHandler | undefined;
  private readonly ownerTable: AgentPublicCommandOwnerTable;

  public constructor(
    unitOfWork: SqliteAgentRunUnitOfWork,
    conversation: SqliteConversationRunHandoffUnitOfWork,
    private readonly executionPipeline: AgentControlExecutionPipeline | undefined,
    callbacks: AgentControlPublicCommandRouterCallbacks,
    options: AgentControlPublicCommandRouterOptions = {}
  ) {
    this.conversationComponent = createAgentConversationComponent({
      conversation,
      executionPipeline,
      wakeProjectionDrain: callbacks.wakeProjectionDrain,
      options: {
        authorizedWorkspaceIds: options.authorizedWorkspaceIds,
        commandNow: options.conversationCommandNow,
        attachmentStore: options.attachmentStore
      }
    });
    this.runControlComponent = createAgentRunControlComponent({
      unitOfWork,
      executionPipeline,
      wakeProjectionDrain: callbacks.wakeProjectionDrain,
      decisionCommandNow: options.agentDecisionCommandNow
    });
    this.toolResultDetailComponent = createAgentToolResultDetailComponent({
      executionPipeline,
      authorizedWorkspaceIds: options.authorizedWorkspaceIds
    });
    this.agentInbox = new AgentInboxPublicCommandHandler(unitOfWork, {
      wakeWorkScheduler: () => this.executionPipeline?.runWorkScheduler.wake(),
      wakeProjectionDrain: callbacks.wakeProjectionDrain
    }, options.agentInboxCommandNow);
    this.subagentInterrupt = new AgentSubagentInterruptPublicCommandHandler(
      unitOfWork,
      executionPipeline,
      callbacks.wakeProjectionDrain
    );
    this.humanSkills = options.humanSkillCatalog === undefined
      ? undefined
      : new HumanSkillPublicCommandHandler(
          options.humanSkillCatalog,
          options.authorizedWorkspaceIds ?? []
        );
    this.productivity = options.productivityStore === undefined
      ? undefined
      : new ProductivityPublicCommandHandler(
          options.productivityStore,
          conversation,
          options.authorizedWorkspaceIds ?? []
        );
    this.ownerTable = compileAgentEntityCommandManifest([
      agentEntityCommandComponent(
        'agent.conversation', this.conversationComponent.commandOwners()
      ),
      agentEntityCommandComponent(
        'agent.run-control', this.runControlComponent.commandOwners()
      ),
      agentEntityCommandComponent(
        'agent.tool-result-detail', this.toolResultDetailComponent.commandOwners()
      ),
      agentEntityCommandComponent('agent.inbox', this.agentInbox.commandOwners()),
      agentEntityCommandComponent(
        'agent.subagent-interrupt', this.subagentInterrupt.commandOwners()
      ),
      agentEntityCommandComponent('agent.skills-human', createHumanSkillCommandOwners(
        this.humanSkills
      )),
      agentEntityCommandComponent('agent.productivity', createProductivityCommandOwners(
        this.productivity
      )),
      agentEntityCommandComponent('agent.projection', callbacks.projectionCommandOwners)
    ]).ownerTable;
  }

  public async executeOwnedCommand(
    envelope: RuntimeCommandEnvelope
  ): Promise<RuntimeApplicationCommandResult | null> {
    return this.ownerTable.execute(envelope);
  }

  public async reconcileUncertainCommand(
    envelope: RuntimeCommandEnvelope
  ): Promise<RuntimeCommandReconciliation | null> {
    return this.ownerTable.reconcile(envelope);
  }

}
