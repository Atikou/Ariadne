import { PUBLIC_DECISION_ACTION_CONTRACT_VERSION, type PublicDecisionProjection, type PublicDecisionChoice } from '@ariadne/protocol/public';

export function isExactActionableDecision(
  decision: PublicDecisionProjection | undefined,
  expected: {
    readonly decisionId: string;
    readonly runId: string | undefined;
    readonly expectedVersion: number;
    readonly kind: 'permission' | 'plan' | 'recovery' | 'budget' | 'user_question';
    readonly choice: PublicDecisionChoice;
  }
): decision is PublicDecisionProjection & { readonly action: NonNullable<PublicDecisionProjection['action']> } {
  if (decision === undefined || expected.runId === undefined
    || decision.decisionId !== expected.decisionId || decision.runId !== expected.runId
    || decision.version !== expected.expectedVersion || decision.kind !== expected.kind
    || decision.presentation.kind !== expected.kind || decision.status !== 'pending'
    || decision.action === undefined
    || decision.action.contractVersion !== PUBLIC_DECISION_ACTION_CONTRACT_VERSION) return false;
  const expectedChoices: readonly PublicDecisionChoice[] = expected.kind === 'permission'
    ? ['allow_once', 'allow_run', 'deny']
    : expected.kind === 'plan'
      ? ['approve', 'reject']
      : expected.kind === 'recovery'
        ? ['retry', 'mark_succeeded', 'mark_failed', 'cancel_run']
        : expected.kind === 'budget' ? ['resume', 'cancel_run'] : ['answer'];
  return decision.action.choices.length === expectedChoices.length
    && decision.action.choices.every((choice, index) => choice === expectedChoices[index])
    && decision.action.choices.includes(expected.choice);
}
