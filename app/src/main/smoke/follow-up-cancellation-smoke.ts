import type { BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Cancel an actual Provider stream after the first Turn's Workspace read has completed. */
export async function verifyFollowUpCancellation(
  window: BrowserWindow, workspaceId: string, modelId: string, outputRoot: string
): Promise<void> {
  const evidence = await window.webContents.executeJavaScript(`(async () => {
    const api = window.ariadne.runtime;
    const request = async (command, commandId) => {
      const result = await api.request(command, commandId ? { commandId } : undefined);
      if (!result.ok) throw new Error('follow_up_cancel_request_failed:' + command.kind + ':' + (commandId ?? 'new') + ':' + JSON.stringify(result));
      return result.value;
    };
    const snapshot = async (selection = {}) => window.__ariadneSmokeProjection.readFixtureWindow(${JSON.stringify(workspaceId)}, { toolSessionIds: [scope.sessionId], ...selection });
    const waitFor = async (predicate) => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const result = predicate(await snapshot());
        if (result) return result;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const current = await snapshot();
      throw new Error('follow_up_cancel_projection_timeout:' + JSON.stringify({
        runs: current.runs.filter(item => item.sessionId === scope.sessionId),
        streams: current.inferenceStreams.filter(item => item.sessionId === scope.sessionId)
      }));
    };
    const scope = { contractVersion: '5.0', workspaceId: ${JSON.stringify(workspaceId)}, sessionId: crypto.randomUUID() };
    const created = await request({ ...scope, kind: 'conversation.session.create', title: '【验收夹具】取消第二轮推理' });
    const messageId = crypto.randomUUID();
    await request({ ...scope, kind: 'conversation.message.accept', expectedSessionVersion: created.version,
      messageId, content: 'ariadne-smoke:cancel_follow_up', execution: { mode: 'agent', modelId: ${JSON.stringify(modelId)} } });
    const run = await waitFor(current => current.runs.find(item => item.sourceMessageId === messageId));
    const decision = await waitFor(current => current.decisions.find(item => item.runId === run.runId
      && item.kind === 'permission' && item.status === 'pending' && item.action));
    await request({ kind: 'agent.decision.resolve', contractVersion: '5.0', runId: run.runId,
      decisionId: decision.decisionId, action: { contractVersion: decision.action.contractVersion,
        actionToken: decision.action.actionToken, choice: 'allow_once' } });
    const active = await waitFor(current => {
      const candidate = current.runs.find(item => item.runId === run.runId);
      const stream = current.inferenceStreams.find(item => item.runId === run.runId && item.status === 'streaming'
        && item.chunks.some(chunk => JSON.stringify(chunk).includes('ARIADNE_SMOKE_CANCEL_FOLLOW_UP_PARTIAL')));
      return candidate?.status === 'running' && stream
        && candidate.toolActivities.some(item => item.toolName === 'workspace.read_file' && item.status === 'completed')
        ? { run: candidate, stream } : null;
    });
    const inputReceipts = [];
    for (let index = 0; index < 4; index += 1) {
      inputReceipts.push(await request({ kind: 'agent.inbox.enqueue', contractVersion: '5.0',
        runId: run.runId, sessionId: scope.sessionId, inputId: crypto.randomUUID(), delivery: 'next_turn',
        content: 'ARIADNE_SMOKE_CANCEL_PENDING_INBOX_' + index }));
    }
    const afterInbox = await waitFor(current => {
      const candidate = current.runs.find(item => item.runId === run.runId);
      return candidate?.version >= inputReceipts.at(-1).runVersion ? candidate : null;
    });
    const stale = await api.request({ kind: 'agent.run.cancel', contractVersion: '5.0', runId: run.runId,
      expectedVersion: afterInbox.version - 1, occurredAt: new Date().toISOString(), reason: 'user_requested' }, { commandId: crypto.randomUUID() });
    if (stale.ok || stale.error.code !== 'agent_run_version_conflict') throw new Error('follow_up_cancel_stale_version_not_rejected');
    await waitFor(current => current.inferenceStreams.find(item => item.inferenceStreamId === active.stream.inferenceStreamId
      && item.status === 'streaming'));
    let commandId = crypto.randomUUID();
    let command = { kind: 'agent.run.cancel', contractVersion: '5.0', runId: run.runId,
      expectedVersion: afterInbox.version, occurredAt: new Date().toISOString(), reason: 'user_requested' };
    let outcome;
    let versionConflicts = 0;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      outcome = await api.request(command, { commandId });
      if (outcome.ok) break;
      if (outcome.error.code !== 'agent_run_version_conflict') throw new Error('follow_up_cancel_failed:' + JSON.stringify(outcome));
      versionConflicts += 1;
      // Public Run commits can lag a live inference fragment. A rejected CAS has no cancellation side effect.
      const refreshed = await waitFor(current => current.runs.find(item => item.runId === run.runId
        && item.status === 'running' && item.version > command.expectedVersion));
      commandId = crypto.randomUUID();
      command = { ...command, expectedVersion: refreshed.version, occurredAt: new Date().toISOString() };
    }
    if (!outcome?.ok) throw new Error('follow_up_cancel_version_never_settled');
    const cancelled = outcome.value;
    if (cancelled.kind !== 'agent.run.cancelled') throw new Error('follow_up_cancel_result_invalid');
    const terminal = await waitFor(current => current.runs.find(item => item.runId === run.runId && item.status === 'cancelled'));
    const replay = await request(command, commandId);
    if (JSON.stringify(cancelled) !== JSON.stringify(replay)) throw new Error('follow_up_cancel_replay_invalid');
    return { passed: true, runId: run.runId, inferenceStreamId: active.stream.inferenceStreamId,
      toolCompletedBeforeCancellation: true, providerPartialObserved: true,
      activeRunVersion: active.run.version, afterInboxRunVersion: afterInbox.version, pendingInboxInputs: inputReceipts.length,
      staleVersionRejectedWithoutAbort: true, cancelledRunVersion: terminal.version, versionConflicts, receiptReplayed: true };
  })()`, true);
  await writeFile(join(outputRoot, 'follow-up-cancellation.json'), JSON.stringify(evidence, null, 2), 'utf8');
}
