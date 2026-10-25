import { afterEach, describe, expect, it } from 'vitest';
import type {
  PublicDecisionProjection,
  PublicProjectionChange,
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
} from '../../app/src/renderer/src/core/runtime/runtime-store';
import { NOW, session, upsertChange, presentationRun, run as fixtureRun } from '../../app/tests/projection-v3-fixture';
import { presentRun } from '../../app/src/renderer/src/core/runtime/runtime-projection-presenter';
import { successfulRuntimeApi } from '../../app/tests/support/runtime-api';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqlitePublicProjectionStore } from '../../runtime/src/adapters/persistence/SqlitePublicProjectionStore';
import { readAgentProjectionQuery } from '../../runtime/src/composition/agent-entity/components/projection/AgentProjectionQueries';

const databases: { root: string; backend: SqlitePublicProjectionStore; renderer: RuntimeStore }[] = [];
afterEach(async () => {
  for (const item of databases.splice(0)) {
    item.renderer.dispose(); await item.backend.close(); rmSync(item.root, { recursive: true, force: true });
  }
});

const READY: RuntimeStatus = {
  availability: 'ready',
  capabilities: [],
  observedAt: '2026-07-31T00:00:00.000Z'
};
const ACTION_TOKEN = `decision-action.v1:${'a'.repeat(64)}`;

