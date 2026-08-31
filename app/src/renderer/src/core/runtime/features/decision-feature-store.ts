import {
  PUBLIC_DECISION_ACTION_CONTRACT_VERSION,
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  type PublicDecisionChoiceV3,
  type PublicDecisionProjectionV3
} from '@ariadne/protocol/public';
import type {
  RuntimePermissionDecision,
  RuntimePlanDecision,
  RuntimeRun,
  RuntimeUserQuestionDecision
} from '../runtime-projection-presenter';
import type { RuntimeFeatureCommandGateway } from './runtime-feature-command-gateway';

export interface DecisionFeatureHost {
  projectionDecisions(): readonly PublicDecisionProjectionV3[];
  awaitDecisionSettlement(decisionId: string): Promise<void>;
}

export class DecisionFeatureStore {
  constructor(
    private readonly gateway: RuntimeFeatureCommandGateway,
    private readonly host: DecisionFeatureHost
  ) {}

  async respondToPermission(request: RuntimePermissionDecision, choice: 'allow_once' | 'deny'): Promise<void> {
    if (!request.actionAvailable) throw new Error('projection_decision_action_unavailable:permission');
    await this.resolve({ decisionId: request.requestId, runId: request.runId, expectedVersion: request.projectionVersion, kind: 'permission', choice });
  }

  async respondToPlan(handoff: RuntimePlanDecision, choice: 'approve' | 'reject'): Promise<void> {
    if (!handoff.actionAvailable) throw new Error('projection_decision_action_unavailable:plan');
    await this.resolve({ decisionId: handoff.handoffId, runId: handoff.runId, expectedVersion: handoff.projectionVersion, kind: 'plan', choice });
  }

  async recoverRun(run: RuntimeRun, decision: 'resume' | 'cancel' | 'mark_failed'): Promise<void> {
    if (run.origin !== 'projection') throw new Error('projection_run_action_unavailable:recovery');
    const recovery = this.host.projectionDecisions().find((candidate) =>
      candidate.runId === run.runId && candidate.kind === 'recovery' && candidate.status === 'pending');
    if (recovery === undefined) throw new Error('projection_run_action_unavailable:recovery');
    await this.resolve({
      decisionId: recovery.decisionId, runId: recovery.runId, expectedVersion: recovery.version,
      kind: 'recovery',
      choice: decision === 'resume' ? 'retry' : decision === 'cancel' ? 'cancel_run' : 'mark_failed'
    });
  }

  async resumeBudget(run: RuntimeRun): Promise<void> {
    if (run.origin !== 'projection') throw new Error('projection_run_action_unavailable:budget_resume');
    const budget = this.host.projectionDecisions().find((candidate) =>
      candidate.runId === run.runId && candidate.kind === 'budget' && candidate.status === 'pending');
    if (budget === undefined) throw new Error('projection_run_action_unavailable:budget_resume');
    await this.resolve({
      decisionId: budget.decisionId, runId: budget.runId, expectedVersion: budget.version,
      kind: 'budget', choice: 'resume'
    });
  }

  async answerUserQuestion(question: RuntimeUserQuestionDecision, answer: string): Promise<void> {
    if (!question.actionAvailable) throw new Error('projection_decision_action_unavailable:user_question');
    await this.resolve({
      decisionId: question.decisionId, runId: question.runId,
      expectedVersion: question.projectionVersion, kind: 'user_question', choice: 'answer', answer
    });
  }

  private async resolve(input: {
    readonly decisionId: string;
    readonly runId: string | undefined;
    readonly expectedVersion: number;
    readonly kind: 'permission' | 'plan' | 'recovery' | 'budget' | 'user_question';
    readonly choice: PublicDecisionChoiceV3;
    readonly answer?: string;
  }): Promise<void> {
    const decision = this.host.projectionDecisions().find((candidate) => candidate.decisionId === input.decisionId);
    if (!isExactActionableDecision(decision, input)) {
      throw new Error(`projection_decision_action_unavailable:${input.kind}`);
    }
    const result = await this.gateway.execute({
      kind: 'agent.decision.resolve.v3', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      runId: decision.runId, decisionId: decision.decisionId,
      action: {
        contractVersion: PUBLIC_DECISION_ACTION_CONTRACT_VERSION,
        actionToken: decision.action.actionToken,
        choice: input.choice,
        ...(input.answer === undefined ? {} : { answer: input.answer })
      }
    });
    if (result.kind !== 'agent.decision.resolved.v3'
      || result.runId !== decision.runId
      || result.decisionId !== decision.decisionId) {
      throw new Error('runtime_result_invalid:agent.decision.resolved.v3');
    }
    await this.host.awaitDecisionSettlement(decision.decisionId);
  }
}

function isExactActionableDecision(
  decision: PublicDecisionProjectionV3 | undefined,
  expected: {
    readonly decisionId: string;
    readonly runId: string | undefined;
    readonly expectedVersion: number;
    readonly kind: 'permission' | 'plan' | 'recovery' | 'budget' | 'user_question';
    readonly choice: PublicDecisionChoiceV3;
  }
): decision is PublicDecisionProjectionV3 & { readonly action: NonNullable<PublicDecisionProjectionV3['action']> } {
  if (decision === undefined || expected.runId === undefined
    || decision.decisionId !== expected.decisionId || decision.runId !== expected.runId
    || decision.version !== expected.expectedVersion || decision.kind !== expected.kind
    || decision.presentation.kind !== expected.kind || decision.status !== 'pending'
    || decision.action === undefined
    || decision.action.contractVersion !== PUBLIC_DECISION_ACTION_CONTRACT_VERSION) return false;
  const expectedChoices: readonly PublicDecisionChoiceV3[] = expected.kind === 'permission'
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
