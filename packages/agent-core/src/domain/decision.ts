import {
  type AgentDecisionId,
  type AgentEffectId,
  type AgentPlanId,
  type AgentRunId,
  type RunCheckpoint,
  assertCanonicalSortedPublicIds,
  assertCanonicalPublicId,
  assertNonEmpty,
  assertPositiveInteger,
  assertSha256Digest,
  assertTimestamp,
  assertUniqueCanonicalPublicIds,
  assertUniqueNonEmpty
} from './values.js';
import { AgentRunInvariantError } from './errors.js';

interface AgentDecisionBase {
  readonly decisionId: AgentDecisionId;
  readonly runId: AgentRunId;
  readonly checkpoint: RunCheckpoint;
  readonly requestedAt: string;
}

export interface PermissionDecision extends AgentDecisionBase {
  readonly kind: 'permission';
  readonly effectId: AgentEffectId;
  readonly toolCallId: string;
  readonly capabilityIds: readonly string[];
  readonly scope: readonly string[];
}

export interface PlanDecision extends AgentDecisionBase {
  readonly kind: 'plan';
  readonly planId: AgentPlanId;
  readonly planVersion: number;
  readonly planHash: string;
}

export interface UserQuestionDecision extends AgentDecisionBase {
  readonly kind: 'user_question';
  readonly questionRef: string;
  readonly questionDigest: string;
}

export type RecoveryAction =
  | 'retry'
  | 'mark_succeeded'
  | 'mark_failed'
  | 'cancel_run';

export interface RecoveryDecision extends AgentDecisionBase {
  readonly kind: 'recovery';
  readonly effectId: AgentEffectId;
  readonly uncertainty: string;
  readonly allowedActions: readonly RecoveryAction[];
}

export type AgentDecision =
  | PermissionDecision
  | PlanDecision
  | UserQuestionDecision
  | RecoveryDecision;

interface DecisionResolutionBase {
  readonly decisionId: AgentDecisionId;
  readonly checkpoint: RunCheckpoint;
  readonly resolvedAt: string;
}

export interface PermissionDecisionResolution extends DecisionResolutionBase {
  readonly kind: 'permission';
  readonly effectId: AgentEffectId;
  readonly outcome: 'allow_once' | 'allow_run' | 'deny';
  readonly approvedCapabilityIds: readonly string[];
}

export interface PlanDecisionResolution extends DecisionResolutionBase {
  readonly kind: 'plan';
  readonly planId: AgentPlanId;
  readonly planVersion: number;
  readonly planHash: string;
  readonly outcome: 'approve' | 'reject';
}

export interface RecoveryDecisionResolution extends DecisionResolutionBase {
  readonly kind: 'recovery';
  readonly effectId: AgentEffectId;
  readonly outcome: RecoveryAction;
}

export interface UserQuestionDecisionResolution extends DecisionResolutionBase {
  readonly kind: 'user_question';
  readonly questionRef: string;
  readonly questionDigest: string;
  readonly answerInputId: string;
  readonly answerDigest: string;
}

export type AgentDecisionResolution =
  | PermissionDecisionResolution
  | PlanDecisionResolution
  | UserQuestionDecisionResolution
  | RecoveryDecisionResolution;

export type PermissionDecisionDraft = Omit<
  PermissionDecision,
  'runId' | 'checkpoint'
>;

export type PlanDecisionDraft = Omit<
  PlanDecision,
  'runId' | 'checkpoint'
>;

export function assertValidDecision(decision: AgentDecision): void {
  assertCanonicalPublicId(decision.decisionId, 'decision.decisionId');
  assertCanonicalPublicId(decision.runId, 'decision.runId');
  assertCanonicalPublicId(decision.checkpoint.runId, 'decision.checkpoint.runId');
  assertPositiveInteger(decision.checkpoint.version, 'decision.checkpoint.version');
  assertTimestamp(decision.requestedAt, 'decision.requestedAt');

  if (decision.checkpoint.runId !== decision.runId) {
    throw new AgentRunInvariantError('A decision checkpoint must belong to the same run.');
  }

  if (decision.kind === 'permission') {
    assertCanonicalPublicId(decision.effectId, 'decision.effectId');
    assertCanonicalPublicId(decision.toolCallId, 'decision.toolCallId');
    assertCanonicalSortedPublicIds(decision.capabilityIds, 'decision.capabilityIds');
    assertCanonicalSortedPublicIds(decision.scope, 'decision.scope');
    if (decision.capabilityIds.length === 0) {
      throw new AgentRunInvariantError('A permission decision must request at least one capability.');
    }
    return;
  }

  if (decision.kind === 'plan') {
    assertCanonicalPublicId(decision.planId, 'decision.planId');
    assertPositiveInteger(decision.planVersion, 'decision.planVersion');
    assertSha256Digest(decision.planHash, 'decision.planHash');
    return;
  }

  if (decision.kind === 'user_question') {
    assertCanonicalPublicId(decision.questionRef, 'decision.questionRef');
    assertSha256Digest(decision.questionDigest, 'decision.questionDigest');
    return;
  }

  assertCanonicalPublicId(decision.effectId, 'decision.effectId');
  assertNonEmpty(decision.uncertainty, 'decision.uncertainty');
  assertUniqueNonEmpty(decision.allowedActions, 'decision.allowedActions');
  if (decision.allowedActions.length === 0) {
    throw new AgentRunInvariantError('A recovery decision must expose at least one action.');
  }
}