describe('RuntimeStore command routing', () => {
  it('routes the human Skill catalog through its independent feature store', async () => {
    const commands: RuntimeCommand[] = [];
    const store = new RuntimeStore(successfulRuntimeApi({
      getStatus: async () => READY,
      request: async (command) => {
        commands.push(command);
        if (command.kind === 'skill.commands.query') {
          return {
            kind: 'skill.commands.query_result',
            workspaceId: 'workspace-1',
            catalogDigest: `sha256:${'b'.repeat(64)}`,
            complete: true,
            source: 'fresh',
            commands: [{
              name: 'review',
              revision: 'sha256:review',
              description: 'Review the current change.',
              layer: 'workspace'
            }]
          };
        }
        if (command.kind === 'skill.command.load') {
          return {
            kind: 'skill.command.loaded',
            workspaceId: 'workspace-1',
            name: command.name,
            revision: command.revision,
            description: 'Review the current change.',
            layer: 'workspace',
            body: 'Review it.',
            resources: []
          };
        }
        throw new Error(`Unexpected command: ${command.kind}`);
      },
      onEvent: () => () => undefined
    }));

    await expect(store.humanSkills.queryCommands('workspace-1')).resolves.toHaveLength(1);
    await expect(store.humanSkills.loadCommand(
      'workspace-1',
      'review',
      'sha256:review'
    )).resolves.toMatchObject({ name: 'review', body: 'Review it.' });
    expect(commands.map((command) => command.kind)).toEqual([
      'skill.commands.query',
      'skill.command.load'
    ]);
  });

  it('routes productivity reads and Schedule mutations only through v3 Runtime commands', async () => {
    const commands: RuntimeCommand[] = [];
    const store = new RuntimeStore(successfulRuntimeApi({
      getStatus: async () => READY,
      request: async (command) => {
        commands.push(command);
        if (command.kind === 'productivity.query') {
          return { kind: 'productivity.query_result', goal: null, todoRevision: null, todos: [], workflows: [] };
        }
        if (command.kind === 'schedule.create') {
          return {
            kind: 'schedule.updated',
            schedule: {
              scheduleId: command.scheduleId, workspaceId: command.workspaceId, sessionId: command.sessionId,
              version: 1, status: 'active', prompt: command.prompt, timing: command.timing,
              nextFireAt: '2032-01-01T00:00:00.000Z', fireCount: 0
            }
          };
        }
        throw new Error(`Unexpected command: ${command.kind}`);
      },
      onEvent: () => () => undefined
    }));

    await expect(store.productivity.query('workspace-1', 'session-1')).resolves.toMatchObject({ goal: null, todos: [] });
    await expect(store.productivity.createSchedule({
      workspaceId: 'workspace-1', sessionId: 'session-1', scheduleId: 'schedule-1', prompt: 'Continue',
      timing: { kind: 'once', at: '2032-01-01T00:00:00.000Z', missPolicy: 'run_once' }
    })).resolves.toMatchObject({ scheduleId: 'schedule-1', status: 'active' });
    expect(commands.map((command) => command.kind)).toEqual(['productivity.query', 'schedule.create']);
  });

  it('requests one protected Tool result page and validates its ownership tuple', async () => {
    const commands: RuntimeCommand[] = [];
    const store = new RuntimeStore(successfulRuntimeApi({
      getStatus: async () => READY,
      request: async (command) => {
        commands.push(command);
        if (command.kind !== 'agent.tool_result.detail.get') {
          throw new Error(`Unexpected command: ${command.kind}`);
        }
        return {
          kind: 'agent.tool_result.detail',
          runId: command.runId,
          workspaceId: command.workspaceId,
          effectId: command.effectId,
          toolCallId: 'call-detail',
          presentation: { kind: 'file_search', label: '搜索工作区' },
          status: 'succeeded',
          digest: `sha256:${'a'.repeat(64)}`,
          totalBytes: 40,
          cursor: command.cursor,
          nextCursor: 20,
          content: '{"matches":[]}',
          complete: false
        };
      },
      onEvent: () => () => undefined
    }));

    await expect(store.toolResults.loadDetail(
      'run-detail',
      'workspace-detail',
      'effect-detail',
      4,
      8 * 1024
    )).resolves.toMatchObject({
      kind: 'agent.tool_result.detail',
      runId: 'run-detail',
      workspaceId: 'workspace-detail',
      effectId: 'effect-detail',
      presentation: { kind: 'file_search' },
      cursor: 4,
      nextCursor: 20
    });
    expect(commands).toEqual([{
      kind: 'agent.tool_result.detail.get',
      contractVersion: '5.0',
      runId: 'run-detail',
      workspaceId: 'workspace-detail',
      effectId: 'effect-detail',
      cursor: 4,
      maxBytes: 8 * 1024
    }]);
  });

  it('never routes run mutations through retired command chains', async () => {
    const commands: RuntimeCommand[] = [];
    const store = new RuntimeStore(successApi(commands));

    await expect(store.runs.requestCancellation({ runId: 'companion-run', origin: 'companion' }))
      .rejects.toThrow('projection_run_action_unavailable:origin');
    await expect(store.runs.requestCancellation({ runId: 'agent-run', origin: 'agent' }))
      .rejects.toThrow('projection_run_action_unavailable:origin');
    await expect(store.runs.requestCancellation({ runId: 'projection-run', origin: 'projection' }))
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

    await expect(store.decisions.respondToPermission(request, 'allow_once'))
      .rejects.toThrow('projection_decision_action_unavailable:permission');
    await expect(store.decisions.respondToPlan(unavailablePlan(), 'approve'))
      .rejects.toThrow('projection_decision_action_unavailable:plan');

    expect(commands).toEqual([]);
  });

  it('constructs exact v3 Permission, Plan, and user-answer commands from verified scoped details', async () => {
    const commands: RuntimeCommand[] = [];
    const decisions = [permissionDecision(), planDecision(), userQuestionDecision()];
    const store = await initializedDecisionStore(commands, decisions);
    const permission = store.getSnapshot().permissions[0]!;
    await store.sessions.select('session-plan');
    const plan = store.getSnapshot().planHandoffs[0]!;
    await store.sessions.select('session-user-question');
    const question = store.getSnapshot().userQuestions[0]!;

    expect(permission.actionAvailable).toBe(true);
    expect(plan.actionAvailable).toBe(true);
    expect(question.actionAvailable).toBe(true);
    expect(JSON.stringify({ permission, plan, question })).not.toContain(ACTION_TOKEN);
    expect(JSON.stringify({ permission, plan, question })).not.toContain('decision-action');

    await store.sessions.select('session-permission');
    await store.decisions.respondToPermission(permission, 'allow_once');
    await store.sessions.select('session-plan');
    await store.decisions.respondToPlan(plan, 'approve');
    await store.sessions.select('session-user-question');
    await store.decisions.answerUserQuestion(question, 'local: Local only');

    expect(commands.filter((command) => command.kind === 'agent.decision.resolve'))
      .toEqual([
        {
          kind: 'agent.decision.resolve',
          contractVersion: '5.0',
          runId: 'run-permission',
          decisionId: 'decision-permission',
          action: {
            contractVersion: '1.0',
            actionToken: ACTION_TOKEN,
            choice: 'allow_once'
          }
        },
        {
          kind: 'agent.decision.resolve',
          contractVersion: '5.0',
          runId: 'run-plan',
          decisionId: 'decision-plan',
          action: {
            contractVersion: '1.0',
            actionToken: ACTION_TOKEN,
            choice: 'approve'
          }
        },
        {
          kind: 'agent.decision.resolve',
          contractVersion: '5.0',
          runId: 'run-user-question',
          decisionId: 'decision-user-question',
          action: {
            contractVersion: '1.0',
            actionToken: ACTION_TOKEN,
            choice: 'answer',
            answer: 'local: Local only'
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

    await expect(store.decisions.respondToPermission({
      ...current,
      projectionVersion: current.projectionVersion + 1
    }, 'allow_once')).rejects.toThrow('projection_decision_action_unavailable:permission');
    await expect(store.decisions.respondToPermission(current, 'approve' as never))
      .rejects.toThrow('projection_decision_action_unavailable:permission');
    await expect(store.decisions.respondToPermission({
      ...current,
      requestId: 'decision-plan',
      runId: 'run-plan'
    }, 'allow_once')).rejects.toThrow('projection_decision_action_unavailable:permission');

    const commandKinds = commands.map((command) => command.kind as string);
    expect(commandKinds).not.toContain('agent.decision.resolve');
    expect(commandKinds).not.toContain('permissions.respond');
    expect(commandKinds).not.toContain('planHandoffs.respond');
  });

  it('redacts the opaque action token from decision errors and the public snapshot', async () => {
    const store = await initializedDecisionStore([], [permissionDecision()], ACTION_TOKEN);
    const request = store.getSnapshot().permissions[0]!;

    const error = await store.decisions.respondToPermission(request, 'allow_once')
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
    const run = presentRun(presentationRun({ ...fixtureRun('run-recovery', 'interrupted', 7), title: 'Recovery', label: 'Interrupted' }));

    const cancelling = { ...run, cancellationPending: true };
    await store.sessions.select('session-recovery');
    expect(store.decisions.recoveryChoices(cancelling)).not.toContain('retry');
    expect(store.decisions.recoveryChoices(cancelling)).toContain('cancel_run');
    await expect(store.decisions.recoverRun(cancelling, 'resume')).rejects.toThrow('projection_run_action_unavailable:recovery_choice');
    expect(commands.filter(command => command.kind === 'agent.decision.resolve')).toHaveLength(0);
    await store.decisions.recoverRun(run, 'resume');
    await store.sessions.select('session-budget');
    await store.decisions.resumeBudget({ ...run, runId: 'run-budget', status: 'waiting_budget' });
    expect(commands.filter((command) => command.kind === 'agent.decision.resolve'))
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

    const error = await store.messages.send('Hello', { workspaceId: 'workspace-a' })
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

function permissionDecision(): PublicDecisionProjection {
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

function planDecision(): PublicDecisionProjection {
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

function userQuestionDecision(): PublicDecisionProjection {
  return {
    decisionId: 'decision-user-question',
    runId: 'run-user-question',
    sessionId: 'session-user-question',
    version: 1,
    kind: 'user_question',
    status: 'pending',
    presentation: {
      contractVersion: '1.0',
      kind: 'user_question',
      headline: 'Agent needs your input',
      question: 'Which deployment target should be used?',
      options: [
        { optionId: 'local', label: 'Local only' },
        { optionId: 'remote', label: 'Remote host' }
      ],
      allowsFreeText: true
    },
    requestedAt: '2026-07-31T00:00:00.000Z',
    action: {
      contractVersion: '1.0',
      actionToken: ACTION_TOKEN,
      choices: ['answer']
    }
  };
}

function recoveryDecision(): PublicDecisionProjection {
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

function budgetDecision(): PublicDecisionProjection {
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
  decisions: PublicDecisionProjection[],
  failureToken?: string
): Promise<RuntimeStore> {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-decision-routing-'));
  const backend = new SqlitePublicProjectionStore(root);
  let cursor = 0;
  const append = async (changes: PublicProjectionChange[]) => {
    cursor += 1;
    await backend.append({ contractVersion: '5.0', sourceId: 'fixture', sourceCursor: cursor,
      eventId: `fixture-${cursor}`, occurredAt: NOW, changes });
  };
  const sessions = [...new Set(decisions.map(decision => decision.sessionId))];
  await append(sessions.map(id => upsertChange('sessions', session(id), id)));
  // Fixture history starts at version one and reaches the exact authority
  // versions under test; it never inserts an impossible skipped head.
  for (let version = 1; version <= Math.max(...decisions.map(decision => decision.version)); version++) {
    const rows = decisions.filter(decision => decision.version >= version)
      .map(decision => upsertChange('decisions', { ...decision, version }, decision.decisionId));
    if (rows.length > 0) await append(rows);
  }
  const store = new RuntimeStore(successfulRuntimeApi({
    getStatus: async () => READY,
    request: async (command) => {
      commands.push(command);
      if (command.kind.startsWith('projection.')) {
        if (command.kind === 'projection.snapshot.get' || command.kind === 'projection.commits.read') throw new Error('legacy_read_forbidden');
        return readAgentProjectionQuery(backend, command);
      }
      if (command.kind === 'agent.decision.resolve') {
        if (failureToken !== undefined) {
          throw new Error(`Unsafe provider detail: ${failureToken}`);
        }
        const previous = decisions.find(decision => decision.decisionId === command.decisionId)!;
        const { action: _action, ...body } = previous;
        await append([upsertChange('decisions', { ...body, version: previous.version + 1,
          status: command.action.choice === 'deny' || command.action.choice === 'reject' ? 'rejected' : 'approved', resolvedAt: NOW }, previous.decisionId)]);
        return {
          kind: 'agent.decision.resolved',
          runId: command.runId,
          decisionId: command.decisionId,
          runVersion: 2
        };
      }
      throw new Error(`Unexpected command: ${command.kind}`);
    },
    onEvent: () => () => undefined
  }));
  databases.push({ root, backend, renderer: store });
  await store.initialize();
  await store.sessions.select(sessions[0]!);
  return store;
}
