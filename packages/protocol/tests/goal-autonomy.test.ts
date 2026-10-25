import { describe, expect, it } from 'vitest';
import { PUBLIC_PROJECTION_CONTRACT_VERSION, runtimeCommandSchema, runtimeResultSchema } from '../src/public.js';
import { goalDecisionSchema } from '../src/host.js';

const scope = { contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, workspaceId: 'workspace-1', sessionId: 'session-1' };
const start = { ...scope, kind: 'goal.autonomy.start', goalId: 'goal-1', expectedVersion: 1,
  criteria: ['Actual result verified'], maxConcurrency: 2, deadlineAt: '2098-01-01T00:00:00Z' };
describe('autonomous Goal public commands and internal decision contract', () => {
  it('accepts scoped optimistic start and pause/resume commands', () => {
    expect(runtimeCommandSchema.parse(start)).toEqual(start);
    for (const action of ['pause', 'resume']) {
      const command = { ...scope, kind: 'goal.autonomy.transition', goalId: 'goal-1', expectedVersion: 2, action };
      expect(runtimeCommandSchema.parse(command)).toEqual(command);
    }
  });
  it('rejects missing criteria, invalid limits, private task input and invalid transitions', () => {
    for (const fields of [{ criteria: [] }, { criteria: [' '] }, { criteria: Array(33).fill('criterion') },
      { maxConcurrency: 0 }, { maxConcurrency: 17 }, { expectedVersion: null }, { expectedVersion: 0 },
      { prompt: 'Caller-supplied planner objective' }, { runId: 'private-run' }]) {
      expect(runtimeCommandSchema.safeParse({ ...start, ...fields }).success).toBe(false);
    }
    expect(runtimeCommandSchema.safeParse({ ...scope, kind: 'goal.autonomy.transition', goalId: 'goal-1', expectedVersion: 2, action: 'force-complete' }).success).toBe(false);
  });
  it('exposes public progress but rejects private execution state or staged decisions in the projection', () => {
    const goal = { ...scope, goalId: 'goal-1', version: 2, title: 'Deliver feature', phase: 'implementation', status: 'active',
      roundCap: 3, roundsUsed: 0, updatedAt: '2026-10-04T00:00:00Z', autonomy: { status: 'planning',
        criteria: start.criteria, deadlineAt: start.deadlineAt, maxConcurrency: 2, plannerAttempts: 1,
        sessionId: null, runId: null, workflowId: null, summary: '' } };
    const { contractVersion: _contractVersion, ...publicGoal } = goal;
    expect(runtimeResultSchema.safeParse({ kind: 'goal.updated', goal: publicGoal }).success).toBe(true);
    expect(runtimeResultSchema.safeParse({ kind: 'goal.updated', goal: { ...publicGoal, agentExecution: {} } }).success).toBe(false);
    expect(runtimeResultSchema.safeParse({ kind: 'goal.updated', goal: { ...publicGoal,
      autonomy: { ...publicGoal.autonomy, decision: { decision: 'blocked', summary: 'Private candidate' } } } }).success).toBe(false);
  });
  it('accepts exactly the three structured candidate forms', () => {
    for (const candidate of [
      { decision: 'plan', summary: 'Next round', tasks: [{ key: 'work', title: 'Actual work', dependsOn: [] }] },
      { decision: 'complete', summary: 'Verified', checks: [{ criterion: 0, status: 'passed', evidence: 'Actual test result',
        sources: [{ kind: 'task_result', messageId: 'actual-result' }] }] },
      { decision: 'blocked', summary: 'Required external input missing' }
    ]) expect(goalDecisionSchema.parse(candidate)).toEqual(candidate);
  });
  it('rejects empty plans, empty evidence, invalid task keys and unknown decision fields', () => {
    for (const candidate of [
      { decision: 'plan', summary: 'No work', tasks: [] },
      { decision: 'plan', summary: 'Bad key', tasks: [{ key: 'unsafe/key', title: 'Work', dependsOn: [] }] },
      { decision: 'complete', summary: 'Unknown', checks: [{ criterion: 32, status: 'passed', evidence: 'Result' }] },
      { decision: 'complete', summary: 'No evidence', checks: [{ criterion: 0, status: 'passed', evidence: ' ' }] },
      { decision: 'blocked', summary: 'Reason', force: true }
    ]) expect(goalDecisionSchema.safeParse(candidate).success).toBe(false);
  });
});
