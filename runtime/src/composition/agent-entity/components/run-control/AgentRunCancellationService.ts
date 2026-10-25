import { AgentPlanBudgetChildRunService, AgentRunCommandService, AgentRunVersionConflictError, deriveStableAgentId, type AgentRun } from '@ariadne/agent-core';
import type { SqliteAgentRunUnitOfWork } from '../../../../adapters/persistence/SqliteAgentRunUnitOfWork.js';
import type { RuntimeCommandEnvelope } from '../../../../ingress/RuntimeIngress.js';
import type { ShutdownContext } from '../../../../ingress/ShutdownContext.js';
import type { AgentInferenceCancellationEngines, AgentRunCancellationOwner, AgentRunCancellationReceipt } from './AgentRunCancellationContracts.js';
import { cancelActiveAgentInference } from './AgentActiveInferenceCancellation.js';
import { AgentRequiredChildCancellationWorker } from './AgentRequiredChildCancellationWorker.js';

type CancelCommand = Extract<RuntimeCommandEnvelope['command'], { readonly kind: 'agent.run.cancel' }>;

/** One cancellation owner shared by public commands and durable required-child recovery. */
export class AgentRunCancellationService implements AgentRunCancellationOwner {
  private readonly commands: AgentRunCommandService;
  private readonly children: AgentPlanBudgetChildRunService;
  private readonly worker: AgentRequiredChildCancellationWorker;
  public constructor(private readonly unit: SqliteAgentRunUnitOfWork,
    private readonly engines?: AgentInferenceCancellationEngines) {
    this.commands = new AgentRunCommandService(unit);
    this.children = new AgentPlanBudgetChildRunService(unit);
    this.worker = new AgentRequiredChildCancellationWorker(unit, (id, command) => this.cancel(id, command),
      run => this.continueEffectCancellation(run));
  }
  public start(wakeProjection: () => void): Promise<void> { return this.worker.start(wakeProjection); }
  public wake(): void { this.worker.wake(); }
  public assertHealthy(): void { this.worker.assertHealthy(); }
  public prepareShutdown(context: ShutdownContext): Promise<void> { return this.worker.stop(context); }

  public async cancel(commandId: string, command: CancelCommand): Promise<AgentRunCancellationReceipt> {
    const replay = await this.replay(commandId, command.runId);
    if (replay !== null) return replay;
    const current = await this.unit.transaction(transaction => transaction.loadRun(command.runId));
    if (current !== null && (current.cancellationRequest !== undefined
      || current.effects.some(effect => effect.state.status === 'started' || effect.state.status === 'uncertain'))) {
      const result = await this.commands.execute({ kind: 'run.request_cancellation', commandId, runId: command.runId,
        expectedVersion: command.expectedVersion, occurredAt: command.occurredAt, reason: command.reason
      }, { turnInputPayloads: [], effectPayloads: [] });
      this.wake();
      return receipt(result.run);
    }
    if (current?.state.status === 'waiting_children' || current?.state.status === 'cancelling') {
      const result = await this.children.requestParentCancellation({ kind: 'control.children.request_parent_cancellation',
        commandId, runId: command.runId, expectedVersion: command.expectedVersion, occurredAt: command.occurredAt,
        reason: command.reason });
      const parent = result.mutations[0]?.run;
      if (parent === undefined) throw new Error('agent_parent_cancellation_receipt_missing');
      this.wake();
      return receipt(parent);
    }
    const activeVersion = await cancelActiveAgentInference(this.unit, this.commands, this.engines, commandId, command);
    if (activeVersion !== null) return { status: 'cancelled', runId: command.runId, runVersion: activeVersion };
    const recovery = current?.state;
    const recoveryDecisionId = recovery?.status === 'recovering' && recovery.reason === 'uncertain_inference'
      ? current?.turns.find(turn => turn.turnId === recovery.turnId)?.attempts
        .find(attempt => attempt.attemptId === recovery.attemptId)?.state : undefined;
    const committed = await this.commands.execute({ kind: 'run.cancel', commandId, runId: command.runId,
      expectedVersion: command.expectedVersion, occurredAt: command.occurredAt, reason: command.reason,
      ...(recoveryDecisionId?.status === 'uncertain' ? { recoveryDecisionId: recoveryDecisionId.recovery.decisionId } : {})
    }, { turnInputPayloads: [], effectPayloads: [] });
    return receipt(committed.run);
  }

  private async continueEffectCancellation(run: AgentRun): Promise<void> {
    if (run.cancellationRequest === undefined) return;
    for (const effect of run.effects) {
      if (effect.state.status === 'started') await this.engines?.effects?.cancelActiveEffect(run.runId, effect.effectId);
    }
    const latest = await this.unit.transaction(transaction => transaction.loadRun(run.runId));
    if (latest === null) throw new Error('agent_effect_cancellation_run_missing');
    if (['cancelled', 'completed', 'failed'].includes(latest.state.status)
      || latest.effects.some(effect => effect.state.status === 'started' || effect.state.status === 'uncertain')) return;
    const intent = latest.cancellationRequest;
    if (intent === undefined) throw new Error('agent_effect_cancellation_intent_missing');
    const commandId = await deriveStableAgentId('effect-cancellation-complete', intent.commandId, String(latest.version));
    try {
      await this.commands.execute({ kind: 'run.cancel', commandId, runId: latest.runId, expectedVersion: latest.version,
        occurredAt: new Date(Math.max(Date.now(), Date.parse(latest.updatedAt))).toISOString(), reason: intent.reason
      }, { turnInputPayloads: [], effectPayloads: [] });
    } catch (error) { if (!(error instanceof AgentRunVersionConflictError)) throw error; }
  }

  private async replay(commandId: string, runId: string): Promise<AgentRunCancellationReceipt | null> {
    const committed = await this.unit.loadCommittedCommandReceipt(commandId);
    if (committed === null) return null;
    const mutation = committed.mutations[0];
    if (committed.commandId !== commandId || mutation === undefined || committed.mutations.length !== 1 || mutation.runId !== runId
      || mutation.run.runId !== runId || mutation.resultingVersion !== mutation.run.version
      || !mutation.events.some(event => event.payload.type === 'run.cancelled' || event.payload.type === 'run.cancellation_requested')
      || (mutation.run.state.status !== 'cancelled' && mutation.run.state.status !== 'cancelling'
        && mutation.run.cancellationRequest === undefined)) {
      throw new Error('agent_run_cancel_receipt_invalid');
    }
    return receipt(mutation.run);
  }
}

function receipt(run: AgentRun): AgentRunCancellationReceipt {
  if (run.state.status !== 'cancelled' && run.state.status !== 'cancelling' && run.cancellationRequest === undefined) throw new Error('agent_run_cancellation_state_invalid');
  return { status: run.state.status === 'cancelled' ? 'cancelled' : 'requested', runId: run.runId, runVersion: run.version };
}
