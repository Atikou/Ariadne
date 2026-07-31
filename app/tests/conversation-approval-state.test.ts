import type {
  AgentProposal,
  PermissionRequest,
  PlanHandoff,
  RunSummary
} from '@ariadne/protocol/public';
import { describe, expect, it } from 'vitest';
import {
  pendingApprovalSessionIds,
  resolveApprovalSessionId
} from '../src/shared/conversation-approval-state';

describe('conversation approval state', () => {
  const runs = [{
    runId: 'run-with-session',
    sessionId: 'session-from-run'
  }] as RunSummary[];

  it('prefers an approval session id and falls back to its run', () => {
    expect(resolveApprovalSessionId({
      sessionId: 'session-direct',
      runId: 'run-with-session'
    }, runs)).toBe('session-direct');
    expect(resolveApprovalSessionId({ runId: 'run-with-session' }, runs)).toBe('session-from-run');
    expect(resolveApprovalSessionId({ runId: 'missing-run' }, runs)).toBeNull();
  });

  it('marks only sessions with pending approvals', () => {
    const sessionIds = pendingApprovalSessionIds({
      runs,
      proposals: [{
        proposalId: 'proposal-pending',
        sessionId: 'session-proposal',
        status: 'pending'
      }, {
        proposalId: 'proposal-complete',
        sessionId: 'session-resolved',
        status: 'completed'
      }] as AgentProposal[],
      permissions: [{
        requestId: 'permission-pending',
        runId: 'run-with-session',
        status: 'pending'
      }, {
        requestId: 'permission-approved',
        runId: 'run-approved',
        sessionId: 'session-approved',
        status: 'approved'
      }] as PermissionRequest[],
      planHandoffs: [{
        handoffId: 'plan-pending',
        runId: 'run-plan',
        sessionId: 'session-plan',
        status: 'pending'
      }] as PlanHandoff[]
    });

    expect([...sessionIds]).toEqual([
      'session-proposal',
      'session-from-run',
      'session-plan'
    ]);
  });
});
