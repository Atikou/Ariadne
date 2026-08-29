import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  AgentPlanBudgetChildRunService,
  AgentRunCommandService,
  AgentRunInvariantError,
  sha256AgentControlData,
  type AgentBudgetVector,
  type AgentControlJsonValue,
  type AgentRunBinding,
  type AgentRunCheckpointCommit
} from '@ariadne/agent-core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  SqliteAgentRunUnitOfWork
} from '../src/adapters/persistence/SqliteAgentRunUnitOfWork.js';
import {
  AgentRetiredToolCatalogTerminalizationCoordinator
} from '../src/control/execution/AgentRetiredToolCatalogTerminalizationCoordinator.js';
import {
  resolveAgentControlDatabasePath
} from '../src/adapters/persistence/agentControlDbSchema.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';

const roots: string[] = [];
const openUnits = new Set<SqliteAgentRunUnitOfWork>();

afterEach(async () => {
  await Promise.all([...openUnits].map(closeUnit));
  openUnits.clear();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('ADR-0009 Plan/Budget/ordinary child Run SQLite slice', () => {
  it('retires a delegated Child through the canonical Parent terminal observation', async () => {
    const root = createRoot();
    const unit = openUnit(root);
    const commands = new AgentRunCommandService(unit);
    const control = new AgentPlanBudgetChildRunService(unit);
    const retirement = new AgentRetiredToolCatalogTerminalizationCoordinator(unit);
    await startRunningRoot(commands, 'run-retired-parent');
    const objective: AgentControlJsonValue = { task: 'retired child' };
    await control.delegateChildren({
      kind: 'control.children.delegate',
      commandId: 'command-delegate-retired-child',
      runId: 'run-retired-parent',
      expectedVersion: 2,
      occurredAt: at(2),
      children: [{
        delegationId: 'delegation-retired-child',
        runId: 'run-retired-child',
        binding: await childBinding(
          'run-retired-parent',
          'run-retired-child',
          'delegation-retired-child',
          objective,
          budget(2, 2, 2, 0, 0, 100)
        ),
        objective,
        required: true
      }]
    });
    await commands.execute({
      kind: 'run.begin',
      commandId: 'command-begin-retired-child',
      runId: 'run-retired-child',
      expectedVersion: 1,
      occurredAt: at(3)
    }, checkpoint(1, at(3), 'retired-child-running'));
    const child = await unit.transaction((transaction) => (
      transaction.loadRun('run-retired-child')
    ));
    if (child === null) throw new Error('retired_child_fixture_missing');

    await expect(retirement.terminalize(
      child,
      new AbortController().signal
    )).resolves.toMatchObject({
      runId: 'run-retired-child',
      runVersion: 3,
      status: 'failed',
      reason: 'tool_catalog_retired'
    });
    const parentAfterChild = await unit.transaction((transaction) => (
      transaction.loadRun('run-retired-parent')
    ));
    expect(parentAfterChild?.state.status).toBe('running');
    const delegation = await unit.transaction((transaction) => (
      transaction.loadDelegationByChild?.('run-retired-child')
    ));
    expect(delegation?.terminal).toMatchObject({
      childRunVersion: 3,
      childStatus: 'failed'
    });
    const budgetSnapshot = await unit.transaction((transaction) => (
      transaction.loadBudgetSnapshot?.('grant-run-retired-parent')
    ));
    expect(budgetSnapshot?.openReservations).toEqual([]);

    if (parentAfterChild === null) throw new Error('retired_parent_fixture_missing');
    await expect(retirement.terminalize(
      parentAfterChild,
      new AbortController().signal
    )).resolves.toMatchObject({
      runId: 'run-retired-parent',
      status: 'failed',
      errorCode: 'agent_tool_catalog_retired'
    });
  });

  it('commits exact Plan approval, durable Budget, parent plus N children, replay, and out-of-order terminal propagation', async () => {
    const root = createRoot();
    let unit = openUnit(root);
    const commands = new AgentRunCommandService(unit);
    const control = new AgentPlanBudgetChildRunService(unit);
    await startRunningRoot(commands, 'run-parent');

    const planPayload: AgentControlJsonValue = {
      title: 'Safe immutable plan',
      steps: [{ id: 'step-1', action: 'inspect' }]
    };
    const planHash = await sha256AgentControlData(planPayload);
    const waiting = await control.createPlanVersionAndRequestApproval({
      kind: 'control.plan.create_and_request_approval',
      commandId: 'command-plan-create',
      runId: 'run-parent',
      expectedVersion: 2,
      occurredAt: at(2),
      decisionId: 'decision-plan-exact',
      plan: {
        ref: { planId: 'plan-parent', version: 1, contentHash: planHash },
        payload: planPayload
      }
    });
    expect(waiting.mutations[0]?.run.state).toMatchObject({
      status: 'waiting',
      reason: 'plan_approval',
      checkpointVersion: 2
    });
    const approved = await control.approvePlan({
      kind: 'control.plan.approve',
      commandId: 'command-plan-approve',
      runId: 'run-parent',
      expectedVersion: 3,
      occurredAt: at(3),
      approvalId: 'approval-plan-exact',
      decisionId: 'decision-plan-exact',
      checkpointVersion: 2,
      plan: { planId: 'plan-parent', version: 1, contentHash: planHash }
    });
    expect(approved.mutations[0]?.run.state.status).toBe('running');

    await control.reserveBudget({
      kind: 'control.budget.reserve',
      commandId: 'command-budget-reserve',
      runId: 'run-parent',
      expectedVersion: 4,
      occurredAt: at(4),
      entryId: 'budget-entry-reserve-one',
      reservationId: 'reservation-one',
      vector: budget(1, 1, 1, 0, 0, 100)
    });
    await control.settleBudget({
      kind: 'control.budget.settle',
      commandId: 'command-budget-settle',
      runId: 'run-parent',
      expectedVersion: 5,
      occurredAt: at(5),
      entryId: 'budget-entry-settle-one',
      reservationId: 'reservation-one',
      actual: budget(1, 1, 1, 0, 0, 80)
    });

    const objectiveA: AgentControlJsonValue = {
      task: 'inspect child A',
      path: 'src/private/a.ts'
    };
    const objectiveB: AgentControlJsonValue = {
      task: 'inspect child B',
      path: 'src/private/b.ts'
    };
    const delegationCommand = {
      kind: 'control.children.delegate' as const,
      commandId: 'command-delegate-two',
      runId: 'run-parent',
      expectedVersion: 6,
      occurredAt: at(6),
      children: [
        {
          delegationId: 'delegation-a',
          runId: 'run-child-a',
          binding: await childBinding(
            'run-parent',
            'run-child-a',
            'delegation-a',
            objectiveA,
            budget(2, 2, 2, 0, 0, 200)
          ),
          objective: objectiveA,
          required: true
        },
        {
          delegationId: 'delegation-b',
          runId: 'run-child-b',
          binding: await childBinding(
            'run-parent',
            'run-child-b',
            'delegation-b',
            objectiveB,
            budget(2, 2, 2, 0, 0, 200)
          ),
          objective: objectiveB,
          required: true
        }
      ]
    };
    const delegated = await control.delegateChildren(delegationCommand);
    expect(delegated.mutations.map((item) => item.runId)).toEqual([
      'run-child-a',
      'run-child-b',
      'run-parent'
    ]);
    expect(delegated.mutations.find((item) => item.runId === 'run-parent')?.run.state)
      .toMatchObject({
        status: 'waiting_children',
        requiredChildRunIds: ['run-child-a', 'run-child-b'],
        terminalChildRunIds: []
      });

    await closeUnit(unit);
    unit = openUnit(root);
    const reopenedControl = new AgentPlanBudgetChildRunService(unit);
    const replay = await reopenedControl.delegateChildren(delegationCommand);
    expect(replay.replayed).toBe(true);
    expect(replay.mutations).toHaveLength(3);

    const childCommands = new AgentRunCommandService(unit);
    await completeQueuedChild(childCommands, 'run-child-a', 7);
    await completeQueuedChild(childCommands, 'run-child-b', 9);

    const observedB = await reopenedControl.observeChildTerminal({
      kind: 'control.children.observe_terminal',
      commandId: 'command-observe-child-b',
      runId: 'run-parent',
      expectedVersion: 7,
      occurredAt: at(11),
      childRunId: 'run-child-b',
      childRunVersion: 3,
      childStatus: 'completed'
    });
    expect(observedB.mutations[0]?.run.state).toMatchObject({
      status: 'waiting_children',
      terminalChildRunIds: ['run-child-b']
    });
    const observedA = await reopenedControl.observeChildTerminal({
      kind: 'control.children.observe_terminal',
      commandId: 'command-observe-child-a',
      runId: 'run-parent',
      expectedVersion: 8,
      occurredAt: at(12),
      childRunId: 'run-child-a',
      childRunVersion: 3,
      childStatus: 'completed'
    });
    expect(observedA.mutations[0]?.run.state.status).toBe('running');

    const duplicate = await reopenedControl.observeChildTerminal({
      kind: 'control.children.observe_terminal',
      commandId: 'command-observe-child-a-duplicate',
      runId: 'run-parent',
      expectedVersion: 8,
      occurredAt: at(13),
      childRunId: 'run-child-a',
      childRunVersion: 3,
      childStatus: 'completed'
    });
    expect(duplicate).toMatchObject({ idempotent: true, replayed: false });

    const snapshot = await unit.transaction((transaction) =>
      transaction.loadBudgetSnapshot?.('grant-run-parent')
    );
    expect(snapshot?.openReservations).toEqual([]);
    expect(snapshot?.available).toEqual(
      budget(11, 7, 7, 4, 2, 999_920)
    );

    const database = new DatabaseSync(resolveAgentControlDatabasePath(root), {
      readOnly: true
    });
    try {
      expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(count(database, 'agent_v3_plan_versions')).toBe(1);
      expect(count(database, 'agent_v3_plan_approvals')).toBe(1);
      expect(count(database, 'agent_v3_delegations')).toBe(2);
      expect(count(database, 'agent_v3_child_terminals')).toBe(2);
      expect(count(database, 'agent_v3_budget_grants')).toBe(3);
      const publicText = readPublicAuthorityText(database);
      expect(publicText).not.toContain('inspect child A');
      expect(publicText).not.toContain('src/private/a.ts');
      expect(publicText).not.toContain('inspect child B');
    } finally {
      database.close();
    }
  });

  it('serializes sibling allocation and reservations without overdraw', async () => {
    const root = createRoot();
    const unit = openUnit(root);
    const commands = new AgentRunCommandService(unit);
    const control = new AgentPlanBudgetChildRunService(unit);
    await startRunningRoot(commands, 'run-parent');

    const objectiveA: AgentControlJsonValue = { task: 'overallocate A' };
    const objectiveB: AgentControlJsonValue = { task: 'overallocate B' };
    await expect(control.delegateChildren({
      kind: 'control.children.delegate',
      commandId: 'command-overallocate-siblings',
      runId: 'run-parent',
      expectedVersion: 2,
      occurredAt: at(2),
      children: [
        {
          delegationId: 'delegation-over-a',
          runId: 'run-over-a',
          binding: await childBinding(
            'run-parent', 'run-over-a', 'delegation-over-a', objectiveA,
            budget(8, 5, 5, 3, 2, 700_000)
          ),
          objective: objectiveA,
          required: true
        },
        {
          delegationId: 'delegation-over-b',
          runId: 'run-over-b',
          binding: await childBinding(
            'run-parent', 'run-over-b', 'delegation-over-b', objectiveB,
            budget(8, 5, 5, 3, 2, 700_000)
          ),
          objective: objectiveB,
          required: true
        }
      ]
    })).rejects.toThrow(/exceed.*Budget balance/i);

    const reservationA = {
      kind: 'control.budget.reserve',
      commandId: 'command-reserve-concurrent-a',
      runId: 'run-parent',
      expectedVersion: 2,
      occurredAt: at(2),
      entryId: 'budget-entry-concurrent-a',
      reservationId: 'reservation-concurrent-a',
      vector: budget(8, 5, 5, 3, 2, 700_000)
    } as const;
    const first = control.reserveBudget(reservationA);
    const second = control.reserveBudget({
      kind: 'control.budget.reserve',
      commandId: 'command-reserve-concurrent-b',
      runId: 'run-parent',
      expectedVersion: 2,
      occurredAt: at(2),
      entryId: 'budget-entry-concurrent-b',
      reservationId: 'reservation-concurrent-b',
      vector: budget(8, 5, 5, 3, 2, 700_000)
    });
    const settled = await Promise.allSettled([first, second]);
    expect(settled.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((item) => item.status === 'rejected')).toHaveLength(1);
    if (settled[0]?.status === 'fulfilled') {
      await expect(control.reserveBudget(reservationA)).resolves.toMatchObject({
        replayed: true
      });
    }

    const snapshot = await unit.transaction((transaction) =>
      transaction.loadBudgetSnapshot?.('grant-run-parent')
    );
    expect(snapshot?.openReservations).toHaveLength(1);
    expect(snapshot?.available).toEqual(budget(4, 3, 3, 1, 0, 300_000));

    const database = new DatabaseSync(resolveAgentControlDatabasePath(root), {
      readOnly: true
    });
    try {
      expect(count(database, 'agent_v3_delegations')).toBe(0);
      expect(count(database, 'agent_v3_budget_entries')).toBe(2);
      expect(count(database, 'agent_v3_commands')).toBe(3);
      expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('rejects child escalation and keeps a cancelling parent non-terminal until its required child is terminal', async () => {
    const root = createRoot();
    const unit = openUnit(root);
    const commands = new AgentRunCommandService(unit);
    const control = new AgentPlanBudgetChildRunService(unit);
    await startRunningRoot(commands, 'run-parent');
    const objective: AgentControlJsonValue = { task: 'read only child' };
    const baseBinding = await childBinding(
      'run-parent',
      'run-child-a',
      'delegation-a',
      objective,
      budget(2, 2, 2, 0, 0, 100)
    );
    const binding: AgentRunBinding = {
      ...baseBinding,
      workspace: {
        ...baseBinding.workspace,
        access: 'read'
      }
    };
    await control.delegateChildren({
      kind: 'control.children.delegate',
      commandId: 'command-delegate-cancel-child',
      runId: 'run-parent',
      expectedVersion: 2,
      occurredAt: at(2),
      children: [{
        delegationId: 'delegation-a',
        runId: 'run-child-a',
        binding,
        objective,
        required: true
      }]
    });
    await commands.execute({
      kind: 'run.begin',
      commandId: 'command-begin-child-a',
      runId: 'run-child-a',
      expectedVersion: 1,
      occurredAt: at(3)
    }, checkpoint(1, at(3), 'child-running'));

    const grandchildObjective: AgentControlJsonValue = { task: 'write escalation' };
    const baseEscalated = await childBinding(
      'run-child-a',
      'run-grandchild',
      'delegation-grandchild',
      grandchildObjective,
      budget(1, 1, 1, 0, 0, 10),
      binding
    );
    const escalated: AgentRunBinding = {
      ...baseEscalated,
      workspace: {
        ...baseEscalated.workspace,
        access: 'write'
      }
    };
    await expect(control.delegateChildren({
      kind: 'control.children.delegate',
      commandId: 'command-grandchild-escalation',
      runId: 'run-child-a',
      expectedVersion: 2,
      occurredAt: at(4),
      children: [{
        delegationId: 'delegation-grandchild',
        runId: 'run-grandchild',
        binding: escalated,
        objective: grandchildObjective,
        required: true
      }]
    })).rejects.toThrow(/cannot expand workspace access/i);

    const cancelling = await control.requestParentCancellation({
      kind: 'control.children.request_parent_cancellation',
      commandId: 'command-cancel-parent',
      runId: 'run-parent',
      expectedVersion: 3,
      occurredAt: at(5),
      reason: 'user_cancelled_parent'
    });
    expect(cancelling.mutations[0]?.run.state.status).toBe('cancelling');
    await expect(commands.execute({
      kind: 'run.cancel',
      commandId: 'command-bypass-parent-cancel',
      runId: 'run-parent',
      expectedVersion: 4,
      occurredAt: at(6),
      reason: 'bypass'
    }, { turnInputPayloads: [], effectPayloads: [] })).rejects.toThrow(/child Runs/);
    await expect(control.observeChildTerminal({
      kind: 'control.children.observe_terminal',
      commandId: 'command-observe-nonterminal-child',
      runId: 'run-parent',
      expectedVersion: 4,
      occurredAt: at(6),
      childRunId: 'run-child-a',
      childRunVersion: 2,
      childStatus: 'completed'
    })).rejects.toThrow(/exact durable terminal child/);

    await commands.execute({
      kind: 'run.complete',
      commandId: 'command-complete-child-a',
      runId: 'run-child-a',
      expectedVersion: 2,
      occurredAt: at(7)
    }, { turnInputPayloads: [], effectPayloads: [] });
    const cancelled = await control.observeChildTerminal({
      kind: 'control.children.observe_terminal',
      commandId: 'command-observe-terminal-child',
      runId: 'run-parent',
      expectedVersion: 4,
      occurredAt: at(8),
      childRunId: 'run-child-a',
      childRunVersion: 3,
      childStatus: 'completed'
    });
    expect(cancelled.mutations[0]?.run.state).toMatchObject({
      status: 'cancelled',
      reason: 'user_cancelled_parent'
    });
  });

  it('rolls back parent, children, allocations, objectives, Events, and Outbox when a side-fact insert is killed', async () => {
    const root = createRoot();
    const unit = openUnit(root);
    const commands = new AgentRunCommandService(unit);
    const control = new AgentPlanBudgetChildRunService(unit);
    await startRunningRoot(commands, 'run-parent');
    const database = databaseOf(unit);
    database.exec(`
      CREATE TRIGGER kill_delegation_fact
      BEFORE INSERT ON agent_v3_delegations
      BEGIN
        SELECT RAISE(ABORT, 'kill_delegation_fact');
      END;
    `);
    const objective: AgentControlJsonValue = { task: 'must roll back' };
    await expect(control.delegateChildren({
      kind: 'control.children.delegate',
      commandId: 'command-delegate-killed',
      runId: 'run-parent',
      expectedVersion: 2,
      occurredAt: at(2),
      children: [{
        delegationId: 'delegation-killed',
        runId: 'run-child-killed',
        binding: await childBinding(
          'run-parent',
          'run-child-killed',
          'delegation-killed',
          objective,
          budget(1, 1, 1, 0, 0, 10)
        ),
        objective,
        required: true
      }]
    })).rejects.toThrow(/kill_delegation_fact/);
    database.exec('DROP TRIGGER kill_delegation_fact');

    const parent = await unit.transaction((transaction) => transaction.loadRun('run-parent'));
    expect(parent).toMatchObject({ version: 2, state: { status: 'running' } });
    expect(await unit.transaction((transaction) => transaction.loadRun('run-child-killed')))
      .toBeNull();
    for (const table of [
      'agent_v3_delegations',
      'agent_v3_child_terminals',
      'agent_v3_plan_versions'
    ]) {
      expect(count(database, table)).toBe(0);
    }
    expect(countWhere(database, 'agent_v3_commands', 'command_id', 'command-delegate-killed'))
      .toBe(0);
    expect(countWhere(database, 'agent_v3_events', 'command_id', 'command-delegate-killed'))
      .toBe(0);
    expect(countWhere(database, 'agent_v3_outbox', 'command_id', 'command-delegate-killed'))
      .toBe(0);
    expect(count(database, 'agent_v3_budget_grants')).toBe(1);
    expect(count(database, 'agent_v3_budget_entries')).toBe(1);
  });

  it('fails recovery and approval closed when an exact protected Plan is missing and rejects credential payloads before any write', async () => {
    const root = createRoot();
    const unit = openUnit(root);
    const commands = new AgentRunCommandService(unit);
    const control = new AgentPlanBudgetChildRunService(unit);
    await startRunningRoot(commands, 'run-parent');

    const unsafePayload: AgentControlJsonValue = {
      apiToken: 'sk-this-credential-must-never-be-written'
    };
    const unsafeHash = await sha256AgentControlData(unsafePayload);
    await expect(control.createPlanVersionAndRequestApproval({
      kind: 'control.plan.create_and_request_approval',
      commandId: 'command-plan-credential-rejected',
      runId: 'run-parent',
      expectedVersion: 2,
      occurredAt: at(2),
      decisionId: 'decision-plan-credential-rejected',
      plan: {
        ref: { planId: 'plan-unsafe', version: 1, contentHash: unsafeHash },
        payload: unsafePayload
      }
    })).rejects.toThrow(/credentials|authorization/i);
    expect(await unit.transaction((transaction) => transaction.loadRun('run-parent')))
      .toMatchObject({ version: 2, state: { status: 'running' } });

    const payload: AgentControlJsonValue = { title: 'recoverable plan', steps: [] };
    const contentHash = await sha256AgentControlData(payload);
    await control.createPlanVersionAndRequestApproval({
      kind: 'control.plan.create_and_request_approval',
      commandId: 'command-plan-before-missing',
      runId: 'run-parent',
      expectedVersion: 2,
      occurredAt: at(3),
      decisionId: 'decision-plan-before-missing',
      plan: {
        ref: { planId: 'plan-missing', version: 1, contentHash },
        payload
      }
    });
    const database = databaseOf(unit);
    database.prepare(
      'DELETE FROM agent_v3_plan_versions WHERE plan_id=? AND plan_version=?'
    ).run('plan-missing', 1);

    const recovery = await unit.listActiveRuns();
    const blocked = recovery.items.find((item) => item.run.runId === 'run-parent');
    expect(blocked).toMatchObject({
      ready: false,
      issues: expect.arrayContaining(['missing_plan_payload'])
    });
    await expect(control.approvePlan({
      kind: 'control.plan.approve',
      commandId: 'command-approve-missing-plan',
      runId: 'run-parent',
      expectedVersion: 3,
      occurredAt: at(4),
      approvalId: 'approval-missing-plan',
      decisionId: 'decision-plan-before-missing',
      checkpointVersion: 2,
      plan: { planId: 'plan-missing', version: 1, contentHash }
    })).rejects.toThrow(/exact intact protected Plan/i);
    expect(countWhere(
      database,
      'agent_v3_commands',
      'command_id',
      'command-approve-missing-plan'
    )).toBe(0);
    expect(readAllDatabaseText(database)).not.toContain(
      'sk-this-credential-must-never-be-written'
    );
  });

  it('reports durable Budget and Delegation integrity failures during active recovery', async () => {
    const root = createRoot();
    const unit = openUnit(root);
    const commands = new AgentRunCommandService(unit);
    const control = new AgentPlanBudgetChildRunService(unit);
    await startRunningRoot(commands, 'run-budget-corrupt');
    const database = databaseOf(unit);
    database.prepare(
      `DELETE FROM agent_v3_budget_entries
       WHERE grant_id=? AND entry_kind='root_grant'`
    ).run('grant-run-budget-corrupt');

    await startRunningRoot(commands, 'run-parent');
    const objective: AgentControlJsonValue = { task: 'delegation integrity' };
    await control.delegateChildren({
      kind: 'control.children.delegate',
      commandId: 'command-delegate-before-corruption',
      runId: 'run-parent',
      expectedVersion: 2,
      occurredAt: at(2),
      children: [{
        delegationId: 'delegation-corrupt',
        runId: 'run-child-corrupt',
        binding: await childBinding(
          'run-parent',
          'run-child-corrupt',
          'delegation-corrupt',
          objective,
          budget(1, 1, 1, 0, 0, 10)
        ),
        objective,
        required: true
      }]
    });
    database.prepare(
      'DELETE FROM agent_v3_delegations WHERE delegation_id=?'
    ).run('delegation-corrupt');

    const recovery = await unit.listActiveRuns({ limit: 10 });
    const budgetRun = recovery.items.find(
      (item) => item.run.runId === 'run-budget-corrupt'
    );
    const childRun = recovery.items.find(
      (item) => item.run.runId === 'run-child-corrupt'
    );
    const parentRun = recovery.items.find(
      (item) => item.run.runId === 'run-parent'
    );
    expect(budgetRun).toMatchObject({
      ready: false,
      issues: expect.arrayContaining(['budget_integrity_mismatch'])
    });
    expect(childRun).toMatchObject({
      ready: false,
      issues: expect.arrayContaining(['missing_delegation'])
    });
    expect(parentRun).toMatchObject({
      ready: false,
      issues: expect.arrayContaining(['pending_required_child_mismatch'])
    });
  });
});

async function startRunningRoot(
  commands: AgentRunCommandService,
  runId: string
): Promise<void> {
  await commands.execute({
    kind: 'run.start',
    commandId: `command-start-${runId}`,
    runId,
    occurredAt: at(0),
    binding: rootBinding(runId)
  }, { turnInputPayloads: [], effectPayloads: [] });
  await commands.execute({
    kind: 'run.begin',
    commandId: `command-begin-${runId}`,
    runId,
    expectedVersion: 1,
    occurredAt: at(1)
  }, checkpoint(1, at(1), 'root-running'));
}

async function completeQueuedChild(
  commands: AgentRunCommandService,
  runId: string,
  offset: number
): Promise<void> {
  await commands.execute({
    kind: 'run.begin',
    commandId: `command-begin-${runId}`,
    runId,
    expectedVersion: 1,
    occurredAt: at(offset)
  }, checkpoint(1, at(offset), 'child-running'));
  await commands.execute({
    kind: 'run.complete',
    commandId: `command-complete-${runId}`,
    runId,
    expectedVersion: 2,
    occurredAt: at(offset + 1)
  }, { turnInputPayloads: [], effectPayloads: [] });
}

function rootBinding(runId: string): AgentRunBinding {
  return {
    bindingVersion: 3,
    sessionId: 'session-control-test',
    objectiveRef: {
      kind: 'conversation_message',
      messageId: `message-${runId}`,
      messageVersion: 1,
      contentDigest: `sha256:${'1'.repeat(64)}`
    },
    workspace: {
      workspaceId: 'workspace-control-test',
      revision: 1,
      grantDigest: `sha256:${'2'.repeat(64)}`,
      access: 'write',
      scopeIds: ['src']
    },
    model: {
      providerId: 'provider-test',
      modelId: 'model-test',
      settingsRevision: 1
    },
    policy: {
      policyId: 'policy-test',
      revision: 1,
      permissionMode: 'ask'
    },
    capabilities: [{ capabilityId: 'workspace.read', scopeIds: ['src'] }],
    toolCatalog: {
      catalogId: 'catalog-test',
      revision: 1,
      digest: `sha256:${'3'.repeat(64)}`,
      allowedToolNames: ['workspace.read']
    },
    budget: {
      grantId: `grant-${runId}`,
      runId,
      vector: budget(12, 8, 8, 4, 2, 1_000_000),
      deadlineAt: '2031-01-01T00:00:00.000Z',
      source: { kind: 'root' }
    }
  };
}

async function childBinding(
  parentRunId: string,
  runId: string,
  delegationId: string,
  objective: AgentControlJsonValue,
  vector: AgentBudgetVector,
  parent = rootBinding(parentRunId)
): Promise<AgentRunBinding> {
  return {
    ...parent,
    objectiveRef: {
      kind: 'parent_delegation',
      parentRunId,
      delegationId,
      objectiveDigest: await sha256AgentControlData(objective),
      providerId: 'ariadne.in_process',
      mode: 'one_shot'
    },
    workspace: { ...parent.workspace, scopeIds: [...parent.workspace.scopeIds] },
    capabilities: parent.capabilities.map((item) => ({
      ...item,
      scopeIds: [...item.scopeIds]
    })),
    toolCatalog: {
      ...parent.toolCatalog,
      allowedToolNames: [...parent.toolCatalog.allowedToolNames]
    },
    budget: {
      grantId: `grant-${runId}`,
      runId,
      vector,
      deadlineAt: parent.budget.deadlineAt,
      source: {
        kind: 'parent_allocation',
        parentRunId,
        parentGrantId: parent.budget.grantId,
        delegationId
      }
    }
  };
}

function budget(
  modelTurns: number,
  toolCalls: number,
  readCalls: number,
  writeCalls: number,
  shellCalls: number,
  costMicrousd: number
): AgentBudgetVector {
  return { modelTurns, toolCalls, readCalls, writeCalls, shellCalls, costMicrousd };
}

function checkpoint(
  checkpointVersion: number,
  createdAt: string,
  phase: string
): {
  readonly checkpoint: AgentRunCheckpointCommit;
  readonly turnInputPayloads: readonly [];
  readonly effectPayloads: readonly [];
} {
  return {
    checkpoint: {
      checkpointVersion,
      createdAt,
      payload: {
        format: 'ariadne.agent-checkpoint',
        schemaVersion: 1,
        engineContinuation: { phase },
        modelContext: []
      }
    },
    turnInputPayloads: [],
    effectPayloads: []
  };
}

function createRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-plan-budget-child-'));
  roots.push(root);
  return root;
}

function openUnit(root: string): SqliteAgentRunUnitOfWork {
  const unit = new SqliteAgentRunUnitOfWork(root);
  openUnits.add(unit);
  return unit;
}

async function closeUnit(unit: SqliteAgentRunUnitOfWork): Promise<void> {
  if (!openUnits.delete(unit)) return;
  const context = createShutdownContext(Date.now() + 5_000);
  try {
    await unit.close(context);
  } finally {
    context.dispose();
  }
}

function databaseOf(unit: SqliteAgentRunUnitOfWork): DatabaseSync {
  return (unit as unknown as { database: DatabaseSync }).database;
}

function count(database: DatabaseSync, table: string): number {
  return Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  }).count);
}

function countWhere(
  database: DatabaseSync,
  table: string,
  column: string,
  value: string
): number {
  return Number((database.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${column}=?`
  ).get(value) as { count: number }).count);
}

function readPublicAuthorityText(database: DatabaseSync): string {
  const rows = database.prepare(`
    SELECT aggregate_json AS value FROM agent_v3_runs
    UNION ALL SELECT result_run_json FROM agent_v3_command_runs
    UNION ALL SELECT event_json FROM agent_v3_events
    UNION ALL SELECT event_json FROM agent_v3_outbox
  `).all() as Array<{ value: string }>;
  return rows.map((row) => row.value).join('\n');
}

function readAllDatabaseText(database: DatabaseSync): string {
  const tables = (database.prepare(
    `SELECT name FROM sqlite_master
     WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  ).all() as Array<{ name: string }>).map((row) => row.name);
  return tables.map((table) =>
    JSON.stringify(database.prepare(`SELECT * FROM ${table}`).all())
  ).join('\n');
}

function at(offsetSeconds: number): string {
  return new Date(Date.UTC(2030, 0, 1, 0, 0, offsetSeconds)).toISOString();
}
