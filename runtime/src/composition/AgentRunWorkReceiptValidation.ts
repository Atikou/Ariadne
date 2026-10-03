import {
  AgentRunVersionConflictError,
  type AgentRun,
  type ReadyResumableAgentRunRecovery,
  type RecoverableAgentRun
} from '@ariadne/agent-core';
import type { AgentRunRetiredToolCatalogTerminalizationReceipt } from '../control/ports/AgentRunAuthorityRetirement.js';
import {
  type ActionableWork,
  type ActiveAgentTurnInterruptionRecovery,
  type AgentRunStartedWorkRecoveryReceipt,
  type AgentRunWorkContinuationReceipt,
  type AgentRunWorkEffectDispatchReceipt,
  type AgentRunWorkFollowUpReceipt,
  type AgentRunWorkFollowUpResultIdentity,
  type AgentRunWorkTerminalizationReceipt,
  type StartedWork,
  type TerminalizationWork
} from './AgentRunWorkSchedulerContracts.js';

export function assertInboxContinuationReceipt(
  receipt: AgentRunWorkContinuationReceipt,
  work: Extract<ActionableWork, { readonly kind: 'continue_inbox' }>
): void {
  if (
    receipt.receiptVersion !== 1
    || receipt.runId !== work.runId
    || receipt.runVersion <= work.expectedVersion
    || !nonEmpty(receipt.commandId)
    || !nonEmpty(receipt.turnId)
    || !nonEmpty(receipt.attemptId)
  ) throw new Error('Inbox continuation returned a contradictory work receipt.');
}

export function assertChildResultsContinuationReceipt(
  receipt: AgentRunWorkContinuationReceipt,
  work: Extract<ActionableWork, { readonly kind: 'continue_child_results' }>
): void {
  if (
    receipt.receiptVersion !== 1
    || receipt.runId !== work.runId
    || receipt.runVersion <= work.expectedVersion
    || !nonEmpty(receipt.commandId)
    || !nonEmpty(receipt.turnId)
    || !nonEmpty(receipt.attemptId)
  ) throw new Error('SubAgent continuation returned a contradictory work receipt.');
}

export function isConcurrentSnapshotConflict(error: unknown): boolean {
  return error instanceof AgentRunVersionConflictError;
}

export function requireResumable(
  recovery: RecoverableAgentRun,
  work: ActionableWork
): ReadyResumableAgentRunRecovery {
  if (!recovery.ready || recovery.phase !== 'resumable') {
    throw new Error(
      `Agent Run work "${work.kind}" requires exact resumable recovery authority.`
    );
  }
  if (
    recovery.run.runId !== work.runId
    || recovery.run.version !== work.expectedVersion
  ) {
    throw new Error('Agent Run work recovery authority drifted before dispatch.');
  }
  return recovery;
}

export function assertEffectReceipt(
  receipt: AgentRunWorkEffectDispatchReceipt,
  work: Extract<ActionableWork, { readonly kind: 'dispatch_effect' }>
): void {
  if (
    receipt.run.runId !== work.runId
    || receipt.run.version <= work.expectedVersion
    || receipt.effect.effectId !== work.effectId
    || receipt.status !== receipt.effect.state.status
    || !['succeeded', 'failed', 'cancelled', 'uncertain'].includes(receipt.status)
  ) {
    throw new Error('Effect dispatcher returned a contradictory work receipt.');
  }
}

export function assertContinuationReceipt(
  receipt: AgentRunWorkContinuationReceipt,
  work: Extract<ActionableWork, { readonly kind: 'continue_effect_results' }>
): void {
  if (
    receipt.receiptVersion !== 1
    || receipt.runId !== work.runId
    || receipt.runVersion <= work.expectedVersion
    || !nonEmpty(receipt.commandId)
    || !nonEmpty(receipt.turnId)
    || !nonEmpty(receipt.attemptId)
  ) {
    throw new Error('Effect continuation returned a contradictory work receipt.');
  }
}

export function assertFollowUpReceipt(
  receipt: AgentRunWorkFollowUpReceipt,
  work: Extract<
    ActionableWork,
    { readonly kind: 'dispatch_follow_up' | 'dispatch_delegated_initial' }
  >
): void {
  if (receipt.status === 'waiting_recovery') {
    if (receipt.result !== undefined) {
      assertFollowUpResultIdentity(receipt.result, work);
    }
    return;
  }
  assertFollowUpResultIdentity(receipt.result, work);
}

