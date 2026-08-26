import {
  AgentRunCommandService,
  AgentRunInvariantError,
  AgentRunVersionConflictError,
  DefaultAgentEffectContinuationPlanner,
  assertValidAgentRun,
  type AgentEffectContinuationPlanner,
  type AgentRunRecoveryPayloadReader,
  type AgentRunUnitOfWork,
  type AgentTerminalEffectResultEvidence,
  type ReadyResumableAgentRunRecovery
} from '@ariadne/agent-core';

export interface AgentEffectContinuationReceiptV1 {
  readonly receiptVersion: 1;
  readonly commandId: string;
  readonly runId: string;
  readonly runVersion: number;
  readonly turnId: string;
  readonly attemptId: string;
  readonly replayed: boolean;
}

/**
 * Converts one already-settled, unconsumed Tool batch into its next durable
 * Turn. It reads protected bodies just in time and delegates the final
 * authority proof to the transactional Unit of Work.
 */
export class AgentEffectContinuationController {
  private readonly commands: AgentRunCommandService;

  public constructor(
    private readonly runs: AgentRunUnitOfWork,
    private readonly payloads: AgentRunRecoveryPayloadReader,
    private readonly planner: AgentEffectContinuationPlanner =
      new DefaultAgentEffectContinuationPlanner()
  ) {
    this.commands = new AgentRunCommandService(runs);
  }

  public async continueSettledBatch(
    recovery: ReadyResumableAgentRunRecovery,
    signal: AbortSignal
  ): Promise<AgentEffectContinuationReceiptV1> {
    signal.throwIfAborted();
    const run = await this.runs.transaction((transaction) => (
      transaction.loadRun(recovery.run.runId)
    ));
    if (run === null) throw invariant('The Effect continuation Run does not exist.');
    if (run.version !== recovery.run.version) {
      throw new AgentRunVersionConflictError(
        run.runId,
        recovery.run.version,
        run.version
      );
    }
    assertValidAgentRun(run);
    if (run.state.status !== 'running') {
      throw invariant('Effect continuation requires a running AgentRun.');
    }
    const sourceTurn = run.turns.at(-1);
    const sourceAttempt = sourceTurn?.attempts.at(-1);
    if (
      sourceTurn === undefined
      || sourceAttempt?.state.status !== 'succeeded'
      || sourceAttempt.state.directive.kind !== 'invoke_tools'
    ) {
      throw invariant(
        'Effect continuation requires the latest succeeded Tool Directive.'
      );
    }
    const sourceReference = recovery.turnInputPayloads.find(
      (reference) => reference.turnId === sourceTurn.turnId
    );
    if (
      sourceReference === undefined
      || sourceReference.runId !== run.runId
      || sourceReference.inputDigest !== sourceTurn.intention.inputDigest
    ) {
      throw invariant('Effect continuation is missing its protected source Turn input.');
    }

    signal.throwIfAborted();
    const sourceTurnInput = await this.payloads.loadTurnInputPayload(sourceReference);
    const effectResults: AgentTerminalEffectResultEvidence[] = [];
    for (const invocation of sourceAttempt.state.directive.invocations) {
      const effect = run.effects.find(
        (candidate) => candidate.effectId === invocation.effectId
      );
      const reference = recovery.effectPayloads.find(
        (candidate) => candidate.effectId === invocation.effectId
      );
      if (
        effect === undefined
        || reference === undefined
        || effect.toolCallId !== invocation.toolCallId
        || reference.runId !== run.runId
        || reference.inputDigest !== effect.inputDigest
      ) {
        throw invariant('Effect continuation payload authority is incomplete or drifted.');
      }
      if (effect.state.status === 'cancelled') {
        if (reference.hasResult) {
          throw invariant('A cancelled Effect cannot expose a protected result row.');
        }
        effectResults.push({
          kind: 'aggregate_cancelled',
          runId: run.runId,
          effectId: effect.effectId,
          toolCallId: effect.toolCallId,
          inputDigest: effect.inputDigest,
          status: 'cancelled',
          reason: effect.state.reason
        });
        continue;
      }
      if (
        (effect.state.status !== 'succeeded' && effect.state.status !== 'failed')
        || !reference.hasResult
      ) {
        throw invariant('Effect continuation cannot consume a nonterminal Tool batch.');
      }
      signal.throwIfAborted();
      const result = await this.payloads.loadEffectResult(reference);
      effectResults.push({
        kind: 'protected_result',
        runId: run.runId,
        effectId: effect.effectId,
        toolCallId: effect.toolCallId,
        inputDigest: effect.inputDigest,
        status: effect.state.status,
        result
      });
    }

    signal.throwIfAborted();
    const plan = await this.planner.plan({ run, sourceTurnInput, effectResults });
    signal.throwIfAborted();
    const committed = await this.commands.execute(plan.command, plan.artifacts);
    const turn = committed.run.turns.find(
      (candidate) => candidate.turnId === plan.command.turn.turnId
    );
    const attempt = turn?.attempts.find(
      (candidate) => candidate.attemptId === plan.command.turn.attemptId
    );
    if (
      committed.run.runId !== run.runId
      || turn === undefined
      || attempt === undefined
      || turn.intention.cause.kind !== 'effect_results'
      || attempt.state.status !== 'intended'
    ) {
      throw invariant('Effect continuation commit returned a contradictory Turn receipt.');
    }
    return {
      receiptVersion: 1,
      commandId: committed.commandId,
      runId: committed.run.runId,
      runVersion: committed.run.version,
      turnId: turn.turnId,
      attemptId: attempt.attemptId,
      replayed: committed.replayed
    };
  }
}

function invariant(message: string): AgentRunInvariantError {
  return new AgentRunInvariantError(message);
}
