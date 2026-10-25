import type { BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TASK_CENTER_DECISION_UI_PROBE } from './task-center-decision-ui-smoke';

/** Shipped UI and Runtime worker create ordinary Agent Runs; native Provider and Main Tool settle them. */
export async function verifyWorkflowAgentExecution(window: BrowserWindow, workspaceId: string, outputRoot: string): Promise<void> {
  const evidence = await window.webContents.executeJavaScript(`(async () => {
    const api = window.ariadne.runtime;
    const scope = { contractVersion: '5.0', workspaceId: ${JSON.stringify(workspaceId)}, sessionId: crypto.randomUUID() };
    const request = async (command, commandId) => {
      const result = await api.request(command, commandId ? { commandId } : undefined);
      if (!result.ok) throw new Error('workflow_smoke_request_failed:' + command.kind + ':' + result.error.code);
      return result.value;
    };
    const query = () => request({ ...scope, kind: 'productivity.query' });
    const snapshot = async (selection = {}) => window.__ariadneSmokeProjection.readFixtureWindow(${JSON.stringify(workspaceId)}, selection);
    let phase = 'create';
    const waitFor = async predicate => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) { const value = await predicate(); if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 100)); }
      throw new Error('workflow_smoke_timeout:' + phase + ':' + JSON.stringify({
        workflows: (await query()).workflows,
        panel: document.querySelector('.productivity-panel')?.textContent ?? 'missing'
      }));
    };
    await request({ ...scope, kind: 'conversation.session.create', title: '【验收夹具】自动工作流' });
    phase = 'seed_context';
    await request({ ...scope, kind: 'conversation.message.accept', expectedSessionVersion: 1,
      messageId: crypto.randomUUID(), content: 'ariadne-smoke:workflow_context_seed ARIADNE_SMOKE_WORKFLOW_FROZEN_REQUIREMENT', execution: { mode: 'agent' } });
    await waitFor(async () => (await snapshot()).messages.some(message => message.sessionId === scope.sessionId
      && message.role === 'assistant' && message.content === 'ARIADNE_SMOKE_WORKFLOW_CONTEXT_SEEDED'));
    const parentVersion = (await snapshot()).sessions.find(session => session.sessionId === scope.sessionId).version;
    const goal = await request({ ...scope, kind: 'goal.put', goalId: crypto.randomUUID(), expectedVersion: null,
      title: '【验收夹具】真实 Agent 执行闭环', phase: 'implementation', status: 'active', roundCap: 8 });
    const todoIds = Array.from({ length: 3 }, () => crypto.randomUUID());
    await request({ ...scope, kind: 'todo.snapshot.replace', goalId: goal.goal.goalId, expectedGoalVersion: goal.goal.version,
      expectedRevision: null, items: todoIds.map((todoId, index) => ({ todoId, title: 'ariadne-smoke:workflow_complete task ' + index,
        status: 'pending', dependsOn: index === 2 ? todoIds.slice(0, 2) : [] })) });
    const commandId = crypto.randomUUID();
    const command = { ...scope, kind: 'workflow.start', workflowId: crypto.randomUUID(), goalId: goal.goal.goalId,
      expectedGoalVersion: goal.goal.version, expectedTodoRevision: 1, todoIds, maxConcurrency: 2,
      maxTransitions: 3, executionMode: 'agent', deadlineAt: new Date(Date.now() + 120_000).toISOString() };
    const accepted = await request(command, commandId);
    if (accepted.workflow.activeTodoIds.includes(todoIds[2])) throw new Error('workflow_smoke_dependency_started_early');
    phase = 'change_parent_context';
    await request({ ...scope, kind: 'conversation.message.accept', expectedSessionVersion: parentVersion,
      messageId: crypto.randomUUID(), content: 'ariadne-smoke:workflow_context_later ARIADNE_SMOKE_WORKFLOW_LATER_REQUIREMENT', execution: { mode: 'agent' } });
    let maximumActive = 0;
    phase = 'automatic_completion';
    const completed = await waitFor(async () => {
      const snapshot = await query(); const workflow = snapshot.workflows.find(item => item.workflowId === command.workflowId);
      maximumActive = Math.max(maximumActive, workflow.activeTodoIds.length);
      if (maximumActive > 2) throw new Error('workflow_smoke_concurrency_exceeded');
      return workflow.status === 'completed' ? { snapshot, workflow } : null;
    });
    const links = completed.workflow.taskRuns;
    if (links.length !== 3 || new Set(links.map(item => item.runId)).size !== 3
      || completed.workflow.results.some(item => item.outcome !== 'completed')
      || completed.snapshot.todos.some(item => item.status !== 'completed')) throw new Error('workflow_smoke_result_invalid');
    if (JSON.stringify(await request(command, commandId)) !== JSON.stringify(accepted)) throw new Error('workflow_smoke_start_replay_invalid');
    phase = 'completed_run_projection';
    const projection = await waitFor(async () => {
      const current = await snapshot();
      return links.every(link => current.runs.some(run => run.runId === link.runId && run.status === 'completed')
        && current.messages.some(message => message.sessionId === link.sessionId && message.role === 'assistant'
          && message.content === 'ARIADNE_SMOKE_WORKFLOW_TASK_COMPLETED_' + todoIds.indexOf(link.todoId)))
        ? current : null;
    });
    for (const link of links) {
      const run = projection.runs.find(item => item.runId === link.runId && item.sessionId === link.sessionId);
      if (run?.status !== 'completed') throw new Error('workflow_smoke_run_result_missing');
    }
    const descendant = projection.messages.find(message => message.sessionId === links.find(link => link.todoId === todoIds[2]).sessionId && message.role === 'user');
    if (!descendant?.content.includes('ARIADNE_SMOKE_WORKFLOW_TASK_COMPLETED_0')
      || !descendant.content.includes('ARIADNE_SMOKE_WORKFLOW_TASK_COMPLETED_1')) throw new Error('workflow_smoke_dependency_outputs_missing');
    const cancelTodo = crypto.randomUUID();
    await request({ ...scope, kind: 'todo.snapshot.replace', goalId: completed.snapshot.goal.goalId,
      expectedGoalVersion: completed.snapshot.goal.version, expectedRevision: completed.snapshot.todoRevision,
      items: [...completed.snapshot.todos.map(({ ordinal, ...todo }) => todo),
        { todoId: cancelTodo, title: 'ariadne-smoke:workflow_cancel', status: 'pending' }] });
    const services = window.__ariadneRendererCompositionRootV1?.services;
    phase = 'open_module';
    await services.sessions.select(scope.sessionId);
    const menu = document.querySelector('.module-menu > button');
    if (!menu) throw new Error('workflow_smoke_module_menu_missing'); menu.click();
    const navigation = await waitFor(() => Array.from(document.querySelectorAll('.module-option'))
      .find(item => item.querySelector('strong')?.textContent === '目标与工作流'));
    navigation.click();
    phase = 'start_button';
    const startButton = await waitFor(() => Array.from(document.querySelectorAll('.productivity-panel button'))
      .find(button => button.textContent === '启动工作流' && !button.disabled));
    startButton.click();
    phase = 'native_tool_permission';
    const permission = await waitFor(async () => {
      const productivity = await query();
      const workflow = productivity.workflows.find(item => item.workflowId !== command.workflowId);
      const runId = workflow?.taskRuns?.[0]?.runId;
      if (!runId) return null;
      const current = await snapshot();
      return current.decisions.find(item => item.runId === runId && item.kind === 'permission'
        && item.status === 'pending' && item.action) ?? null;
    });
    window.__taskCenterPermissionSourceEvidence=await ${TASK_CENTER_DECISION_UI_PROBE}(scope.workspaceId,permission.sessionId,permission.runId,permission.decisionId,'permission');
    await services.sessions.select(scope.sessionId);
    services.events.emit('module:open','productivity.control');
    await waitFor(()=>document.querySelector('.productivity-panel')?.checkVisibility());
    await request({ kind: 'agent.decision.resolve', contractVersion: '5.0', runId: permission.runId,
      decisionId: permission.decisionId, action: { contractVersion: permission.action.contractVersion,
        actionToken: permission.action.actionToken, choice: 'allow_once' } });
    phase = 'native_tool_started';
    const active = await waitFor(async () => {
      const productivity = await query(); const workflow = productivity.workflows.find(item => item.workflowId !== command.workflowId);
      if (!workflow?.taskRuns?.[0]?.runId) return null;
      const current = await snapshot({ toolRunIds: [workflow.taskRuns[0].runId] });
      const run = current.runs.find(item => item.runId === workflow.taskRuns[0].runId);
      const tool = run?.toolActivities.find(item => item.toolName === 'browser.wait' && item.status === 'running');
      return tool ? { workflow, run, tool } : null;
    });
    const refresh = Array.from(document.querySelectorAll('.productivity-panel button')).find(button => button.textContent === '刷新');
    refresh.click();
    phase = 'cancel_button';
    const cancelButton = await waitFor(() => {
      const cards = Array.from(document.querySelectorAll('.productivity-card'));
      const card = cards.find(item => item.dataset.workflowId === active.workflow.workflowId && item.textContent.includes('ariadne-smoke:workflow_cancel'));
      if (card?.dataset.workflowVersion !== String(active.workflow.version) || card.dataset.workflowStatus !== 'running'
        || !card.querySelector('h2')?.textContent.includes('执行中')) return null;
      if (Array.from(card.querySelectorAll('button')).some(button => ['完成', '失败'].includes(button.textContent))) throw new Error('workflow_smoke_manual_result_offered');
      return Array.from(card.querySelectorAll('button')).find(button => button.textContent === '取消工作流' && !button.disabled);
    });
    cancelButton.click();
    phase = 'cancellation_pending';
    const pending = await waitFor(async () => {
      const workflow = (await query()).workflows.find(item => item.workflowId === active.workflow.workflowId);
      const run = (await snapshot({ toolRunIds: [active.run.runId] })).runs.find(item => item.runId === active.run.runId);
      return workflow.status === 'cancelling' && run.toolActivities.some(item => item.activityId === active.tool.activityId && item.status === 'running')
        ? { workflow, run } : null;
    });
    phase = 'pending_renderer';
    await waitFor(() => document.querySelector('.productivity-panel')?.textContent.includes('正在取消，等待任务 Run 确认结束'));
    phase = 'actual_tool_joined';
    const terminal = await waitFor(async () => {
      const workflow = (await query()).workflows.find(item => item.workflowId === active.workflow.workflowId);
      const run = (await snapshot({ toolRunIds: [active.run.runId] })).runs.find(item => item.runId === active.run.runId);
      return workflow.status === 'cancelled' ? { workflow, run } : null;
    });
    const tool = terminal.run.toolActivities.find(item => item.activityId === active.tool.activityId);
    if (terminal.run.status !== 'cancelled' || tool.status !== 'completed'
      || Date.parse(tool.completedAt) < Date.parse(active.tool.startedAt) + 6_000) throw new Error('workflow_smoke_cancel_did_not_join_tool');
    return { passed: true, sessionId: scope.sessionId, workflowId: command.workflowId,
      completedRunIds: links.map(item => item.runId), maximumActive, startReceiptReplayed: true,
      frozenParentContextVerifiedAtNativeProvider: true, laterParentContextExcluded: true,
      dependencyJoinVerified: true, exactPredecessorOutputsPassedToDependentRun: true,
      toolPermissionRequiredAndExplicitlyResolved: true,
      productionRendererStartedAgentWorkflow: true, productionRendererCancelledWorkflow: true,
      cancellationWorkflowId: active.workflow.workflowId, cancellationRunId: active.run.runId,
      cancellingVersion: pending.workflow.version, terminalVersion: terminal.workflow.version,
      actualToolJoined: true, toolStartedAt: active.tool.startedAt, toolCompletedAt: tool.completedAt };
  })()`, true);
  await writeFile(join(outputRoot, 'workflow-agent-execution.json'), JSON.stringify(evidence, null, 2), 'utf8');
}
