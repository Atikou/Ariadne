import {
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  type RuntimeResult
} from '@ariadne/protocol/public';

import {
  AgentRunPublicProjectionPublisher,
  type AgentRunPublicProjectionPublisherOptions
} from '../../../../projection/AgentRunPublicProjectionPublisher.js';
import {
  ConversationPublicProjectionPublisher,
  type ConversationPublicProjectionPublisherOptions
} from '../../../../projection/ConversationPublicProjectionPublisher.js';
import {
  ModelCatalogPublicProjectionPublisher,
  type ModelCatalogPublicProjectionPublisherOptions
} from '../../../../projection/ModelCatalogPublicProjectionPublisher.js';
import type {
  ModelCatalogProjectionSource
} from '../../../../projection/ModelCatalogProjectionPorts.js';
import type { RuntimePublicEventSink } from '../../../../ingress/RuntimePublicEventSink.js';
import type {
  RuntimeApplicationCommandResult
} from '../../../../ingress/RuntimeApplication.js';
import type { RuntimeCommandEnvelope } from '../../../../ingress/RuntimeIngress.js';
import type { ShutdownContext } from '../../../../ingress/ShutdownContext.js';
import { ConversationAgentResultProjectionService } from '../../../../control/conversation/ConversationAgentResultProjectionService.js';
import { ConversationAgentResultCoordinator } from '../../../ConversationAgentResultCoordinator.js';
import { AgentTerminalResultCoordinator } from '../../../AgentTerminalResultCoordinator.js';
import { ProtectedAgentTerminalAssistantContentResolver } from '../../../ProtectedAgentTerminalAssistantContentResolver.js';
import { ProtectedAgentRunInteractionMessageResolver } from '../../../ProtectedAgentRunInteractionMessageResolver.js';
import {
  PublicProjectionWakeCommitSink,
  PublicProjectionWakePublisher
} from '../../../PublicProjectionWakeCommitSink.js';
import { createAgentRunVersionReader } from '../../../AgentControlRuntimeCompositionSupport.js';
import { completedPublicError } from '../../../AgentPublicCommandFailures.js';
import type {
  AgentControlExecutionPipeline
} from '../../../ProductionAgentControlExecutionPipelineFactory.js';
import type { AgentPersistenceComponentHandle } from '../persistence/AgentPersistenceComponent.js';

const DEFAULT_PUBLIC_PROJECTION_INTERVAL_MS = 50;
const EMPTY_MODEL_CATALOG: ModelCatalogProjectionSource = Object.freeze({
  snapshot: () => Object.freeze([])
});

export interface AgentProjectionComponentOptions {
  readonly publishIntervalMs?: number;
  readonly publisher?: Omit<
    AgentRunPublicProjectionPublisherOptions,
    'terminalResultSink' | 'interactionResolver' | 'toolPresentationResolver'
  >;
  readonly conversationPublisher?: ConversationPublicProjectionPublisherOptions;
  readonly modelPublisher?: ModelCatalogPublicProjectionPublisherOptions;
  readonly conversationCommandNow?: () => Date;
}

export interface AgentProjectionComponentInput {
  readonly persistence: AgentPersistenceComponentHandle;
  readonly options?: AgentProjectionComponentOptions;
  readonly executionPipeline?: AgentControlExecutionPipeline;
  readonly modelCatalog?: ModelCatalogProjectionSource;
  readonly wakeEventSink?: RuntimePublicEventSink;
}

export interface AgentProjectionComponentHandle {
  readonly conversationCommandNow: () => Date;
  drainPending(): Promise<void>;
  wake(): void;
  activate(): void;
  beginShutdown(context: ShutdownContext): void;
  settleAndDrain(context: ShutdownContext, drainBeforeFreeze: boolean): Promise<void>;
  completeShutdown(): void;
  fail(error: unknown): void;
  assertHealthy(): void;
  executeCommand(envelope: RuntimeCommandEnvelope): Promise<RuntimeApplicationCommandResult>;
}

