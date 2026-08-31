import {
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  type RuntimeResult
} from '@ariadne/protocol/public';

import type {
  SqliteAgentRunUnitOfWork
} from '../adapters/persistence/SqliteAgentRunUnitOfWork.js';
import type {
  SqliteConversationRunHandoffUnitOfWork
} from '../adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import type {
  SqlitePublicProjectionStore
} from '../adapters/persistence/SqlitePublicProjectionStore.js';
import type { SqliteProductivityStore } from '../adapters/persistence/SqliteProductivityStore.js';
import type {
  RuntimeApplicationCommandResult
} from '../ingress/RuntimeApplication.js';
import type { RuntimeCommandEnvelope } from '../ingress/RuntimeIngress.js';
import type {
  RuntimeCommandReconciliation
} from '../control/ports/RuntimeCommandJournal.js';
import type { ConversationAttachmentStore } from '../control/ports/ConversationAttachmentStore.js';
import type {
  AgentControlExecutionPipeline
} from './ProductionAgentControlExecutionPipelineFactory.js';
import { AgentInboxPublicCommandHandler } from './AgentInboxPublicCommandHandler.js';
import { AgentSubagentInterruptPublicCommandHandler } from './AgentSubagentInterruptPublicCommandHandler.js';
import { HumanSkillPublicCommandHandler } from './HumanSkillPublicCommandHandler.js';
import type { HumanSkillCatalog } from '../control/ports/HumanSkillCatalog.js';
import {
  ProductivityPublicCommandHandler
} from './ProductivityPublicCommandHandler.js';
import {
  compileAgentPublicCommandOwnerTable,
  type AgentPublicCommandOwnerTable
} from './agent-entity/command-owners/AgentPublicCommandOwnerTable.js';
import {
  createAgentPublicCommandOwners
} from './agent-entity/command-owners/AgentPublicCommandOwners.js';
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
  readonly executeProjectionQuery: (
    envelope: RuntimeCommandEnvelope,
    query: () => Promise<RuntimeResult>
  ) => Promise<RuntimeApplicationCommandResult>;
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
    private readonly publicProjection: SqlitePublicProjectionStore,
    private readonly executionPipeline: AgentControlExecutionPipeline | undefined,
    private readonly callbacks: AgentControlPublicCommandRouterCallbacks,
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
    this.ownerTable = compileAgentPublicCommandOwnerTable(
      createAgentPublicCommandOwners({
        conversation: this.conversationComponent,
        runControl: this.runControlComponent,
        toolResultDetail: this.toolResultDetailComponent,
        agentInbox: this.agentInbox,
        subagentInterrupt: this.subagentInterrupt,
        humanSkills: this.humanSkills,
        productivity: this.productivity,
        executeProjectionCommand: (envelope) => this.executeProjectionCommand(envelope),
        reconcileConversation: (envelope, invalidErrorCode) => (
          this.conversationComponent.reconcileCommitted(
            envelope,
            () => this.ownerTable.execute(envelope),
            invalidErrorCode
          )
        ),
        reconcileByReplay: (envelope, invalidErrorCode) => (
          this.reconcileByReplay(envelope, invalidErrorCode)
        )
      })
    );
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

  private async reconcileByReplay(
    envelope: RuntimeCommandEnvelope,
    invalidErrorCode: string
  ): Promise<RuntimeCommandReconciliation> {
    const result = await this.ownerTable.execute(envelope);
    if (result === null || result.settlement !== 'completed') {
      throw new Error(invalidErrorCode);
    }
    return result.outcome.ok
      ? { kind: 'committed', outcome: result.outcome }
      : { kind: 'not_committed' };
  }

  private async executeProjectionCommand(
    envelope: RuntimeCommandEnvelope
  ): Promise<RuntimeApplicationCommandResult> {
    if (envelope.command.kind === 'projection.snapshot.get') {
      if (envelope.command.contractVersion !== PUBLIC_PROJECTION_CONTRACT_VERSION) {
        throw new Error('public_projection_contract_version_mismatch');
      }
      return this.callbacks.executeProjectionQuery(envelope, async () => ({
        kind: 'projection.snapshot' as const,
        snapshot: await this.publicProjection.snapshot()
      }));
    }
    if (envelope.command.kind === 'projection.commits.read') {
      const request = envelope.command.request;
      return this.callbacks.executeProjectionQuery(envelope, async () => ({
        kind: 'projection.commits' as const,
        batch: await this.publicProjection.read(request)
      }));
    }
    throw new Error('agent_command_owner_kind_mismatch:projection.query');
  }

}
