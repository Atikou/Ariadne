import { isExactActionableDecision } from './exact-actionable-decision';
import {
  PUBLIC_DECISION_ACTION_CONTRACT_VERSION,
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  type PublicDecisionChoice,
  type PublicDecisionProjection
} from '@ariadne/protocol/public';
import type {
  RuntimePermissionDecision,
  RuntimePlanDecision,
  RuntimeRun,
  RuntimeUserQuestionDecision
} from '../runtime-projection-presenter';
import type { RuntimeFeatureCommandGateway } from './runtime-feature-command-gateway';
import type { SnapshotSource } from './feature-snapshot-store';
import { recoveryActionChoices } from './recovery-action-choices';
import type { DecisionFeatureSnapshot } from './projection-feature-snapshots';
export type { DecisionFeatureSnapshot } from './projection-feature-snapshots';
import { ProjectionDetailFeature, type ProjectionDetailActions } from './projection-feature-navigation';

export interface DecisionFeatureHost {
  projectionDecisions(): readonly PublicDecisionProjection[];
  awaitDecisionSettlement(decisionId: string): Promise<void>;
}

export class DecisionFeatureStore extends ProjectionDetailFeature {
  constructor(
    private readonly gateway: RuntimeFeatureCommandGateway,
    private readonly host: DecisionFeatureHost,
    readonly view: SnapshotSource<DecisionFeatureSnapshot>,
    readActions?: ProjectionDetailActions
  ) { super(readActions); }

  isPendingDecisionLoaded(decisionId: string, runId: string, version: number): boolean {
    return this.host.projectionDecisions().some(decision => decision.decisionId === decisionId
      && decision.runId === runId && decision.version === version && decision.status === 'pending');
  }

  async respondToPermission(request: RuntimePermissionDecision, choice: 'allow_once' | 'deny'): Promise<void> {
    if (!request.actionAvailable) throw new Error('projection_decision_action_unavailable:permission');
    await this.resolve({ decisionId: request.requestId, runId: request.runId, expectedVersion: request.projectionVersion, kind: 'permission', choice });
  }

  async respondToPlan(handoff: RuntimePlanDecision, choice: 'approve' | 'reject'): Promise<void> {
    if (!handoff.actionAvailable) throw new Error('projection_decision_action_unavailable:plan');
    await this.resolve({ decisionId: handoff.handoffId, runId: handoff.runId, expectedVersion: handoff.projectionVersion, kind: 'plan', choice });
  }

  recoveryChoices(run: RuntimeRun): readonly PublicDecisionChoice[] {
    return recoveryActionChoices(run, this.host.projectionDecisions());
  }

  async recoverRun(run: RuntimeRun, decision: 'resume' | 'cancel' | 'mark_failed'): Promise<void> {
    if (run.origin !== 'projection') throw new Error('projection_run_action_unavailable:recovery');
    const choice = decision === 'resume' ? 'retry' : decision === 'cancel' ? 'cancel_run' : 'mark_failed';
    if (!this.recoveryChoices(run).includes(choice)) throw new Error('projection_run_action_unavailable:recovery_choice');
    const recovery = this.host.projectionDecisions().find((candidate) =>
      candidate.runId === run.runId && candidate.kind === 'recovery' && candidate.status === 'pending');
    if (recovery === undefined) throw new Error('projection_run_action_unavailable:recovery');
    await this.resolve({
      decisionId: recovery.decisionId, runId: recovery.runId, expectedVersion: recovery.version,
      kind: 'recovery',
      choice
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
    readonly choice: PublicDecisionChoice;
    readonly answer?: string;
  }): Promise<void> {
    const decision = this.host.projectionDecisions().find((candidate) => candidate.decisionId === input.decisionId);
    if (!isExactActionableDecision(decision, input)) {
      throw new Error(`projection_decision_action_unavailable:${input.kind}`);
    }
    const result = await this.gateway.execute({
      kind: 'agent.decision.resolve', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      runId: decision.runId, decisionId: decision.decisionId,
      action: {
        contractVersion: PUBLIC_DECISION_ACTION_CONTRACT_VERSION,
        actionToken: decision.action.actionToken,
        choice: input.choice,
        ...(input.answer === undefined ? {} : { answer: input.answer })
      }
    });
    if (result.kind !== 'agent.decision.resolved'
      || result.runId !== decision.runId
      || result.decisionId !== decision.decisionId) {
      throw new Error('runtime_result_invalid:agent.decision.resolved');
    }
    await this.host.awaitDecisionSettlement(decision.decisionId);
  }
}
