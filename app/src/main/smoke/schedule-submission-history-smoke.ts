import type { BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Exercise the shipped Renderer -> Preload -> Main -> Node IPC -> Schedule authority path. */
export async function verifyScheduleSubmissionHistory(window: BrowserWindow, workspaceId: string, outputRoot: string): Promise<void> {
  const evidence = await window.webContents.executeJavaScript(`(async () => {
    const api = window.ariadne.runtime;
    const scope = { contractVersion: '5.0', workspaceId: ${JSON.stringify(workspaceId)}, sessionId: crypto.randomUUID() };
    const request = async (command, commandId) => {
      const result = await api.request(command, commandId ? { commandId } : undefined);
      if (!result.ok) throw new Error('schedule_smoke_request_failed:' + command.kind + ':' + (commandId ?? 'new') + ':' + JSON.stringify(result));
      return result.value;
    };
    const created = await request({ ...scope, kind: 'conversation.session.create', title: '【验收夹具】调度提交恢复' });
    await request({ ...scope, kind: 'conversation.session.archive', expectedSessionVersion: created.version });
    // An archived session gives a deterministic admission rejection without contacting a Provider.
    const scheduleId = crypto.randomUUID();
    await request({ ...scope, kind: 'schedule.create', scheduleId, prompt: '【验收夹具】调度失败记录',
      timing: { kind: 'once', at: new Date(Date.now() - 1_000).toISOString(), missPolicy: 'run_once' } });
    const query = { ...scope, kind: 'schedule.occurrences.query', before: null, limit: 1 };
    const waitForFailure = async (attempts) => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const page = await request(query);
        const occurrence = page.occurrences[0];
        if (occurrence?.status === 'failed' && occurrence.attempts === attempts) return { page, occurrence };
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('schedule_smoke_settlement_timeout');
    };
    const first = await waitForFailure(1);
    if (first.occurrence.errorCode !== 'schedule_session_unavailable' || !first.occurrence.canRetry) {
      throw new Error('schedule_smoke_failure_projection_invalid');
    }
    const retryId = crypto.randomUUID();
    const retry = { ...scope, kind: 'schedule.occurrence.retry', occurrenceId: first.occurrence.occurrenceId, expectedAttempts: 1 };
    const committed = await request(retry, retryId);
    const replay = await request(retry, retryId);
    if (JSON.stringify(committed) !== JSON.stringify(replay) || committed.occurrence.attempts !== 1) {
      throw new Error('schedule_smoke_retry_receipt_invalid');
    }
    const second = await waitForFailure(2);
    if (second.occurrence.occurrenceId !== first.occurrence.occurrenceId || second.page.occurrences.length !== 1) {
      throw new Error('schedule_smoke_duplicate_occurrence');
    }
    await request({ ...scope, kind: 'schedule.transition', scheduleId, expectedVersion: 2, action: 'cancel' });
    const cancelled = await request(query);
    const denied = await api.request({ ...retry, expectedAttempts: 2 });
    if (cancelled.occurrences[0].canRetry || denied.ok || denied.error.code !== 'schedule_occurrence_retry_unavailable') {
      throw new Error('schedule_smoke_cancelled_retry_not_rejected');
    }
    return { passed: true, sessionId: scope.sessionId, scheduleId,
      occurrenceId: second.occurrence.occurrenceId, firstAttempts: 1, retriedAttempts: 2,
      retryReceiptReplayed: true, cancelledRetryRejected: true, providerUsed: false };
  })()`, true);
  await writeFile(join(outputRoot, 'schedule-submission-history.json'), JSON.stringify(evidence, null, 2), 'utf8');
  await verifyScheduleExecutionResults(window, workspaceId, outputRoot);
}

/** Real scheduled messages must produce Core Runs, exact public results and owned cancellation. */
async function verifyScheduleExecutionResults(window: BrowserWindow, workspaceId: string, outputRoot: string): Promise<void> {
  const evidence = await window.webContents.executeJavaScript(`(async () => {
    const api = window.ariadne.runtime;
    let scope = { contractVersion: '5.0', workspaceId: ${JSON.stringify(workspaceId)}, sessionId: crypto.randomUUID() };
    const request = async command => { const result = await api.request(command);
      if (!result.ok) throw new Error('schedule_execution_request_failed:' + command.kind + ':' + result.error.code); return result.value; };
    const query = async () => (await request({ ...scope, kind: 'schedule.occurrences.query', before: null, limit: 50 })).occurrences[0];
    const snapshot = async (selection = {}) => window.__ariadneSmokeProjection.readFixtureWindow(${JSON.stringify(workspaceId)}, { toolSessionIds: [scope.sessionId], ...selection });
    let phase = 'create';
    const waitFor = async predicate => { const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) { const found = await predicate(); if (found) return found; await new Promise(resolve => setTimeout(resolve, 50)); }
      throw new Error('schedule_execution_timeout:' + phase + ':' + JSON.stringify(await query())); };
    const create = async scenario => {
      await request({ ...scope, kind: 'conversation.session.create', title: '【验收夹具】调度实际执行 ' + scenario });
      await request({ ...scope, kind: 'schedule.create', scheduleId: crypto.randomUUID(), prompt: 'ariadne-smoke:' + scenario,
        timing: { kind: 'once', at: new Date(Date.now() - 1_000).toISOString(), missPolicy: 'run_once' } });
    };
    await create('schedule_complete'); phase = 'actual_completed_result';
    const complete = await waitFor(async () => { const item = await query();
      return item?.status === 'submitted' && item.execution?.status === 'completed' && !item.execution.resultPending ? item : null; });
    if (complete.attempts !== 1 || complete.execution.resultSummary !== 'ARIADNE_SMOKE_SCHEDULE_ACTUAL_RESULT'
      || !complete.execution.runId || complete.nextAttemptAt !== null || complete.attemptDeadlineAt !== null)
      throw new Error('schedule_execution_actual_result_invalid');
    const actual = (await snapshot()).runs.find(run => run.runId === complete.execution.runId);
    if (actual?.sessionId !== scope.sessionId || actual.status !== 'completed') throw new Error('schedule_execution_run_owner_invalid');
    if (JSON.stringify(complete).includes('commandId') || JSON.stringify(complete).includes('messageId')) throw new Error('schedule_execution_private_identity_leak');
    phase = 'production_renderer';
    await window.__ariadneRendererCompositionRootV1.services.sessions.select(scope.sessionId);
    document.querySelector('.module-menu > button').click();
    (await waitFor(() => Array.from(document.querySelectorAll('.module-option')).find(item => item.querySelector('strong')?.textContent === '目标与工作流'))).click();
    await waitFor(() => document.querySelector('.productivity-schedules'));
    for (const details of document.querySelectorAll('.productivity-schedules')) if (!details.open) details.querySelector('summary').click();
    await waitFor(() => Array.from(document.querySelectorAll('.schedule-execution-result')).find(card => card.dataset.scheduleRunId === complete.execution.runId
      && card.textContent.includes('执行完成') && card.textContent.includes('ARIADNE_SMOKE_SCHEDULE_ACTUAL_RESULT')));
    const completedSessionId = scope.sessionId;
    scope = { ...scope, sessionId: crypto.randomUUID() }; await create('schedule_cancel'); phase = 'actual_permission';
    const decision = await waitFor(async () => { const item = await query(); const current = await snapshot();
      return current.decisions.find(value => value.runId === item?.execution?.runId && value.kind === 'permission' && value.status === 'pending' && value.action); });
    await request({ kind: 'agent.decision.resolve', contractVersion: '5.0', runId: decision.runId, decisionId: decision.decisionId,
      action: { contractVersion: decision.action.contractVersion, actionToken: decision.action.actionToken, choice: 'allow_once' } });
    phase = 'actual_tool_active';
    const active = await waitFor(async () => { const item = await query(); const run = (await snapshot()).runs.find(value => value.runId === item?.execution?.runId);
      const tool = run?.toolActivities.find(value => value.toolName === 'browser.wait' && value.status === 'running');
      return tool && item.status === 'submitted' ? { item, run, tool } : null; });
    const receipt = await request({ kind: 'agent.run.cancel', contractVersion: '5.0', runId: active.run.runId,
      expectedVersion: active.run.version, occurredAt: new Date().toISOString(), reason: 'user_requested' });
    if (receipt.kind !== 'agent.run.cancellation.requested') throw new Error('schedule_execution_cancel_premature_terminal');
    phase = 'actual_cancel_join';
    const cancelling = await waitFor(async () => { const item = await query(); return item?.execution?.status === 'cancelling' ? item : null; });
    const cancelled = await waitFor(async () => { const item = await query();
      return item?.execution?.status === 'cancelled' && !item.execution.resultPending ? item : null; });
    const terminal = (await snapshot()).runs.find(value => value.runId === active.run.runId);
    const joined = terminal?.toolActivities.find(value => value.activityId === active.tool.activityId);
    if (cancelled.status !== 'submitted' || cancelled.attempts !== 1 || joined?.status !== 'completed'
      || Date.parse(joined.completedAt) < Date.parse(active.tool.startedAt) + 6_000
      || Date.parse(terminal.completedAt) < Date.parse(joined.completedAt)) throw new Error('schedule_execution_cancel_join_invalid');
    return { passed: true, completedSessionId, completedOccurrenceId: complete.occurrenceId, completedRunId: complete.execution.runId,
      exactAssistantResult: complete.execution.resultSummary, productionRendererResultVisible: true,
      cancelledSessionId: scope.sessionId, cancelledOccurrenceId: cancelled.occurrenceId, cancelledRunId: cancelled.execution.runId,
      cancellationPendingObserved: cancelling.execution.status, submissionRemainedSubmitted: true, actualToolJoined: true,
      toolStartedAt: active.tool.startedAt, toolCompletedAt: joined.completedAt, runCancelledAt: terminal.completedAt,
      privateSubmissionIdentifiersAbsent: true, providerUsed: true };
  })()`, true);
  await writeFile(join(outputRoot, 'schedule-execution-results.json'), JSON.stringify(evidence, null, 2), 'utf8');
}
