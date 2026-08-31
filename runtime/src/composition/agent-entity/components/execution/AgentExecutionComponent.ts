import type { SqliteAgentRunUnitOfWork } from '../../../../adapters/persistence/SqliteAgentRunUnitOfWork.js';
import type {
  SqliteConversationRunHandoffUnitOfWork
} from '../../../../adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import { AgentLiveWorkCompletionLifecycle } from '../../../../control/execution/AgentLiveWorkCompletionLifecycle.js';
import type { AgentControlLiveWorkService } from '../../../../control/ports/AgentLiveWork.js';
import type { ShutdownContext } from '../../../../ingress/ShutdownContext.js';
import type { AgentControlExecutionPipeline } from '../../../ProductionAgentControlExecutionPipelineFactory.js';

export interface AgentExecutionComponentInput {
  readonly unitOfWork: SqliteAgentRunUnitOfWork;
  readonly conversation: SqliteConversationRunHandoffUnitOfWork;
  readonly pipeline?: AgentControlExecutionPipeline;
  readonly liveWork?: AgentControlLiveWorkService;
  readonly wakeProjectionDrain: () => void;
}

export interface AgentExecutionComponentHandle {
  readonly pipeline?: AgentControlExecutionPipeline;
  start(drainProjection: () => Promise<void>): Promise<void>;
  assertHealthy(): void;
  prepareShutdown(context: ShutdownContext): Promise<readonly unknown[]>;
}

export function createAgentExecutionComponent(
  input: AgentExecutionComponentInput
): AgentExecutionComponentHandle {
  return new DefaultAgentExecutionComponent(input);
}

class DefaultAgentExecutionComponent implements AgentExecutionComponentHandle {
  public readonly pipeline: AgentControlExecutionPipeline | undefined;
  private readonly liveWorkCompletion: AgentLiveWorkCompletionLifecycle | undefined;

  public constructor(private readonly input: AgentExecutionComponentInput) {
    this.pipeline = input.pipeline;
    this.liveWorkCompletion = input.liveWork === undefined
      ? undefined
      : new AgentLiveWorkCompletionLifecycle(input.liveWork, input.unitOfWork, {
          wakeWorkScheduler: () => input.pipeline?.runWorkScheduler.wake(),
          wakeProjectionDrain: input.wakeProjectionDrain
        });
  }

  public async start(drainProjection: () => Promise<void>): Promise<void> {
    if (this.pipeline === undefined) {
      await this.assertNoPendingExecutionAuthority();
      return;
    }
    await this.liveWorkCompletion?.reconcileStartup();
    await this.pipeline.executionScheduler.preflightStartupRecovery();
    await drainProjection();
    await this.pipeline.runWorkScheduler.start();
    this.pipeline.runWorkScheduler.assertHealthy();
    await this.pipeline.executionScheduler.start();
    this.pipeline.executionScheduler.assertHealthy();
    await this.pipeline.handoffProducer.start();
    this.pipeline.handoffProducer.assertHealthy();
  }

  public assertHealthy(): void {
    this.liveWorkCompletion?.assertHealthy();
    this.pipeline?.runWorkScheduler.assertHealthy();
    this.pipeline?.executionScheduler.assertHealthy();
    this.pipeline?.handoffProducer.assertHealthy();
  }

  public async prepareShutdown(context: ShutdownContext): Promise<readonly unknown[]> {
    const failures: unknown[] = [];
    if (this.pipeline !== undefined) {
      this.pipeline.observeRuntimeStop?.(new Date().toISOString());
      const schedulerStops: Promise<void>[] = [];
      try {
        context.throwIfExpired();
        schedulerStops.push(this.pipeline.runWorkScheduler.prepareShutdown(context));
      } catch (error) {
        failures.push(error);
      }
      try {
        context.throwIfExpired();
        schedulerStops.push(this.pipeline.executionScheduler.prepareShutdown(context));
      } catch (error) {
        failures.push(error);
      }
      for (const result of await Promise.allSettled(schedulerStops)) {
        if (result.status === 'rejected') failures.push(result.reason);
      }
      try {
        context.throwIfExpired();
        await this.pipeline.handoffProducer.prepareShutdown(context);
        context.throwIfExpired();
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      context.throwIfExpired();
      await this.liveWorkCompletion?.prepareShutdown(context.remainingMs());
      context.throwIfExpired();
    } catch (error) {
      failures.push(error);
    }
    return Object.freeze(failures);
  }

  private async assertNoPendingExecutionAuthority(): Promise<void> {
    if (await this.input.conversation.countPendingHandoffOutbox() !== 0) {
      throw new Error('conversation_agent_handoff_producer_required');
    }
    const executionRecovery = await this.input.unitOfWork.listExecutionIntentRecovery({
      limit: 1
    });
    if (executionRecovery.items.length !== 0) {
      throw new Error('agent_execution_scheduler_required');
    }
    const activeRuns = await this.input.unitOfWork.listActiveRuns({ limit: 1 });
    if (activeRuns.items.length !== 0) {
      throw new Error('agent_run_work_scheduler_required');
    }
  }
}
