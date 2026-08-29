import { describe, expect, it } from 'vitest';

import {
  AgentPlanBudgetChildRunService,
  sha256AgentControlData,
  type AgentControlJsonValue,
  type AgentRunBinding
} from '../src/index.js';
import { at, bindingForRun, startCommand } from './fixtures.js';
import {
  InMemoryAgentRunUnitOfWork,
  TestAgentRunCommandService
} from './support/in-memory-unit-of-work.js';

describe('AgentPlanBudgetChildRunService', () => {
  it('keeps Plan, Budget and child Run facts on one exact multi-aggregate command path', async () => {
    const unit = new InMemoryAgentRunUnitOfWork();
    const runs = new TestAgentRunCommandService(unit);
    const control = new AgentPlanBudgetChildRunService(unit);
    await runs.execute(startCommand());
    await runs.execute({
      kind: 'run.begin',
      commandId: 'command-begin-control',
      runId: 'run-1',
      expectedVersion: 1,
      occurredAt: at(1)
    });

    const planPayload: AgentControlJsonValue = {
      steps: [{ id: 'one', action: 'inspect' }]
    };
    const contentHash = await sha256AgentControlData(planPayload);
    await control.createPlanVersionAndRequestApproval({
      kind: 'control.plan.create_and_request_approval',
      commandId: 'command-plan-control',
      runId: 'run-1',
      expectedVersion: 2,
      occurredAt: at(2),
      decisionId: 'decision-plan-control',
      plan: {
        ref: { planId: 'plan-control', version: 1, contentHash },
        payload: planPayload
      }
    });
    await control.approvePlan({
      kind: 'control.plan.approve',
      commandId: 'command-approve-control',
      runId: 'run-1',
      expectedVersion: 3,
      occurredAt: at(3),
      approvalId: 'approval-plan-control',
      decisionId: 'decision-plan-control',
      checkpointVersion: 2,
      plan: { planId: 'plan-control', version: 1, contentHash }
    });
    await control.reserveBudget({
      kind: 'control.budget.reserve',
      commandId: 'command-reserve-control',
      runId: 'run-1',
      expectedVersion: 4,
      occurredAt: at(4),
      entryId: 'entry-reserve-control',
      reservationId: 'reservation-control',
      vector: {
        modelTurns: 1,
        toolCalls: 0,
        readCalls: 0,
        writeCalls: 0,
        shellCalls: 0,
        costMicrousd: 10
      }
    });
    await control.releaseBudget({
      kind: 'control.budget.release',
      commandId: 'command-release-control',
      runId: 'run-1',
      expectedVersion: 5,
      occurredAt: at(5),
      entryId: 'entry-release-control',
      reservationId: 'reservation-control'
    });

    const objective: AgentControlJsonValue = { task: 'child objective body' };
    const child = childBinding(await sha256AgentControlData(objective));
    const delegated = await control.delegateChildren({
      kind: 'control.children.delegate',
      commandId: 'command-delegate-control',
      runId: 'run-1',
      expectedVersion: 6,
      occurredAt: at(6),
      children: [{
        delegationId: 'delegation-control',
        runId: 'run-child-control',
        binding: child,
        objective,
        required: true
      }]
    });
    expect(delegated.mutations.map((item) => item.runId)).toEqual([
      'run-1',
      'run-child-control'
    ]);
    expect(delegated.mutations.find((item) => item.runId === 'run-1')?.run.state)
      .toMatchObject({ status: 'waiting_children' });
    expect(JSON.stringify(delegated)).not.toContain('child objective body');
    expect(unit.loadCommittedReceipt('command-delegate-control')?.mutations)
      .toHaveLength(2);
  });

  it('rejects a Plan hash mismatch before entering the UnitOfWork transaction', async () => {
    const unit = new InMemoryAgentRunUnitOfWork();
    const runs = new TestAgentRunCommandService(unit);
    const control = new AgentPlanBudgetChildRunService(unit);
    await runs.execute(startCommand());
    await runs.execute({
      kind: 'run.begin',
      commandId: 'command-begin-plan-hash',
      runId: 'run-1',
      expectedVersion: 1,
      occurredAt: at(1)
    });
    const before = unit.transactionCount;
    await expect(control.createPlanVersionAndRequestApproval({
      kind: 'control.plan.create_and_request_approval',
      commandId: 'command-plan-bad-hash',
      runId: 'run-1',
      expectedVersion: 2,
      occurredAt: at(2),
      decisionId: 'decision-plan-bad-hash',
      plan: {
        ref: {
          planId: 'plan-bad-hash',
          version: 1,
          contentHash: `sha256:${'0'.repeat(64)}`
        },
        payload: { steps: ['different'] }
      }
    })).rejects.toThrow(/content hash/);
    expect(unit.transactionCount).toBe(before);
  });
});

function childBinding(objectiveDigest: string): AgentRunBinding {
  const parent = bindingForRun('run-1');
  return {
    ...parent,
    objectiveRef: {
      kind: 'parent_delegation',
      parentRunId: 'run-1',
      delegationId: 'delegation-control',
      objectiveDigest,
      mode: 'one_shot',
      providerId: 'ariadne.in_process'
    },
    budget: {
      grantId: 'grant-run-child-control',
      runId: 'run-child-control',
      vector: {
        modelTurns: 2,
        toolCalls: 1,
        readCalls: 1,
        writeCalls: 0,
        shellCalls: 0,
        costMicrousd: 100
      },
      deadlineAt: parent.budget.deadlineAt,
      source: {
        kind: 'parent_allocation',
        parentRunId: 'run-1',
        parentGrantId: parent.budget.grantId,
        delegationId: 'delegation-control'
      }
    }
  };
}
