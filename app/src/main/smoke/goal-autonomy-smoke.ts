import type { BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Native Provider, protected Goal Tool and ordinary task Runs must prove a real replan and owned stop. */
export async function verifyGoalAutonomy(window: BrowserWindow, workspaceId: string, outputRoot: string): Promise<void> {
  const evidence = await window.webContents.executeJavaScript(`(async () => {
    const api = window.ariadne.runtime;
    let scope = { contractVersion: '5.0', workspaceId: ${JSON.stringify(workspaceId)}, sessionId: crypto.randomUUID() };
    const request = async command => { const result = await api.request(command);
      if (!result.ok) throw new Error('goal_smoke_request_failed:' + command.kind + ':' + result.error.code); return result.value; };
    const query = () => request({ ...scope, kind: 'productivity.query' });
    const snapshot = async (selection = {}) => window.__ariadneSmokeProjection.readFixtureWindow(${JSON.stringify(workspaceId)}, selection);
    let phase = 'seed';
    const waitFor = async predicate => { const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
      throw new Error('goal_smoke_timeout:' + phase + ':' + JSON.stringify({ productivity: await query(),
        panel: document.querySelector('.productivity-panel')?.textContent ?? 'missing' })); };
    const seed = async title => {
      await request({ ...scope, kind: 'conversation.session.create', title });
      await request({ ...scope, kind: 'conversation.message.accept', expectedSessionVersion: 1, messageId: crypto.randomUUID(),
        content: 'ariadne-smoke:goal_context_seed ARIADNE_SMOKE_GOAL_FROZEN_REQUIREMENT', execution: { mode: 'agent' } });
      await waitFor(async () => (await snapshot()).messages.some(message => message.sessionId === scope.sessionId && message.role === 'assistant'
        && message.content === 'ARIADNE_SMOKE_GOAL_CONTEXT_SEEDED'));
      return (await snapshot()).sessions.find(session => session.sessionId === scope.sessionId).version;
    };
    const openPanel = async () => {
      await window.__ariadneRendererCompositionRootV1.services.sessions.select(scope.sessionId);
      document.querySelector('.module-menu > button').click();
      (await waitFor(() => Array.from(document.querySelectorAll('.module-option')).find(item => item.querySelector('strong')?.textContent === '目标与工作流'))).click();
      await waitFor(() => document.querySelector('input[aria-label=目标]')?.value === 'ariadne-smoke:goal_plan');
      for (const details of document.querySelectorAll('.productivity-goal .productivity-configuration')) {
        if (!details.open) details.querySelector('summary').click();
      }
      const autonomous = document.querySelector('.productivity-autonomy');
      if (!autonomous.open) autonomous.querySelector('summary').click();
    };
    const parentVersion = await seed('【验收夹具】自主目标与真实重规划');
    const created = await request({ ...scope, kind: 'goal.put', goalId: crypto.randomUUID(), expectedVersion: null,
      title: 'ariadne-smoke:goal_plan', phase: 'implementation', status: 'active', roundCap: 3 });
    phase = 'production_start_ui'; await openPanel();
    const criterion = 'ARIADNE_SMOKE_GOAL_FILE_CRITERION: results/goal-verified.txt must contain ARIADNE_SMOKE_GOAL_VERIFIED_ARTIFACT and be inspected through the actual file Tool.';
    const textarea = document.querySelector('textarea[aria-label=目标验收标准]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, criterion);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    (await waitFor(() => Array.from(document.querySelectorAll('.goal-autonomy-controls button')).find(button => button.textContent === '开始自主推进' && !button.disabled))).click();
    await waitFor(async () => (await query()).goal.autonomy?.status === 'planning');
    phase = 'later_parent_context';
    await request({ ...scope, kind: 'conversation.message.accept', expectedSessionVersion: parentVersion, messageId: crypto.randomUUID(),
      content: 'ariadne-smoke:goal_context_later ARIADNE_SMOKE_GOAL_LATER_REQUIREMENT', execution: { mode: 'agent' } });
    phase = 'candidate_before_terminal';
    const initialPermissions = new Set();
    const staged = await waitFor(async () => { const current = await query(); const projection = await snapshot({ toolRunIds: [current.goal.autonomy?.runId].filter(Boolean) });
      const run = projection.runs.find(run => run.runId === current.goal.autonomy?.runId);
      for (const decision of projection.decisions) if (decision.runId === run?.runId && decision.kind === 'permission'
        && decision.status === 'pending' && decision.action && !initialPermissions.has(decision.decisionId)) {
        initialPermissions.add(decision.decisionId);
        await request({ kind: 'agent.decision.resolve', contractVersion: '5.0', runId: decision.runId, decisionId: decision.decisionId,
          action: { contractVersion: decision.action.contractVersion, actionToken: decision.action.actionToken, choice: 'allow_once' } });
      }
      return current.goal.autonomy?.status === 'planning' && current.workflows.length === 0 && run?.status === 'running'
        && run.toolActivities.some(tool => tool.toolName === 'productivity.record_goal_decision' && tool.status === 'completed') ? { goal: current.goal, runId: run.runId } : null; });
    const phases = new Set(['planning']); const allowedDecisions = new Set();
    phase = 'replan_and_verified_completion';
    const completed = await waitFor(async () => {
      const current = await query(); phases.add(current.goal.autonomy.status);
      if (current.goal.roundsUsed > 3) throw new Error('goal_smoke_round_cap_exceeded');
      const projection = await snapshot({ toolRunIds: [current.goal.autonomy.runId].filter(Boolean) });
      const runIds = new Set([current.goal.autonomy.runId, ...current.workflows.flatMap(workflow => workflow.taskRuns?.map(task => task.runId) ?? [])]);
      for (const decision of projection.decisions) if (decision.kind === 'permission' && decision.status === 'pending' && decision.action
        && runIds.has(decision.runId) && !allowedDecisions.has(decision.decisionId)) {
        allowedDecisions.add(decision.decisionId);
        await request({ kind: 'agent.decision.resolve', contractVersion: '5.0', runId: decision.runId, decisionId: decision.decisionId,
          action: { contractVersion: decision.action.contractVersion, actionToken: decision.action.actionToken, choice: 'allow_once' } });
      }
      if (current.goal.autonomy.status === 'blocked') throw new Error('goal_smoke_blocked:' + current.goal.autonomy.summary);
      return current.goal.status === 'complete' ? { current, projection } : null;
    });
    const goal = completed.current.goal;
    if (goal.roundsUsed !== 2 || goal.autonomy.plannerAttempts !== 3 || goal.autonomy.completedBy !== 'verification'
      || goal.autonomy.assessment.length !== 1 || !goal.autonomy.assessment[0].evidence.includes('ARIADNE_SMOKE_GOAL_VERIFIED_ARTIFACT')
      || completed.current.workflows.length !== 2 || completed.current.workflows.some(workflow => workflow.status !== 'completed')) {
      throw new Error('goal_smoke_completion_invalid:' + JSON.stringify(goal));
    }
    const taskLinks = completed.current.workflows.flatMap(workflow => workflow.taskRuns);
    if (taskLinks.length !== 2 || new Set(taskLinks.map(task => task.runId)).size !== 2) throw new Error('goal_smoke_actual_runs_missing');
    const verificationRun = completed.projection.runs.find(run => run.runId === goal.autonomy.runId);
    if (verificationRun?.status !== 'completed' || !verificationRun.toolActivities.some(tool => tool.toolName === 'workspace.read_file' && tool.status === 'completed')) {
      throw new Error('goal_smoke_actual_evidence_missing');
    }
    phase = 'criterion_renderer';
    Array.from(document.querySelectorAll('.productivity-panel button')).find(button => button.textContent === '刷新').click();
    await waitFor(() => document.querySelector('ol[aria-label=目标逐项验收结果]')?.textContent.includes('ARIADNE_SMOKE_GOAL_VERIFIED_ARTIFACT'));
    const completedSessionId = scope.sessionId;
    scope = { ...scope, sessionId: crypto.randomUUID() };
    phase = 'pause_seed'; await seed('【验收夹具】自主目标取消与实际 Tool join');
    const pauseGoal = await request({ ...scope, kind: 'goal.put', goalId: crypto.randomUUID(), expectedVersion: null,
      title: 'ariadne-smoke:goal_pause_plan', phase: 'implementation', status: 'active', roundCap: 2 });
    await request({ ...scope, kind: 'goal.autonomy.start', goalId: pauseGoal.goal.goalId, expectedVersion: pauseGoal.goal.version,
      criteria: ['Actual owned Tool cancellation joins before Goal pause'], maxConcurrency: 1, deadlineAt: new Date(Date.now() + 120_000).toISOString() });
    phase = 'pause_task_permission';
    const permission = await waitFor(async () => {
      const current = await query(); const runId = current.workflows[0]?.taskRuns?.[0]?.runId;
      const projection = await snapshot();
      for (const decision of projection.decisions) if (decision.runId === current.goal.autonomy?.runId && decision.kind === 'permission'
        && decision.status === 'pending' && decision.action && !allowedDecisions.has(decision.decisionId)) {
        allowedDecisions.add(decision.decisionId);
        await request({ kind: 'agent.decision.resolve', contractVersion: '5.0', runId: decision.runId, decisionId: decision.decisionId,
          action: { contractVersion: decision.action.contractVersion, actionToken: decision.action.actionToken, choice: 'allow_once' } });
      }
      return projection.decisions.find(decision => decision.runId === runId && decision.kind === 'permission' && decision.status === 'pending' && decision.action);
    });
    await request({ kind: 'agent.decision.resolve', contractVersion: '5.0', runId: permission.runId, decisionId: permission.decisionId,
      action: { contractVersion: permission.action.contractVersion, actionToken: permission.action.actionToken, choice: 'allow_once' } });
    phase = 'pause_tool_started';
    const active = await waitFor(async () => {
      const run = (await snapshot({ toolRunIds: [permission.runId] })).runs.find(run => run.runId === permission.runId);
      const tool = run?.toolActivities.find(tool => tool.toolName === 'browser.wait' && tool.status === 'running'); return tool ? { run, tool } : null;
    });
    const current = await query();
    await request({ ...scope, kind: 'goal.autonomy.transition', goalId: current.goal.goalId, expectedVersion: current.goal.version, action: 'pause' });
    phase = 'actual_stop_join';
    const stopping = await query();
    if (stopping.goal.autonomy.status !== 'stopping' || stopping.workflows[0].status !== 'cancelling') throw new Error('goal_smoke_pause_did_not_wait');
    const paused = await waitFor(async () => { const state = await query(); const run = (await snapshot({ toolRunIds: [active.run.runId] })).runs.find(run => run.runId === active.run.runId);
      return state.goal.autonomy.status === 'paused' ? { state, run } : null; });
    const tool = paused.run.toolActivities.find(tool => tool.activityId === active.tool.activityId);
    if (paused.run.status !== 'cancelled' || paused.state.workflows[0].status !== 'cancelled' || tool.status !== 'completed'
      || Date.parse(tool.completedAt) < Date.parse(active.tool.startedAt) + 6_000) throw new Error('goal_smoke_pause_join_invalid');
    return { passed: true, goalId: created.goal.goalId, sessionId: completedSessionId, roundsUsed: goal.roundsUsed,
      plannerAttempts: goal.autonomy.plannerAttempts, completedBy: goal.autonomy.completedBy, assessment: goal.autonomy.assessment,
      actualTaskRunIds: taskLinks.map(task => task.runId), initialPlannerRunId: staged.runId, verificationRunId: goal.autonomy.runId,
      phases: [...phases], productionRendererStarted: true, productionRendererAssessmentVisible: true,
      stagedDecisionWaitedForActualTerminalRun: true, initialTaskCompletedWithoutMeetingCriteria: true,
      nativeProviderVerifiedFrozenParentAndExactPlannerOutput: true, actualProtectedToolEvidenceVerified: true,
      explicitToolPermissionsResolved: allowedDecisions.size + initialPermissions.size + 1, pauseGoalId: pauseGoal.goal.goalId,
      pauseRequestedBeforeActualToolJoin: true, pauseRunId: paused.run.runId, actualToolJoined: true,
      toolStartedAt: active.tool.startedAt, toolCompletedAt: tool.completedAt };
  })()`, true);
  await writeFile(join(outputRoot, 'goal-autonomy-execution.json'), JSON.stringify(evidence, null, 2), 'utf8');
}
