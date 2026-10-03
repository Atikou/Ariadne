import { type AgentRunRecoveryCursor } from '@ariadne/agent-core';
import type { AgentRunWorkClassification } from '../control/execution/AgentRunWorkClassifier.js';
import {
  type ActionableWork,
  type AgentRunWorkSchedulerFault,
  type MutableAgentRunWorkDrainResult,
  type ScanRound,
  type ScannedRun,
  type StartedWork
} from './AgentRunWorkSchedulerContracts.js';

export function childFirstRetirementOrder(items: readonly ScannedRun[]): readonly ScannedRun[] {
  const byRunId = new Map(items.map((item) => [item.recovery.run.runId, item]));
  const childrenByParent = new Map<string, ScannedRun[]>();
  for (const item of items) {
    const objective = item.recovery.run.binding.objectiveRef;
    if (objective.kind !== 'parent_delegation' || !byRunId.has(objective.parentRunId)) {
      continue;
    }
    const children = childrenByParent.get(objective.parentRunId) ?? [];
    children.push(item);
    childrenByParent.set(objective.parentRunId, children);
  }
  const ordered: ScannedRun[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (item: ScannedRun): void => {
    const runId = item.recovery.run.runId;
    if (visited.has(runId)) return;
    if (visiting.has(runId)) {
      throw new Error('Retired Tool Catalog Run lineage contains a cycle.');
    }
    visiting.add(runId);
    const children = childrenByParent.get(runId) ?? [];
    children.sort((left, right) => (
      left.recovery.run.runId < right.recovery.run.runId ? -1 : 1
    ));
    for (const child of children) visit(child);
    visiting.delete(runId);
    visited.add(runId);
    ordered.push(item);
  };
  for (const item of items) visit(item);
  return ordered;
}

export function mutableDrainResult(): MutableAgentRunWorkDrainResult {
  return {
    rounds: 0,
    scannedRuns: 0,
    dispatchedEffects: 0,
    continuedBatches: 0,
    continuedInboxInputs: 0,
    continuedChildResults: 0,
    dispatchedFollowUps: 0,
    dispatchedDelegatedInitials: 0,
    terminalizedRuns: 0
  };
}

export function collectFaults(
  round: ScanRound,
  startupRecoveryAvailable: boolean,
  ignoredRunIds: ReadonlySet<string> = new Set()
): AgentRunWorkSchedulerFault[] {
  const faults: AgentRunWorkSchedulerFault[] = [];
  for (const item of round.runs) {
    if (ignoredRunIds.has(item.recovery.run.runId)) continue;
    if (!item.recovery.ready) {
      faults.push({
        runId: item.recovery.run.runId,
        expectedVersion: item.recovery.run.version,
        kind: 'blocked_recovery',
        reason: item.recovery.issues.join(',')
      });
      continue;
    }
    const work = item.work;
    if (work === null) {
      faults.push({
        runId: item.recovery.run.runId,
        expectedVersion: item.recovery.run.version,
        kind: 'health_fault',
        reason: 'ready_recovery_was_not_classified'
      });
      continue;
    }
    if (work.kind === 'unsupported' || work.kind === 'health_fault') {
      faults.push({
        runId: work.runId,
        expectedVersion: work.expectedVersion,
        kind: work.kind,
        reason: work.reason
      });
      continue;
    }
    if (
      (work.kind === 'recovery_uncertain_effect'
        || work.kind === 'recovery_uncertain_inference'
        || work.kind === 'recovery_uncertain_delegated_inference')
      && !startupRecoveryAvailable
    ) {
      faults.push(startedWorkFault(work));
    }
  }
  return faults;
}

export function startedWorkFault(work: StartedWork): AgentRunWorkSchedulerFault {
  return {
    runId: work.runId,
    expectedVersion: work.expectedVersion,
    kind: work.kind,
    reason: work.kind === 'recovery_uncertain_effect'
      ? `${work.effectId}:${work.effectAttempt}`
      : `${work.turnId}:${work.attemptId}`
  };
}

export function isActionable(work: AgentRunWorkClassification): work is ActionableWork {
  return work.kind === 'dispatch_effect'
    || work.kind === 'continue_effect_results'
    || work.kind === 'continue_inbox'
    || work.kind === 'continue_child_results'
    || work.kind === 'dispatch_follow_up'
    || work.kind === 'dispatch_delegated_initial'
    || work.kind === 'fail_model_turn_budget'
    || work.kind === 'fail_deadline_expired';
}

export function compareRecoveryCursor(
  left: AgentRunRecoveryCursor,
  right: AgentRunRecoveryCursor
): number {
  const createdAt = left.createdAt.localeCompare(right.createdAt);
  return createdAt === 0 ? left.runId.localeCompare(right.runId) : createdAt;
}
