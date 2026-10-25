import type { ConversationMessageReference } from '@ariadne/protocol/public';
import type { GoalDecision } from '@ariadne/protocol/host';
export type { GoalDecision } from '@ariadne/protocol/host';

export interface GoalPlanningAuthority {
  stageDecision(input: { readonly runId: string; readonly effectId: string; readonly idempotencyKey: string;
    readonly decision: GoalDecision }, signal: AbortSignal): Promise<{ readonly staged: true; readonly goalId: string; readonly attempt: number }>;
}
export interface GoalPlannerResultSource {
  readonly runId: string;
  readonly runVersion: number;
  readonly sessionVersion: number;
  readonly message: ConversationMessageReference;
}