export function exactUncertainInferenceRecovery(
  receipt: AgentRunWorkFollowUpReceipt,
  work: Extract<
    ActionableWork,
    { readonly kind: 'dispatch_follow_up' | 'dispatch_delegated_initial' }
  >
): ActiveAgentTurnInterruptionRecovery | null {
  if (
    receipt.status !== 'waiting_recovery'
    || receipt.reason !== 'inference_outcome_uncertain'
    || receipt.result === undefined
    || receipt.result.status !== 'uncertain'
    || receipt.result.attempt.state?.status !== 'uncertain'
    || !nonEmpty(receipt.result.recoveryDecisionId ?? '')
  ) return null;
  assertFollowUpResultIdentity(receipt.result, work);
  return {
    runId: receipt.result.run.runId,
    runVersion: receipt.result.run.version,
    turnId: receipt.result.turn.turnId,
    attemptId: receipt.result.attempt.attemptId,
    recoveryDecisionId: receipt.result.recoveryDecisionId!
  };
}

function assertFollowUpResultIdentity(
  result: AgentRunWorkFollowUpResultIdentity,
  work: Extract<
    ActionableWork,
    { readonly kind: 'dispatch_follow_up' | 'dispatch_delegated_initial' }
  >
): void {
  if (
    result.run.runId !== work.runId
    || result.run.version <= work.expectedVersion
    || result.turn.turnId !== work.turnId
    || result.attempt.attemptId !== work.attemptId
  ) {
    throw new Error('Follow-up inference returned a contradictory work receipt.');
  }
}

export function assertTerminalizationReceipt(
  receipt: AgentRunWorkTerminalizationReceipt,
  work: TerminalizationWork
): void {
  const expected = work.kind === 'fail_deadline_expired'
    ? {
        reason: 'deadline_expired' as const,
        errorCode: 'agent_run_deadline_expired' as const
      }
    : {
        reason: 'model_turn_budget_exhausted' as const,
        errorCode: 'agent_model_turn_budget_exhausted' as const
      };
  if (
    receipt.receiptVersion !== 1
    || receipt.runId !== work.runId
    || receipt.runVersion !== work.expectedVersion + 1
    || receipt.checkpointVersion !== work.checkpointVersion + 1
    || receipt.status !== 'failed'
    || receipt.reason !== expected.reason
    || receipt.errorCode !== expected.errorCode
    || !nonEmpty(receipt.commandId)
  ) {
    throw new Error('Run terminalization returned a contradictory work receipt.');
  }
}

export function assertRetiredToolCatalogTerminalizationReceipt(
  receipt: AgentRunRetiredToolCatalogTerminalizationReceipt,
  run: AgentRun
): void {
  if (
    receipt.receiptVersion !== 1
    || receipt.runId !== run.runId
    || receipt.runVersion <= run.version
    || receipt.checkpointVersion <= run.state.checkpointVersion
    || receipt.status !== 'failed'
    || receipt.reason !== 'tool_catalog_retired'
    || receipt.errorCode !== 'agent_tool_catalog_retired'
    || !nonEmpty(receipt.commandId)
  ) {
    throw new Error(
      'Retired Tool Catalog terminalization returned a contradictory receipt.'
    );
  }
}

export function assertStartedWorkRecoveryReceipt(
  receipt: AgentRunStartedWorkRecoveryReceipt,
  work: StartedWork
): void {
  const subjectKind = work.kind === 'recovery_uncertain_effect' ? 'effect' : 'inference';
  const subjectId = work.kind === 'recovery_uncertain_effect'
    ? work.effectId
    : work.attemptId;
  if (
    receipt.receiptVersion !== 1
    || receipt.runId !== work.runId
    || receipt.runVersion <= work.expectedVersion
    || receipt.subjectKind !== subjectKind
    || receipt.subjectId !== subjectId
    || !nonEmpty(receipt.commandId)
    || !nonEmpty(receipt.recoveryDecisionId)
  ) {
    throw new Error('Started-work recovery returned a contradictory receipt.');
  }
}

function nonEmpty(value: string): boolean {
  return value.length > 0 && value.trim() === value;
}

export function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  field: string
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} is outside its bounded range.`);
  }
  return value;
}