/** Required Agent component that owns Projection publication and fixed-point lifecycle. */
export function createAgentProjectionComponent(
  input: AgentProjectionComponentInput
): AgentProjectionComponentHandle {
  return new DefaultAgentProjectionComponent(input);
}

class DefaultAgentProjectionComponent implements AgentProjectionComponentHandle {
  public readonly conversationCommandNow: () => Date;
  private readonly agentPublisher: AgentRunPublicProjectionPublisher;
  private readonly conversationPublisher: ConversationPublicProjectionPublisher;
  private readonly modelPublisher: ModelCatalogPublicProjectionPublisher;
  private readonly publicProjection: AgentPersistenceComponentHandle['publicProjection'];
  private readonly publishIntervalMs: number;
  private lifecycle: 'starting' | 'running' | 'failed' | 'stopping' | 'stopped' = 'starting';
  private timer?: NodeJS.Timeout;
  private activeDrain: Promise<void> | null = null;
  private drainRequested = false;
  private healthFailure: unknown;
  private shutdownContext: ShutdownContext | null = null;

  public constructor(input: AgentProjectionComponentInput) {
    const options = input.options ?? {};
    const { unitOfWork, conversation, publicProjection } = input.persistence;
    this.publicProjection = publicProjection;
    this.publishIntervalMs = options.publishIntervalMs
      ?? DEFAULT_PUBLIC_PROJECTION_INTERVAL_MS;
    assertPublishInterval(this.publishIntervalMs);
    this.conversationCommandNow = options.conversationCommandNow ?? (() => new Date());
    const projectionSink = input.wakeEventSink === undefined
      ? publicProjection
      : new PublicProjectionWakeCommitSink(publicProjection, input.wakeEventSink);
    const projectionWakePublisher = input.wakeEventSink === undefined
      ? undefined
      : new PublicProjectionWakePublisher(input.wakeEventSink);
    const conversationTerminalResults = new ConversationAgentResultCoordinator(
      conversation,
      new ConversationAgentResultProjectionService(conversation),
      new ProtectedAgentTerminalAssistantContentResolver(unitOfWork),
      this.conversationCommandNow
    );
    this.agentPublisher = new AgentRunPublicProjectionPublisher(
      unitOfWork,
      createAgentRunVersionReader(unitOfWork),
      projectionSink,
      {
        ...options.publisher,
        terminalResultSink: new AgentTerminalResultCoordinator(
          unitOfWork,
          conversationTerminalResults
        ),
        interactionResolver: new ProtectedAgentRunInteractionMessageResolver(unitOfWork),
        toolPresentationResolver: input.executionPipeline?.toolPresentationResolver
      }
    );
    this.conversationPublisher = new ConversationPublicProjectionPublisher(
      conversation,
      projectionSink,
      options.conversationPublisher
    );
    this.modelPublisher = new ModelCatalogPublicProjectionPublisher(
      input.modelCatalog ?? EMPTY_MODEL_CATALOG,
      publicProjection,
      options.modelPublisher,
      projectionWakePublisher === undefined
        ? undefined
        : (commit) => projectionWakePublisher.publish(commit)
    );
  }

  public drainPending(): Promise<void> {
    this.drainRequested = true;
    if (this.activeDrain !== null) return this.activeDrain;
    const operation = this.drainRequests();
    this.activeDrain = operation;
    return operation;
  }

  public wake(): void {
    if (this.lifecycle !== 'running' || this.healthFailure !== undefined) return;
    this.drainRequested = true;
    void this.drainPending().catch((error) => this.fail(error));
  }

  public activate(): void {
    if (this.lifecycle !== 'starting') {
      throw new Error('agent_projection_component_activation_invalid');
    }
    if (this.healthFailure !== undefined) throw projectionHealthError(this.healthFailure);
    this.lifecycle = 'running';
    this.timer = setInterval(() => {
      if (this.activeDrain === null) this.wake();
    }, this.publishIntervalMs);
    this.timer.unref?.();
  }

