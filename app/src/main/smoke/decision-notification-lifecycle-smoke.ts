import type { BrowserWindow } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RuntimeCommand, RuntimeResult } from '@ariadne/protocol/public';
import { DecisionNotificationSource, type DecisionNotificationItem } from '../services/decision-notification-source';
import { installSmokeProjectionProbe } from './projection-probe';
import { TASK_CENTER_DECISION_UI_PROBE } from './task-center-decision-ui-smoke';
import { DatabaseSync } from 'node:sqlite';

interface Receipt { decisionId: string; sessionId: string; runId: string; version: number; shownAt: string }

/** Actual Main/Runtime/HTTPS/native display. This gate cannot accept a physical click. */
export async function verifyDecisionNotificationLifecycle(window: BrowserWindow, root: string,
  outputRoot: string, workspaceId: string, model: string, initialSessionId: string, initialVersion: number): Promise<unknown> {
  await installSmokeProjectionProbe(window);
  const wait = async <T>(probe: () => Promise<T | null>, label: string, timeoutMs = 60_000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await probe(); if (value !== null) return value;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`notification_lifecycle_timeout:${label}`);
  };
  const request = async (command: RuntimeCommand): Promise<RuntimeResult> => {
    const result = await window.webContents.executeJavaScript(`window.ariadne.runtime.request(${JSON.stringify(command)})`, true);
    if (!result.ok) throw new Error(`notification_lifecycle_request_failed:${command.kind}`);
    return result.value as RuntimeResult;
  };
  const source = new DecisionNotificationSource(request);
  const taskCenter = process.env.ARIADNE_SMOKE_TASK_NOTIFICATION_ACCEPTANCE === '1';
  const taskDecisionEvidence: Array<{ passed: boolean; kind: string }> = [];
  const receipts = async (): Promise<Receipt[]> => {
    try {
      const result = JSON.parse(await readFile(join(root, 'decision-notifications.json'), 'utf8')) as { receipts: Receipt[] };
      for (const row of result.receipts) if (Object.keys(row).sort().join(',') !== 'decisionId,runId,sessionId,shownAt,version')
        throw new Error('notification_lifecycle_receipt_not_minimal');
      return result.receipts;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    }
  };
  const createPending = async (sessionId: string, version: number, marker: string, kind: DecisionNotificationItem['kind']) => {
    const accepted = await request({ kind: 'conversation.message.accept', contractVersion: '5.0', workspaceId,
      sessionId, expectedSessionVersion: version, messageId: randomUUID(), content: `ariadne-smoke:${marker}`,
      execution: { mode: 'agent', modelId: model } });
    if (accepted.kind !== 'conversation.message.accepted') throw new Error('notification_lifecycle_accept_result');
    return wait(async () => (await source.read()).find(row => row.sessionId === sessionId && row.kind === kind) ?? null, `pending_${kind}`);
  };
  const mainRestartEnabled = process.env.ARIADNE_SMOKE_NOTIFICATION_MAIN_RESTART === '1';
  const checkpointPath = join(outputRoot, 'main-restart-checkpoint.json');
  let checkpoint: { items: DecisionNotificationItem[]; approvedPlanId: string; beforeRestart: Receipt[];
    restart: { actualReadyGenerationChanged: boolean; settingsRevision: number }; killProof: unknown } | null = null;
  if (mainRestartEnabled) {
    try { checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  }
  let items: DecisionNotificationItem[], approvedPlan: DecisionNotificationItem | undefined;
  let beforeRestart: Receipt[], restart: { actualReadyGenerationChanged: boolean; settingsRevision: number }, killProof: unknown;
  let mainRestart: unknown = null;
  if (checkpoint) {
    const current = await source.read();
    if (checkpoint.items.length !== 4 || new Set(checkpoint.items.map(item => item.decisionId)).size !== 4)
      throw new Error('notification_lifecycle_checkpoint_invalid');
    items = checkpoint.items.map(reference => {
      const item = current.find(row => row.decisionId === reference.decisionId && row.sessionId === reference.sessionId
        && row.runId === reference.runId && row.version === reference.version);
      if (!item) throw new Error('notification_lifecycle_main_pending_changed');
      return item;
    });
    approvedPlan = items.find(item => item.decisionId === checkpoint.approvedPlanId && item.kind === 'plan');
    beforeRestart = checkpoint.beforeRestart; restart = checkpoint.restart; killProof = checkpoint.killProof;
    const proof = JSON.parse(await readFile(join(outputRoot, 'main-restart-proof.json'), 'utf8'));
    if (proof.newMainPid !== process.pid || proof.previousMainPid === process.pid || !proof.physicalOwnedMainKill)
      throw new Error('notification_lifecycle_main_kill_unproved');
    const revision = await window.webContents.executeJavaScript('(async()=>(await window.ariadne.agentSettings.load()).revision)()', true);
    if (revision !== restart.settingsRevision) throw new Error('notification_lifecycle_main_settings_changed');
    window.hide();
    mainRestart = { ...proof, settingsRevisionUnchanged: true, pendingDecisionsRead: items.length };
  } else {
  await wait(async () => window.isFocused() ? true : null, 'foreground');
  const question = await createPending(initialSessionId, initialVersion, 'question', 'user_question');
  await new Promise(resolve => setTimeout(resolve, 500));
  if ((await receipts()).some(row => row.decisionId === question.decisionId)) throw new Error('notification_lifecycle_foreground_not_suppressed');
  window.hide();
  await wait(async () => (await receipts()).find(row => row.decisionId === question.decisionId) ?? null, 'background_question_show');
  items = [question];
  for (const testCase of [{ marker: 'write_allow', kind: 'permission', approve: false },
    { marker: 'notification_plan', kind: 'plan', approve: false },
    { marker: 'notification_plan', kind: 'plan', approve: true }] as const) {
    const sessionId = `notification-${testCase.kind}-${randomUUID()}`;
    const created = await request({ kind: 'conversation.session.create', contractVersion: '5.0', workspaceId, sessionId,
      title: `【验收夹具】${testCase.kind} 通知` });
    if (created.kind !== 'conversation.session.created') throw new Error('notification_lifecycle_create_result');
    const item = await createPending(sessionId, created.version, testCase.marker, testCase.kind);
    items.push(item);
    if (testCase.approve) approvedPlan = item;
    await wait(async () => (await receipts()).find(row => row.decisionId === item.decisionId) ?? null, `${testCase.kind}_native_show`);
    if (taskCenter) taskDecisionEvidence.push(await window.webContents.executeJavaScript(
      `${TASK_CENTER_DECISION_UI_PROBE}(${JSON.stringify(workspaceId)},${JSON.stringify(item.sessionId)},${JSON.stringify(item.runId)},${JSON.stringify(item.decisionId)},${JSON.stringify(item.kind)})`, true));
  }
  beforeRestart = await receipts();
  await writeFile(join(outputRoot, 'lifecycle-native-receipts.json'), JSON.stringify(beforeRestart, null, 2));
  const restartIdentity = await window.webContents.executeJavaScript(`(async()=>({
    status:(await window.ariadne.runtime.getStatus()).value,settingsRevision:(await window.ariadne.agentSettings.load()).revision
  }))()`, true);
  await writeFile(join(outputRoot, 'restart-runtime-request.json'), JSON.stringify({ mainPid: process.pid }));
  restart = await window.webContents.executeJavaScript(`(async()=>{
    const api=window.ariadne, before=${JSON.stringify(restartIdentity)};
    const deadline=Date.now()+90000; while(Date.now()<deadline){const current=(await api.runtime.getStatus()).value;
      if(current?.availability==='ready' && current.observedAt!==before.status.observedAt){
        const revision=(await api.agentSettings.load()).revision;
        if(revision!==before.settingsRevision) throw new Error('notification_lifecycle_restart_changed_settings');
        return {actualReadyGenerationChanged:true,settingsRevision:revision};}
      await new Promise(resolve=>setTimeout(resolve,100));} throw new Error('notification_lifecycle_restart_not_observed');
  })()`, true);
  const runtimeKill = JSON.parse(await readFile(join(outputRoot, 'runtime-restart-proof.json'), 'utf8'));
  killProof = runtimeKill;
  if (runtimeKill.mainPid !== process.pid || runtimeKill.physicalOwnedRuntimeKill !== true)
    throw new Error('notification_lifecycle_physical_restart_proof_missing');
  await wait(async () => {
    const pending = await source.read();
    return items.every(item => pending.some(row => row.decisionId === item.decisionId && row.version === item.version)) ? true : null;
  }, 'restart_pending_read');
  }
  await new Promise(resolve => setTimeout(resolve, 32_000));
  const afterRestart = await receipts();
  if (taskCenter) await window.webContents.executeJavaScript(`(async()=>{const preferences=await window.ariadne.preferences.load();
    await window.ariadne.preferences.update({...preferences,taskNotifications:{completed:true,failed:true}});})()`, true);
  for (const item of items) {
    const before = beforeRestart.find(row => row.decisionId === item.decisionId), after = afterRestart.find(row => row.decisionId === item.decisionId);
    if (!before || !after || JSON.stringify(before) !== JSON.stringify(after)) throw new Error('notification_lifecycle_restart_duplicate');
  }
  if (mainRestartEnabled && !checkpoint) {
    if (!approvedPlan) throw new Error('notification_lifecycle_approved_plan_missing');
    await writeFile(checkpointPath, JSON.stringify({ items, approvedPlanId: approvedPlan.decisionId, beforeRestart, restart, killProof }));
    await writeFile(join(outputRoot, 'restart-main-request.json'), JSON.stringify({ mainPid: process.pid }));
    await wait(async () => null, 'external_main_kill', 120_000);
    throw new Error('notification_lifecycle_main_kill_not_observed');
  }
  const effectsBefore = await window.webContents.executeJavaScript(`window.ariadne.workspace.listDirectory({workspaceId:${JSON.stringify(workspaceId)},relativePath:''})`, true);
  if (effectsBefore.entries.some((entry: { name: string }) => entry.name === 'results')) throw new Error('notification_lifecycle_unapproved_effect');
  for (const item of items) {
    const action = { choice: item.kind === 'permission' ? 'allow_once'
      : item.kind === 'plan' ? item.decisionId === approvedPlan?.decisionId ? 'approve' : 'reject' : 'answer',
      ...(item.kind === 'user_question' ? { answer: 'local: Local only' } : {}) };
    await window.webContents.executeJavaScript(`(async()=>{
      const current=await window.__ariadneSmokeProjection.readFixtureWindow(${JSON.stringify(workspaceId)}),
        decision=current.decisions.find(row=>row.decisionId===${JSON.stringify(item.decisionId)});
      if(!decision?.action || decision.status!=='pending') throw new Error('notification_lifecycle_action_not_pending');
      const result=await window.ariadne.runtime.request({kind:'agent.decision.resolve',contractVersion:'5.0',
        runId:decision.runId,decisionId:decision.decisionId,action:{contractVersion:decision.action.contractVersion,
          actionToken:decision.action.actionToken,...${JSON.stringify(action)}}});
      if(!result.ok || result.value.kind!=='agent.decision.resolved') throw new Error('notification_lifecycle_resolution_failed');
    })()`, true);
    await wait(async () => {
      const current = await source.readCurrent(item);
      return current && current.status !== 'pending' && current.version > item.version ? current : null;
    }, `${item.kind}_settled`);
  }
  await wait(async () => (await receipts()).length === 0 ? true : null, 'settlement_receipts_pruned');
  const effects = await wait(async () => {
    const directory = await window.webContents.executeJavaScript(`window.ariadne.workspace.listDirectory({workspaceId:${JSON.stringify(workspaceId)},relativePath:''})`, true);
    if (!directory.entries.some((entry: { name: string }) => entry.name === 'results')) return null;
    const result = await window.webContents.executeJavaScript(`window.ariadne.workspace.listDirectory({workspaceId:${JSON.stringify(workspaceId)},relativePath:'results'})`, true);
    return result.entries.some((entry: { name: string }) => entry.name === 'allow.txt') ? true : null;
  }, 'approved_effect');
  if (!approvedPlan) throw new Error('notification_lifecycle_approved_plan_missing');
  await wait(async () => {
    const current = await window.webContents.executeJavaScript(`window.__ariadneSmokeProjection.readFixtureWindow(${JSON.stringify(workspaceId)})`, true);
    return current.runs.some((run: { runId: string; status: string }) => run.runId === approvedPlan.runId && run.status === 'completed') ? true : null;
  }, 'approved_plan_continuation_completed');
  let taskReminders: unknown = null;
  if (taskCenter) {
    if (!taskDecisionEvidence.some(value => value.kind === 'plan' && value.passed)
      || !taskDecisionEvidence.some(value => value.kind === 'permission' && value.passed)) throw new Error('task_notification_original_focus_missing');
    const delivered = await wait(async () => {
      const database = new DatabaseSync(join(root, 'notification-delivery.db'), { readOnly: true });
      try { return database.prepare('SELECT run_id,workspace_id,session_id,version,state,source_status,shown_at FROM notification_delivery WHERE run_id=? AND shown_at IS NOT NULL').get(approvedPlan!.runId) ?? null; }
      finally { database.close(); }
    }, 'terminal_task_native_shown');
    const failureSessionId = `task-notification-failure-${randomUUID()}`;
    const created = await request({ kind: 'conversation.session.create', contractVersion: '5.0', workspaceId,
      sessionId: failureSessionId, title: '【验收夹具】原引擎拒绝无效模型结果' });
    if (created.kind !== 'conversation.session.created') throw new Error('task_notification_failure_session_missing');
    const accepted = await request({ kind: 'conversation.message.accept', contractVersion: '5.0', workspaceId,
      sessionId: failureSessionId, expectedSessionVersion: created.version, messageId: randomUUID(),
      content: 'ariadne-smoke:notification_failure', execution: { mode: 'agent', modelId: model } });
    if (accepted.kind !== 'conversation.message.accepted') throw new Error('task_notification_failure_accept_missing');
    const failedRun = await wait(async () => {
      const result = await request({ kind: 'tasks.query', contractVersion: '1.0', cursor: null, limit: 1, refresh: true,
        filter: { reference: null, workspaceId, sessionId: failureSessionId, includeArchived: false, sources: ['run'], states: ['failed'],
          updatedFrom: null, updatedThrough: null } });
      return result.kind === 'tasks.query_result' ? result.rows[0]?.metadata ?? null : null;
    }, 'terminal_task_original_failed_run');
    const failedDelivery = await wait(async () => {
      const database = new DatabaseSync(join(root, 'notification-delivery.db'), { readOnly: true });
      try { return database.prepare("SELECT run_id,workspace_id,session_id,version,state,source_status,shown_at FROM notification_delivery WHERE run_id=? AND state='failed' AND shown_at IS NOT NULL").get(failedRun.reference.sourceId) ?? null; }
      finally { database.close(); }
    }, 'terminal_failed_task_native_shown');
    if (failedDelivery.version !== failedRun.version || failedDelivery.workspace_id !== workspaceId || failedDelivery.session_id !== failureSessionId)
      throw new Error('task_notification_failure_delivery_owner_changed');
    await writeFile(join(outputRoot, 'task-center-original-plan-focus.json'), JSON.stringify(taskDecisionEvidence, null, 2));
    taskReminders = { completedRunNativeShown: true, failedRunNativeShown: true, displayReceipt: delivered, failureDisplayReceipt: failedDelivery,
      failedThroughOriginalInferenceContract: true, originalPlanAndPermissionFocus: true,
      scope: 'Actual Core/Provider/result and native shown callback; no physical toast click or terminal-reminder Main restart acceptance.' };
  }
  return { nativeLifecycleCompleted: true, actualWindowsClickObserved: false, foregroundSuppressed: true,
    backgroundResumptionNativeShown: true, realProductionDecisionKinds: items.map(item => item.kind),
    minimalNativeReceipts: beforeRestart, runtimeRestart: { ...restart, killProof }, sameVersionDedupAcrossTwoPolls: true,
    allDecisionsSettled: true, derivedReceiptsPruned: true, unapprovedEffectAbsent: true, approvedEffectObserved: effects,
    approvedPlanContinuationCompleted: true, actualDecisionsSettled: items.length,
    mainRestart, taskReminders,
    scope: mainRestart ? 'Actual native show callbacks and physical Main/Runtime restart; no physical click, toast pixels or active-game detector acceptance.'
      : 'Actual native show callbacks; no physical click, toast pixels, Main restart or active-game detector acceptance.' };
}
