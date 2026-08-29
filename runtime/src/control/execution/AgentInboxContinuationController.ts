import {
  AgentRunCommandService,
  AgentRunInvariantError,
  AgentRunVersionConflictError,
  DefaultAgentInboxContinuationPlanner,
  assertValidAgentRun,
  type AgentDirectivePayloadLookup,
  type AgentDirectivePayloadReader,
  type AgentInferenceAttempt,
  type AgentCommittedDirective,
  type AgentRunRecoveryPayloadReader,
  type AgentRun,
  type AgentRunUnitOfWork,
  type ReadyResumableAgentRunRecovery
} from '@ariadne/agent-core';
import {
  parseProtectedAgentUserQuestion,
  renderProtectedAgentUserQuestion
} from '../../conversation/ProtectedAgentUserQuestion.js';

export interface AgentInboxContinuationReceiptV1 {
  readonly receiptVersion: 1;
  readonly commandId: string;
  readonly runId: string;
  readonly runVersion: number;
  readonly turnId: string;
  readonly attemptId: string;
  readonly replayed: boolean;
}

const INTERRUPTED_INFERENCE_NOTICE =
  'The previous assistant generation was interrupted before any response was committed.';

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
      (run.state.status !== 'running' && run.state.status !== 'waiting_input')
      || sourceTurn === undefined
      || sourceAttempt === undefined
    ) throw invalid('Agent inbox continuation has no valid source boundary.');
    const interrupted = run.state.status === 'waiting_input'
      && 'recoveryDecisionId' in run.state;
    if (interrupted) {
      if (
        sourceTurn.turnId !== run.state.interruptedTurnId
        || sourceAttempt.attemptId !== run.state.interruptedAttemptId
        || sourceAttempt.state.status !== 'uncertain'
        || sourceAttempt.state.recovery.decisionId !== run.state.recoveryDecisionId
      ) throw invalid('Agent inbox continuation interruption authority drifted.');
    } else if (
      sourceAttempt.state.status !== 'succeeded'
      || (sourceAttempt.state.directive.kind !== 'respond'
        && sourceAttempt.state.directive.kind !== 'complete'
        && sourceAttempt.state.directive.kind !== 'ask_user')
    ) throw invalid('Agent inbox continuation is not at a settled response boundary.');
    const sourceReference = recovery.turnInputPayloads.find(
      (reference) => reference.turnId === sourceTurn.turnId
    );
    if (sourceReference === undefined) {
      throw invalid('Agent inbox continuation is missing its protected source Turn.');
    }
    const sourceTurnInput = await this.payloads.loadTurnInputPayload(sourceReference);
    signal.throwIfAborted();
    const succeededAttempt = interrupted ? null : requireSucceededAttempt(sourceAttempt);
    const boundary = interrupted
      ? {
          kind: 'interrupted_inference' as const,
          interruptionNotice: INTERRUPTED_INFERENCE_NOTICE
        }
      : {
          kind: 'settled_response' as const,
          assistantContent: await resolveAssistantContent(
            run.runId,
            succeededAttempt!.state.directiveDigest,
            requireResponseDirective(succeededAttempt!.state.directive),
            this.payloads
          )
        };
    const plan = await this.planner.plan({
      run,
      sourceTurnInput,
      boundary,
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
      (turn?.intention.cause.kind !== 'inbox_inputs'
        && turn?.intention.cause.kind !== 'interrupted_inference')
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

function requireResponseDirective(
  directive: AgentCommittedDirective
): Extract<
  AgentCommittedDirective,
  { readonly kind: 'respond' | 'complete' | 'ask_user' }
> {
  if (
    directive.kind !== 'respond'
    && directive.kind !== 'complete'
    && directive.kind !== 'ask_user'
  ) {
    throw invalid('Agent inbox continuation response Directive is unavailable.');
  }
  return directive;
}

function requireSucceededAttempt(
  attempt: AgentInferenceAttempt
): AgentInferenceAttempt & {
  readonly state: Extract<AgentInferenceAttempt['state'], { readonly status: 'succeeded' }>;
} {
  if (attempt.state.status !== 'succeeded') {
    throw invalid('Agent inbox continuation succeeded response is unavailable.');
  }
  return attempt as AgentInferenceAttempt & {
    readonly state: Extract<AgentInferenceAttempt['state'], { readonly status: 'succeeded' }>;
  };
}

async function resolveAssistantContent(
  runId: string,
  directiveDigest: string,
  directive: Extract<
    AgentCommittedDirective,
    { readonly kind: 'respond' | 'complete' | 'ask_user' }
  >,
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
  } else if (directive.kind === 'ask_user') {
    reference = {
      runId,
      artifactId: directive.questionRef,
      kind: 'user_question',
      directiveDigest,
      contentDigest: directive.questionDigest
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
  if (directive.kind === 'ask_user') {
    return renderProtectedAgentUserQuestion(parseProtectedAgentUserQuestion(content));
  }
  if (typeof content !== 'string' || content.length === 0 || content.length > 1_048_576) {
    throw invalid('Protected Agent response content is invalid.');
  }
  return content;
}

function invalid(message: string): AgentRunInvariantError {
  return new AgentRunInvariantError(message);
}