  public beginShutdown(context: ShutdownContext): void {
    if (this.lifecycle === 'stopped') {
      context.throwIfExpired();
      return;
    }
    this.lifecycle = 'stopping';
    this.shutdownContext = context;
    this.stopTimer();
  }

  public async settleAndDrain(
    context: ShutdownContext,
    drainBeforeFreeze: boolean
  ): Promise<void> {
    try {
      context.throwIfExpired();
      if (this.activeDrain !== null) await this.activeDrain;
      context.throwIfExpired();
      if (drainBeforeFreeze && this.healthFailure === undefined) {
        await this.drainPending();
      }
      context.throwIfExpired();
    } catch (error) {
      this.fail(error);
      throw projectionHealthError(error);
    }
  }

  public completeShutdown(): void {
    this.stopTimer();
    this.shutdownContext = null;
    this.lifecycle = 'stopped';
  }

  public fail(error: unknown): void {
    if (this.healthFailure === undefined) this.healthFailure = error;
    this.stopTimer();
    if (this.lifecycle !== 'stopping' && this.lifecycle !== 'stopped') {
      this.lifecycle = 'failed';
    }
  }

  public assertHealthy(): void {
    if (this.healthFailure !== undefined) throw projectionHealthError(this.healthFailure);
    if (this.lifecycle !== 'running') {
      throw new Error('agent_control_public_projection_not_running');
    }
  }

  public executeCommand(
    envelope: RuntimeCommandEnvelope
  ): Promise<RuntimeApplicationCommandResult> {
    if (envelope.command.kind === 'projection.snapshot.get') {
      if (envelope.command.contractVersion !== PUBLIC_PROJECTION_CONTRACT_VERSION) {
        throw new Error('public_projection_contract_version_mismatch');
      }
      return this.executeQuery(envelope, async () => ({
        kind: 'projection.snapshot' as const,
        snapshot: await this.publicProjection.snapshot()
      }));
    }
    if (envelope.command.kind === 'projection.commits.read') {
      const request = envelope.command.request;
      return this.executeQuery(envelope, async () => ({
        kind: 'projection.commits' as const,
        batch: await this.publicProjection.read(request)
      }));
    }
    throw new Error('agent_command_owner_kind_mismatch:projection.query');
  }

  private async executeQuery(
    envelope: RuntimeCommandEnvelope,
    query: () => Promise<RuntimeResult>
  ): Promise<RuntimeApplicationCommandResult> {
    envelope.signal.throwIfAborted();
    try {
      const result = await query();
      envelope.signal.throwIfAborted();
      return { outcome: { ok: true, result }, settlement: 'completed' };
    } catch (error) {
      if (envelope.signal.aborted) throw error;
      this.fail(error);
      return completedPublicError(
        envelope,
        'public_projection_unavailable',
        'The authoritative public projection is unavailable.',
        false
      );
    }
  }

  private async drainRequests(): Promise<void> {
    try {
      do {
        this.drainRequested = false;
        await this.publishUntilEmpty();
      } while (this.drainRequested);
    } finally {
      this.activeDrain = null;
    }
  }

  private async publishUntilEmpty(): Promise<void> {
    while (true) {
      this.shutdownContext?.throwIfExpired();
      const modelResult = await this.modelPublisher.publishPending();
      this.shutdownContext?.throwIfExpired();
      const conversationResult = await this.conversationPublisher.publishPending();
      this.shutdownContext?.throwIfExpired();
      const agentResult = await this.agentPublisher.publishPending();
      this.shutdownContext?.throwIfExpired();
      if (
        modelResult.publishedChanges === 0
        && conversationResult.readRecords === 0
        && agentResult.claimedMessages === 0
      ) return;
      await Promise.resolve();
    }
  }

  private stopTimer(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}

export function projectionHealthError(cause: unknown): Error {
  return new Error('agent_control_public_projection_unhealthy', { cause });
}

function assertPublishInterval(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 60_000) {
    throw new Error('agent_control_public_projection_interval_invalid');
  }
}
