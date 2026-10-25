import type { BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Actual non-cooperative Main-owned browser wait must settle before Run cancellation. */
export async function verifyEffectCancellation(window: BrowserWindow, workspaceId: string, modelId: string, outputRoot: string): Promise<void> {
  const evidence = await window.webContents.executeJavaScript(`(async () => {
    const api = window.ariadne.runtime;
    const request = async (command, commandId) => {
      const result = await api.request(command, commandId ? { commandId } : undefined);
      if (!result.ok) throw new Error('effect_cancel_request_failed:' + command.kind + ':' + JSON.stringify(result));
      return result.value;
    };
    const snapshot = async (selection = {}) => window.__ariadneSmokeProjection.readFixtureWindow(${JSON.stringify(workspaceId)}, { toolSessionIds: [scope.sessionId], toolStatuses: ['interrupted'], ...selection });
    const waitFor = async predicate => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const found = predicate(await snapshot());
        if (found) return found;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('effect_cancel_timeout:' + JSON.stringify((await snapshot()).runs.filter(run => run.sessionId === scope.sessionId)));
    };
    const scope = { contractVersion: '5.0', workspaceId: ${JSON.stringify(workspaceId)}, sessionId: crypto.randomUUID() };
    const created = await request({ ...scope, kind: 'conversation.session.create', title: '【验收夹具】工具执行期间取消' });
    const messageId = crypto.randomUUID();
    await request({ ...scope, kind: 'conversation.message.accept', expectedSessionVersion: created.version, messageId,
      content: 'ariadne-smoke:cancel_effect', execution: { mode: 'agent', modelId: ${JSON.stringify(modelId)} } });
    const run = await waitFor(current => current.runs.find(value => value.sourceMessageId === messageId));
    const decision = await waitFor(current => current.decisions.find(value => value.runId === run.runId && value.kind === 'permission' && value.status === 'pending' && value.action));
    await request({ kind: 'agent.decision.resolve', contractVersion: '5.0', runId: run.runId, decisionId: decision.decisionId,
      action: { contractVersion: decision.action.contractVersion, actionToken: decision.action.actionToken, choice: 'allow_once' } });
    const active = await waitFor(current => {
      const value = current.runs.find(value => value.runId === run.runId);
      const tool = value?.toolActivities.find(tool => tool.toolName === 'browser.wait' && tool.status === 'running');
      return tool ? { run: value, tool } : null;
    });
    const inputs = [];
    for (let index = 0; index < 4; index += 1) inputs.push(await request({ kind: 'agent.inbox.enqueue', contractVersion: '5.0',
      runId: run.runId, sessionId: scope.sessionId, inputId: crypto.randomUUID(), delivery: 'next_turn', content: 'EFFECT_CANCEL_INBOX_' + index }));
    const updated = await waitFor(current => current.runs.find(value => value.runId === run.runId && value.version >= inputs.at(-1).runVersion));
    const commandId = crypto.randomUUID();
    const command = { kind: 'agent.run.cancel', contractVersion: '5.0', runId: run.runId,
      expectedVersion: updated.version, occurredAt: new Date().toISOString(), reason: 'user_requested' };
    const accepted = await request(command, commandId);
    if (accepted.kind !== 'agent.run.cancellation.requested') throw new Error('effect_cancel_premature_terminal_receipt');
    const pending = await waitFor(current => current.runs.find(value => value.runId === run.runId && value.status === 'cancelling'
      && value.toolActivities.some(tool => tool.activityId === active.tool.activityId && tool.status === 'running')));
    const terminal = await waitFor(current => current.runs.find(value => value.runId === run.runId && value.status === 'cancelled'));
    const completedTool = terminal.toolActivities.find(tool => tool.activityId === active.tool.activityId);
    if (completedTool?.status !== 'completed' || Date.parse(completedTool.completedAt) < Date.parse(active.tool.startedAt) + 6_000)
      throw new Error('effect_cancel_did_not_join_actual_tool');
    if (Date.parse(terminal.completedAt) < Date.parse(completedTool.completedAt)) throw new Error('effect_cancel_run_precedes_tool_end');
    if (JSON.stringify(await request(command, commandId)) !== JSON.stringify(accepted)) throw new Error('effect_cancel_receipt_replay_invalid');
    // The main smoke already lost Runtime ownership during a browser.wait. Keep that unknown outcome authoritative.
    const unknown = await waitFor(current => {
      const value = current.runs.find(value => value.status === 'interrupted'
        && value.toolActivities.some(tool => tool.toolName === 'browser.wait' && tool.status === 'failed' && !tool.detailAvailable));
      const decision = value && current.decisions.find(decision => decision.runId === value.runId && decision.kind === 'recovery' && decision.status === 'pending' && decision.action);
      return value && decision ? { run: value, decision } : null;
    });
    const unknownCommandId = crypto.randomUUID();
    const unknownCommand = { kind: 'agent.run.cancel', contractVersion: '5.0', runId: unknown.run.runId,
      expectedVersion: unknown.run.version, occurredAt: new Date().toISOString(), reason: 'user_requested' };
    const unknownAccepted = await request(unknownCommand, unknownCommandId);
    if (unknownAccepted.kind !== 'agent.run.cancellation.requested') throw new Error('unknown_effect_cancel_fabricated_terminal');
    const recoveryPending = await waitFor(current => current.runs.find(value => value.runId === unknown.run.runId
      && value.status === 'interrupted' && value.cancellationPending === true));
    const retry = await api.request({ kind: 'agent.decision.resolve', contractVersion: '5.0', runId: unknown.run.runId,
      decisionId: unknown.decision.decisionId, action: { contractVersion: unknown.decision.action.contractVersion,
        actionToken: unknown.decision.action.actionToken, choice: 'retry' } });
    if (retry.ok) throw new Error('unknown_effect_cancel_allowed_retry');
    const services = window.__ariadneRendererCompositionRootV1?.services;
    if (!services) throw new Error('effect_cancel_renderer_services_missing');
    await services.sessions.select(unknown.run.sessionId);
    const agentButton = document.querySelector('.activity-bar button[aria-label="Agent"]');
    if (!agentButton) throw new Error('effect_cancel_agent_navigation_missing');
    agentButton.click();
    const confirmation = await waitFor(() => {
      const panel = document.querySelector('.agent-status-panel');
      if (!panel?.textContent.includes('已收到取消请求') || !panel.textContent.includes('结果仍不确定')) return null;
      const buttons = Array.from(panel.querySelectorAll('button'));
      if (buttons.some(button => button.textContent.includes('从检查点继续'))) throw new Error('effect_cancel_renderer_offered_retry');
      return buttons.find(button => button.textContent.includes('确认结束任务') && !button.disabled) ?? null;
    });
    confirmation.click();
    const explicitlyClosed = await waitFor(current => current.runs.find(value => value.runId === unknown.run.runId && value.status === 'cancelled'));
    if (JSON.stringify(await request(unknownCommand, unknownCommandId)) !== JSON.stringify(unknownAccepted)) throw new Error('unknown_effect_cancel_replay_invalid');
    return { passed: true, runId: run.runId, activeVersion: active.run.version, afterFourInboxVersion: updated.version,
      requestedVersion: accepted.runVersion, pendingVersion: pending.version, terminalVersion: terminal.version,
      toolActivityId: active.tool.activityId, toolStartedAt: active.tool.startedAt, toolCompletedAt: completedTool.completedAt,
      runCancelledAt: terminal.completedAt, nonCooperativeToolJoined: true, requestedReceiptReplayed: true,
      unknownEffectRecovery: { runId: unknown.run.runId, initialVersion: unknown.run.version,
        requestedVersion: unknownAccepted.runVersion, recoveryPendingVersion: recoveryPending.version,
        cancelledVersion: explicitlyClosed.version, uncertaintyPreserved: true, retryRejected: true,
        explicitRecoveryCancellationRequired: true, productionRendererHidRetry: true,
        productionRendererSubmittedRecoveryCancellation: true, originalRequestedReceiptReplayed: true } };
  })()`, true);
  await writeFile(join(outputRoot, 'effect-cancellation.json'), JSON.stringify(evidence, null, 2), 'utf8');
}
