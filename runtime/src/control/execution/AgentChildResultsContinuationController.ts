import {
  AgentRunCommandService,
  AgentRunInvariantError,
  AgentRunVersionConflictError,
  DefaultAgentChildResultsContinuationPlanner,
  assertValidAgentRun,
  type AgentRunRecoveryPayloadReader,
  type AgentRunUnitOfWork,
  type ReadyResumableAgentRunRecovery
} from '@ariadne/agent-core';

export interface AgentChildTerminalContentResolver {
  resolveTerminalAssistantContent(
    run: import('@ariadne/agent-core').AgentRun
  ): Promise<string>;
}

export interface AgentChildResultsContinuationReceiptV1 {
  readonly receiptVersion: 1;
  readonly commandId: string;
  readonly runId: string;
  readonly runVersion: number;
  readonly turnId: string;
  readonly attemptId: string;
  readonly replayed: boolean;
}

/** Turns durable terminal child evidence into the parent's next model Turn. */
export class AgentChildResultsContinuationController {
  private readonly commands: AgentRunCommandService;
  private readonly planner = new DefaultAgentChildResultsContinuationPlanner();

  public constructor(
    private readonly runs: AgentRunUnitOfWork,
    private readonly payloads: AgentRunRecoveryPayloadReader,
    private readonly terminalContent: AgentChildTerminalContentResolver
  ) {
    this.commands = new AgentRunCommandService(runs);
  }

  public async continueChildResults(
    recovery: ReadyResumableAgentRunRecovery,
    signal: AbortSignal
  ): Promise<AgentChildResultsContinuationReceiptV1> {
    signal.throwIfAborted();
    const authority = await this.runs.transaction(async (transaction) => {
      const run = await transaction.loadRun(recovery.run.runId);
      if (run === null) return null;
      if (transaction.listDelegationsByParent === undefined) {
        throw invariant('SubAgent continuation has no Delegation authority.');
      }
      const delegations = await transaction.listDelegationsByParent(run.runId);
      const children = await Promise.all(delegations.map(async (delegation) => ({
        delegation,
        run: await transaction.loadRun(delegation.childRunId)
      })));
      return { run, children };
    });
    if (authority === null) throw invariant('The SubAgent parent Run does not exist.');
    const { run, children } = authority;
    if (run.version !== recovery.run.version) {
      throw new AgentRunVersionConflictError(run.runId, recovery.run.version, run.version);
    }
    assertValidAgentRun(run);
    const sourceTurn = run.turns.at(-1);
    const sourceAttempt = sourceTurn?.attempts.at(-1);
    if (
      run.state.status !== 'running'
      || sourceTurn === undefined
      || sourceAttempt?.state.status !== 'succeeded'
      || (sourceAttempt.state.directive.kind !== 'delegate_subagent'
        && sourceAttempt.state.directive.kind !== 'delegate_subagents')
    ) throw invariant('SubAgent continuation requires one settled child batch.');
    const directive = sourceAttempt.state.directive;
    const delegated = directive.kind === 'delegate_subagent'
      ? [directive]
      : directive.delegations;
    const exactChildren = delegated.map((delegation) => children.find((item) => (
      item.delegation.delegationId === delegation.delegationId
      && item.delegation.childRunId === delegation.childRunId
    )));
    if (exactChildren.some((exact) => {
      const child = exact?.run;
      return exact === undefined
        || exact.delegation.terminal === null
        || child == null
        || child.version !== exact.delegation.terminal.childRunVersion
        || child.state.status !== exact.delegation.terminal.childStatus
        || (child.state.status !== 'completed'
          && child.state.status !== 'failed'
          && child.state.status !== 'cancelled');
    })) throw invariant('SubAgent continuation child terminal evidence is incomplete.');
    const sourceReference = recovery.turnInputPayloads.find(
      (reference) => reference.turnId === sourceTurn.turnId
    );
    if (
      sourceReference === undefined
      || sourceReference.runId !== run.runId
      || sourceReference.inputDigest !== sourceTurn.intention.inputDigest
    ) throw invariant('SubAgent continuation is missing its protected parent Turn input.');
    const [sourceTurnInput, contents] = await Promise.all([
      this.payloads.loadTurnInputPayload(sourceReference),
      Promise.all(exactChildren.map((exact) =>
        this.terminalContent.resolveTerminalAssistantContent(exact!.run!)
      ))
    ]);
    signal.throwIfAborted();
    const plan = await this.planner.plan({
      run,
      sourceTurnInput,
      results: exactChildren.map((exact, index) => ({
        delegationId: exact!.delegation.delegationId,
        childRunId: exact!.run!.runId,
        childRunVersion: exact!.run!.version,
        status: exact!.run!.state.status as 'completed' | 'failed' | 'cancelled',
        content: contents[index]!
      }))
    });
    const committed = await this.commands.execute(plan.command, plan.artifacts);
    const turn = committed.run.turns.find(
      (candidate) => candidate.turnId === plan.command.turn.turnId
    );
    const attempt = turn?.attempts.find(
      (candidate) => candidate.attemptId === plan.command.turn.attemptId
    );
    if (
      turn?.intention.cause.kind !== 'child_results'
      || attempt?.state.status !== 'intended'
    ) throw invariant('SubAgent continuation returned a contradictory Turn receipt.');
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
