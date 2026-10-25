import { planApprovalInputContent, isExactPlanApprovalInput } from '../domain/inbox.js';
import type { AgentRun } from '../domain/agent-run.js';
import type { AgentInboxInput } from '../domain/inbox.js';
import type { PlanDecisionDraft } from '../domain/decision.js';
import { sha256AgentControlData } from './control-command-digest.js';

export interface PlanApprovalInput {
  readonly inputId: string;
  readonly messageId: string;
  readonly content: string;
  readonly contentDigest: string;
}

export function isPlanApprovalInput(run: AgentRun, input: AgentInboxInput): boolean {
  return run.turns.some(turn => turn.attempts.some(attempt =>
    attempt.state.status === 'succeeded' && attempt.state.directive.kind === 'request_decision'
    && isExactPlanApprovalInput(input, attempt.state.directive.decision)));
}

export function hasExactApprovedPlanBoundary(run: AgentRun, inputIds?: readonly string[]): boolean {
  const attempt = run.turns.at(-1)?.attempts.at(-1);
  const directive = attempt?.state.status === 'succeeded' ? attempt.state.directive : null;
  return directive?.kind === 'request_decision'
    && run.inbox.some(input => input.state === 'queued' && (inputIds === undefined || inputIds.includes(input.inputId))
      && isExactPlanApprovalInput(input, directive.decision));
}

export async function createPlanApprovalInput(
  decision: PlanDecisionDraft
): Promise<PlanApprovalInput> {
  const content = planApprovalInputContent(decision);
  return {
    inputId: decision.decisionId,
    messageId: decision.decisionId,
    content,
    contentDigest: await sha256AgentControlData(content)
  };
}

export async function planApprovalInputForRun(run: AgentRun): Promise<PlanApprovalInput | undefined> {
  const attempt = run.turns.at(-1)?.attempts.at(-1);
  if (run.state.status !== 'waiting' || run.state.reason !== 'plan_approval'
    || attempt?.state.status !== 'succeeded' || attempt.state.directive.kind !== 'request_decision') return undefined;
  return createPlanApprovalInput(run.state.decision);
}
