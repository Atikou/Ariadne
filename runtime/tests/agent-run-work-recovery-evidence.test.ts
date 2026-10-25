import { describe, expect, it } from 'vitest';
import { exactUncertainInferenceRecovery } from '../src/composition/AgentRunWorkReceiptValidation.js';
import type { AgentRunWorkFollowUpReceipt } from '../src/composition/AgentRunWorkSchedulerContracts.js';

const work = { kind: 'dispatch_follow_up' as const, runId: 'run-evidence', expectedVersion: 7,
  checkpointVersion: 7, turnId: 'turn-evidence', attemptId: 'attempt-evidence', inputDigest: `sha256:${'a'.repeat(64)}`,
  sourceTurnId: 'turn-source', sourceAttemptId: 'attempt-source', sourceDirectiveDigest: `sha256:${'b'.repeat(64)}` };
function receipt(): AgentRunWorkFollowUpReceipt {
  return { status: 'waiting_recovery', reason: 'inference_outcome_uncertain', result: {
    status: 'uncertain', run: { runId: work.runId, version: 9 }, turn: { turnId: work.turnId },
    attempt: { attemptId: work.attemptId, state: { status: 'uncertain', recovery: { decisionId: 'recovery-evidence' } } }
  } };
}

describe('owned inference interruption recovery evidence', () => {
  it('reads the actual Core Attempt recovery identity without an invented top-level field', () => {
    expect(exactUncertainInferenceRecovery(receipt(), work)).toEqual({ runId: work.runId,
      runVersion: 9, turnId: work.turnId, attemptId: work.attemptId, recoveryDecisionId: 'recovery-evidence' });
  });
  it('rejects top-level-only mock evidence instead of reporting that the inference already settled', () => {
    const invalid = receipt();
    if (invalid.status !== 'waiting_recovery' || invalid.result === undefined) throw new Error('fixture_invalid');
    const topLevelOnly = { ...invalid, result: { ...invalid.result, recoveryDecisionId: 'invented',
      attempt: { attemptId: work.attemptId, state: { status: 'uncertain' } } } };
    expect(() => exactUncertainInferenceRecovery(topLevelOnly, work)).toThrow(/no exact durable Attempt recovery/u);
  });
  it('rejects a receipt from a different Attempt', () => {
    const invalid = receipt();
    if (invalid.status !== 'waiting_recovery' || invalid.result === undefined) throw new Error('fixture_invalid');
    expect(() => exactUncertainInferenceRecovery({ ...invalid, result: { ...invalid.result,
      attempt: { ...invalid.result.attempt, attemptId: 'different-attempt' } } }, work))
      .toThrow(/contradictory work receipt/u);
  });
  it('does not manufacture recovery evidence for an earlier unknown Provider boundary', () => {
    expect(exactUncertainInferenceRecovery({ status: 'waiting_recovery',
      reason: 'inference_already_crossed_boundary' }, work)).toBeNull();
  });
});
