import {
  AgentRunCommandService,
  AgentRunInvariantError,
  AgentRunVersionConflictError,
  DefaultAgentInboxContinuationPlanner,
  assertValidAgentRun,
  type AgentDirectivePayloadLookup,
  type AgentDirectivePayloadReader,
  type AgentCommittedDirective,
  type AgentRunRecoveryPayloadReader,
  type AgentRunUnitOfWork,
  type ReadyResumableAgentRunRecovery
} from '@ariadne/agent-core';

export interface AgentInboxContinuationReceiptV1 {
  readonly receiptVersion: 1;
  readonly commandId: string;
  readonly runId: string;
  readonly runVersion: number;
  readonly turnId: string;
  readonly attemptId: string;
  readonly replayed: boolean;
}

export class AgentInboxContinuationController {
  private readonly commands: AgentRunCommandService;

  public constructor(
    private readonly runs: AgentRunUnitOfWork,
    private readonly payloads: AgentRunRecoveryPayloadReader & AgentDirectivePayloadReader,
    private readonly planner = new DefaultAgentInboxContinuationPlanner()
  ) {
    this.commands = new AgentRunCommandService(runs);
  }

  public async continueInbox(
    recovery: ReadyResumableAgentRunRecovery,
    inputIds: readonly string[],
    signal: AbortSignal
  ): Promise<AgentInboxContinuationReceiptV1> {
    signal.throwIfAborted();
    const run = await this.runs.transaction((transaction) => (
      transaction.loadRun(recovery.run.runId)
    ));
    if (run === null) throw invalid('Agent inbox continuation Run does not exist.');
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
      || (sourceAttempt.state.directive.kind !== 'respond'
        && sourceAttempt.state.directive.kind !== 'complete')
    ) throw invalid('Agent inbox continuation is not at a settled response boundary.');
    const sourceReference = recovery.turnInputPayloads.find(
      (reference) => reference.turnId === sourceTurn.turnId
    );
    if (sourceReference === undefined) {
      throw invalid('Agent inbox continuation is missing its protected source Turn.');
    }
    const sourceTurnInput = await this.payloads.loadTurnInputPayload(sourceReference);
    signal.throwIfAborted();
    const assistantContent = await resolveAssistantContent(
      run.runId,
      sourceAttempt.state.directiveDigest,
      sourceAttempt.state.directive,
      this.payloads
    );
    const plan = await this.planner.plan({
      run,
      sourceTurnInput,
      assistantContent,
      inputIds
    });
    signal.throwIfAborted();
    const committed = await this.commands.execute(plan.command, plan.artifacts);
    const turn = committed.run.turns.find(
      (candidate) => candidate.turnId === plan.command.turn.turnId
    );
    const attempt = turn?.attempts.find(
      (candidate) => candidate.attemptId === plan.command.turn.attemptId
    );
    if (
      turn?.intention.cause.kind !== 'inbox_inputs'
      || attempt?.state.status !== 'intended'
    ) throw invalid('Agent inbox continuation receipt is contradictory.');
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

async function resolveAssistantContent(
  runId: string,
  directiveDigest: string,
  directive: Extract<AgentCommittedDirective, { readonly kind: 'respond' | 'complete' }>,
  payloads: AgentDirectivePayloadReader
): Promise<string> {
  let reference: AgentDirectivePayloadLookup | null = null;
  if (directive.kind === 'respond') {
    reference = {
      runId,
      artifactId: directive.contentRef,
      kind: 'response_content',
      directiveDigest,
      contentDigest: directive.contentDigest
    };
  } else if (
    directive.kind === 'complete'
    && directive.outputRef !== undefined
    && directive.outputDigest !== undefined
  ) {
    reference = {
      runId,
      artifactId: directive.outputRef,
      kind: 'completion_output',
      directiveDigest,
      contentDigest: directive.outputDigest
    };
  }
  if (reference === null) return 'Task completed.';
  const content = await payloads.loadDirectivePayload(reference);
  if (typeof content !== 'string' || content.length === 0 || content.length > 1_048_576) {
    throw invalid('Protected Agent response content is invalid.');
  }
  return content;
}

function invalid(message: string): AgentRunInvariantError {
  return new AgentRunInvariantError(message);
}
