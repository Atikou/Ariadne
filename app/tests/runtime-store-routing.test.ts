import { describe, expect, it } from 'vitest';
import type {
  PublicDecisionProjectionV3,
  RuntimeCommand,
  RuntimeResult,
  RuntimeStatus
} from '@ariadne/protocol/public';
import type { AriadneApi } from '@shared/contract';
import {
  PublicResultError,
  RuntimeStore,
  runtimeRequestErrorMessage,
  type RuntimePermissionDecision,
  type RuntimePlanDecision,
  type RuntimeRun
} from '../src/renderer/src/core/runtime/runtime-store';
import { projectionSnapshot, readBatch } from './projection-v3-fixture';
import { successfulRuntimeApi } from './support/runtime-api';

const READY: RuntimeStatus = {
  availability: 'ready',
  capabilities: [],
  observedAt: '2026-07-31T00:00:00.000Z'
};
const ACTION_TOKEN = `decision-action.v1:${'a'.repeat(64)}`;

describe('RuntimeStore command routing', () => {
  it('never routes run mutations through retired command chains', async () => {
    const commands: RuntimeCommand[] = [];
    const store = new RuntimeStore(successApi(commands));

    await expect(store.cancelRun({ runId: 'companion-run', origin: 'companion' }))
      .rejects.toThrow('projection_run_action_unavailable:origin');
    await expect(store.cancelRun({ runId: 'agent-run', origin: 'agent' }))
      .rejects.toThrow('projection_run_action_unavailable:origin');
    await expect(store.cancelRun({ runId: 'projection-run', origin: 'projection' }))
      .rejects.toThrow('projection_run_action_unavailable:missing');
    expect(commands).toEqual([]);
  });

  it('fails closed when a projected decision has no opaque action token', async () => {
    const commands: RuntimeCommand[] = [];
    const store = new RuntimeStore(successApi(commands));
    const request: RuntimePermissionDecision = {
      requestId: 'decision-permission',
      runId: 'run-a',
      title: 'Permission',
      reason: 'Details intentionally absent',
      permissionItems: [],
      toolName: 'workspace.write',
      scopeIds: [],
      resourceSummary: 'No narrower resource identifier was requested beyond the Run grant.',
      status: 'pending',
      createdAt: '2026-07-31T00:00:00.000Z',
      projectionVersion: 1,
      actionAvailable: false
    };

    await expect(store.respondToPermission(request, 'allow_once'))
      .rejects.toThrow('projection_decision_action_unavailable:permission');
    await expect(store.respondToPlan(unavailablePlan(), 'approve'))
      .rejects.toThrow('projection_decision_action_unavailable:plan');

    expect(commands).toEqual([]);
  });

  it('constructs exact v3 Permission and Plan commands from the internal projection cache', async () => {
    const commands: RuntimeCommand[] = [];
    const decisions = [permissionDecision(), planDecision()];
    const store = new RuntimeStore(successfulRuntimeApi({
      getStatus: async () => READY,
      request: async (command) => {
        commands.push(command);
        if (command.kind === 'projection.snapshot.get') {
          return { kind: 'projection.snapshot', snapshot: projectionSnapshot({ decisions }) };
        }
        if (command.kind === 'projection.commits.read') {
          return {
            kind: 'projection.commits',
            batch: readBatch(
              command.request.afterCursor,
              command.request.afterDigest,
              [],
              { streamId: command.request.streamId }
            )
          };
        }
        if (command.kind === 'agent.decision.resolve.v3') {
          return {
            kind: 'agent.decision.resolved.v3',
            runId: command.runId,
            decisionId: command.decisionId,
            runVersion: 2
          };
        }
        throw new Error(`Unexpected command: ${command.kind}`);
      },
      onEvent: () => () => undefined
    }));
    await store.initialize();
    const permission = store.getSnapshot().permissions[0]!;
    const plan = store.getSnapshot().planHandoffs[0]!;

    expect(permission.actionAvailable).toBe(true);
    expect(plan.actionAvailable).toBe(true);
    expect(JSON.stringify({ permission, plan })).not.toContain(ACTION_TOKEN);
    expect(JSON.stringify({ permission, plan })).not.toContain('decision-action');

    await store.respondToPermission(permission, 'allow_once');
    await store.respondToPlan(plan, 'approve');

    expect(commands.filter((command) => command.kind === 'agent.decision.resolve.v3'))
      .toEqual([
        {
          kind: 'agent.decision.resolve.v3',
          contractVersion: '3.0',
          runId: 'run-permission',
          decisionId: 'decision-permission',
          action: {
            contractVersion: '1.0',
            actionToken: ACTION_TOKEN,
            choice: 'allow_once'
          }
        },
        {
          kind: 'agent.decision.resolve.v3',
          contractVersion: '3.0',
          runId: 'run-plan',
          decisionId: 'decision-plan',
          action: {
            contractVersion: '1.0',
            actionToken: ACTION_TOKEN,
            choice: 'approve'
          }
        }
      ]);
  });

  it('fails closed on a stale Renderer version without invoking any legacy decision route', async () => {
    const commands: RuntimeCommand[] = [];
    const store = await initializedDecisionStore(commands, [
      permissionDecision(),
      planDecision()
    ]);
    const current = store.getSnapshot().permissions[0]!;

    await expect(store.respondToPermission({
      ...current,
      projectionVersion: current.projectionVersion + 1
    }, 'allow_once')).rejects.toThrow('projection_decision_action_unavailable:permission');
    await expect(store.respondToPermission(current, 'approve' as never))
      .rejects.toThrow('projection_decision_action_unavailable:permission');
    await expect(store.respondToPermission({
      ...current,
      requestId: 'decision-plan',
      runId: 'run-plan'
    }, 'allow_once')).rejects.toThrow('projection_decision_action_unavailable:permission');

    const commandKinds = commands.map((command) => command.kind as string);
    expect(commandKinds).not.toContain('agent.decision.resolve.v3');
    expect(commandKinds).not.toContain('permissions.respond');
    expect(commandKinds).not.toContain('planHandoffs.respond');
  });

  it('redacts the opaque action token from decision errors and the public snapshot', async () => {
    const store = await initializedDecisionStore([], [permissionDecision()], ACTION_TOKEN);
    const request = store.getSnapshot().permissions[0]!;

    const error = await store.respondToPermission(request, 'allow_once')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(ACTION_TOKEN);
    expect((error as Error).message).not.toContain('decision-action.v1:');
    expect(JSON.stringify(store.getSnapshot())).not.toContain(ACTION_TOKEN);
    expect(store.getSnapshot().lastError).not.toContain(ACTION_TOKEN);
  });

  it('routes recovery and budget actions through their exact v3 decision tokens', async () => {
    const commands: RuntimeCommand[] = [];
    const store = await initializedDecisionStore(commands, [
      budgetDecision(),
      recoveryDecision()
    ]);
    const run = {
      runId: 'run-recovery',
      origin: 'projection',
      title: 'Recovery',
      status: 'interrupted',
      userFacingLabel: 'Interrupted',
      aggregateVersion: 7,
      checkpointStage: 'interrupted',
      recoveryStatus: 'recoverable',
      timing: { activeDurationMs: 1 }
    } satisfies RuntimeRun;

    await store.recoverRun(run, 'resume');
    await store.resumeBudget({ ...run, runId: 'run-budget', status: 'waiting_budget' });
    expect(commands.filter((command) => command.kind === 'agent.decision.resolve.v3'))
      .toMatchObject([{
        runId: 'run-recovery',
        decisionId: 'decision-recovery',
        action: { choice: 'retry' }
      }, {
        runId: 'run-budget',
        decisionId: 'decision-budget',
        action: { choice: 'resume' }
      }]);
  });

  it('preserves structured public errors and sanitizes desktop invocation prefixes', async () => {
    const store = new RuntimeStore({
      getStatus: async () => ({
        ok: false,
        error: {
          code: 'runtime_unavailable',
          message: 'Runtime unavailable',
          retryable: true,
          correlationId: 'correlation-a'
        }
      }),
      request: async () => ({
        ok: false,
        error: {
          code: 'runtime_unavailable',
          message: 'Runtime unavailable',
          retryable: true,
          correlationId: 'correlation-a'
        }
      }),
      onStatus: () => () => undefined,
      onEvent: () => () => undefined
    });

    const error = await store.sendMessage('Hello', { workspaceId: 'workspace-a' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PublicResultError);
    expect((error as PublicResultError).publicError.code).toBe('runtime_unavailable');
    expect(runtimeRequestErrorMessage(new Error(
      "Error invoking remote method 'runtime:request': Error: safe message"
    ))).toBe('safe message');
  });
});

function successApi(commands: RuntimeCommand[]): AriadneApi['runtime'] {
  return {
    getStatus: async () => ({
      ok: true,
      value: {
        availability: 'stopped',
        capabilities: [],
        observedAt: '2026-07-31T00:00:00.000Z'
      }
    }),
    onStatus: () => () => undefined,
    request: async (command) => {
      commands.push(command);
      return { ok: true, value: { kind: 'acknowledged' } as RuntimeResult };
    },
    onEvent: () => () => undefined
  };
}

function permissionDecision(): PublicDecisionProjectionV3 {
  return {
    decisionId: 'decision-permission',
    runId: 'run-permission',
    sessionId: 'session-permission',
    version: 1,
    kind: 'permission',
    status: 'pending',
    presentation: {
      contractVersion: '1.0',
      kind: 'permission',
      headline: 'Permission required',
      summary: 'Review the exact capabilities before allowing the Tool.',
      toolName: 'workspace.write',
      capabilityIds: ['file.write'],
      scopeIds: ['workspace.primary'],
      resourceSummary: 'Only the presented workspace scope is affected.'
    },
    requestedAt: '2026-07-31T00:00:00.000Z',
    action: {
      contractVersion: '1.0',
      actionToken: ACTION_TOKEN,
      choices: ['allow_once', 'allow_run', 'deny']
    }
  };
}

function planDecision(): PublicDecisionProjectionV3 {
  return {
    decisionId: 'decision-plan',
    runId: 'run-plan',
    sessionId: 'session-plan',
    version: 1,
    kind: 'plan',
    status: 'pending',
    presentation: {
      contractVersion: '1.0',
      kind: 'plan',
      headline: 'Plan approval required',
      summary: 'Review the bounded execution plan.',
      impactSummary: 'The plan changes workspace files.',
      approvalScope: 'continue_run_with_presented_plan',
      steps: [{
        title: 'Implement',
        summary: 'Apply the reviewed change.',
        impact: 'workspace_change'
      }]
    },
    requestedAt: '2026-07-31T00:00:00.000Z',
    action: {
      contractVersion: '1.0',
      actionToken: ACTION_TOKEN,
      choices: ['approve', 'reject']
    }
  };
}

function recoveryDecision(): PublicDecisionProjectionV3 {
  return {
    decisionId: 'decision-recovery',
    runId: 'run-recovery',
    sessionId: 'session-recovery',
    version: 7,
    kind: 'recovery',
    status: 'pending',
    presentation: {
      contractVersion: '1.0',
      kind: 'recovery',
      headline: 'Recovery required',
      summary: 'Choose how to recover this run.'
    },
    requestedAt: '2026-07-31T00:00:00.000Z',
    action: {
      contractVersion: '1.0',
      actionToken: ACTION_TOKEN,
      choices: ['retry', 'mark_succeeded', 'mark_failed', 'cancel_run']
    }
  };
}

function budgetDecision(): PublicDecisionProjectionV3 {
  return {
    decisionId: 'decision-budget',
    runId: 'run-budget',
    sessionId: 'session-budget',
    version: 5,
    kind: 'budget',
    status: 'pending',
    presentation: {
      contractVersion: '1.0',
      kind: 'budget',
      headline: 'Budget required',
      summary: 'Choose whether to resume this run.'
    },
    requestedAt: '2026-07-31T00:00:00.000Z',
    action: {
      contractVersion: '1.0',
      actionToken: ACTION_TOKEN,
      choices: ['resume', 'cancel_run']
    }
  };
}

function unavailablePlan(): RuntimePlanDecision {
  return {
    handoffId: 'decision-plan',
    runId: 'run-plan',
    title: 'Plan',
    summary: 'Plan summary',
    steps: [],
    plan: null,
    status: 'pending',
    createdAt: '2026-07-31T00:00:00.000Z',
    projectionVersion: 1,
    impactSummary: 'Plan impact',
    approvalScope: 'continue_run_with_presented_plan',
    actionAvailable: false
  };
}

async function initializedDecisionStore(
  commands: RuntimeCommand[],
  decisions: PublicDecisionProjectionV3[],
  failureToken?: string
): Promise<RuntimeStore> {
  const store = new RuntimeStore(successfulRuntimeApi({
    getStatus: async () => READY,
    request: async (command) => {
      commands.push(command);
      if (command.kind === 'projection.snapshot.get') {
        return { kind: 'projection.snapshot', snapshot: projectionSnapshot({ decisions }) };
      }
      if (command.kind === 'projection.commits.read') {
        return {
          kind: 'projection.commits',
          batch: readBatch(
            command.request.afterCursor,
            command.request.afterDigest,
            [],
            { streamId: command.request.streamId }
          )
        };
      }
      if (command.kind === 'agent.decision.resolve.v3') {
        if (failureToken !== undefined) {
          throw new Error(`Unsafe provider detail: ${failureToken}`);
        }
        return {
          kind: 'agent.decision.resolved.v3',
          runId: command.runId,
          decisionId: command.decisionId,
          runVersion: 2
        };
      }
      throw new Error(`Unexpected command: ${command.kind}`);
    },
    onEvent: () => () => undefined
  }));
  await store.initialize();
  return store;
}
