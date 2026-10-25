import type { BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Exercise the actual native delegation -> child Provider -> parent cancellation path. */
export async function verifyRequiredChildCancellation(
  window: BrowserWindow, workspaceId: string, modelId: string, outputRoot: string
): Promise<void> {
  const evidence = await window.webContents.executeJavaScript(`(async () => {
    const api = window.ariadne.runtime;
    const request = async (command, commandId) => {
      const response = await api.request(command, commandId ? { commandId } : undefined);
      if (!response.ok) throw new Error('required_child_cancel_request_failed:' + command.kind + ':' + JSON.stringify(response));
      return response.value;
    };
    const snapshot = async (selection = {}) => window.__ariadneSmokeProjection.readFixtureWindow(${JSON.stringify(workspaceId)}, selection);
    const waitFor = async predicate => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const result = predicate(await snapshot());
        if (result) return result;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const current = await snapshot();
      throw new Error('required_child_cancel_timeout:' + JSON.stringify({
        runs: current.runs.filter(item => item.sessionId === scope.sessionId),
        streams: current.inferenceStreams.filter(item => item.sessionId === scope.sessionId)
      }));
    };
    const scope = { contractVersion: '5.0', workspaceId: ${JSON.stringify(workspaceId)}, sessionId: crypto.randomUUID() };
    const created = await request({ ...scope, kind: 'conversation.session.create', title: '【验收夹具】父任务取消必需子任务' });
    const messageId = crypto.randomUUID();
    await request({ ...scope, kind: 'conversation.message.accept', expectedSessionVersion: created.version,
      messageId, content: 'ariadne-smoke:cancel_required_parent', execution: { mode: 'agent', modelId: ${JSON.stringify(modelId)} } });
    const active = await waitFor(current => {
      const parent = current.runs.find(item => item.sourceMessageId === messageId && item.status === 'waiting_children');
      const child = parent && current.runs.find(item => item.parentRunId === parent.runId && item.status === 'running');
      const stream = child && current.inferenceStreams.find(item => item.runId === child.runId && item.status === 'streaming'
        && item.chunks.some(chunk => JSON.stringify(chunk).includes('ARIADNE_SMOKE_REQUIRED_CHILD_PARTIAL')));
      return parent && child && stream ? { parent, child, stream } : null;
    });
    const commandId = crypto.randomUUID();
    const command = { kind: 'agent.run.cancel', contractVersion: '5.0', runId: active.parent.runId,
      expectedVersion: active.parent.version, occurredAt: new Date().toISOString(), reason: 'user_requested' };
    const accepted = await request(command, commandId);
    if (accepted.kind !== 'agent.run.cancellation.requested') throw new Error('required_child_cancel_accepted_result_invalid');
    const terminal = await waitFor(current => {
      const parent = current.runs.find(item => item.runId === active.parent.runId);
      const child = current.runs.find(item => item.runId === active.child.runId);
      return parent?.status === 'cancelled' && child?.status === 'cancelled' ? { parent, child } : null;
    });
    const replay = await request(command, commandId);
    if (JSON.stringify(accepted) !== JSON.stringify(replay)) throw new Error('required_child_cancel_replay_invalid');
    return { passed: true, parentRunId: active.parent.runId, childRunId: active.child.runId,
      parentRequestedVersion: accepted.runVersion, parentCancelledVersion: terminal.parent.version,
      childActiveVersion: active.child.version, childCancelledVersion: terminal.child.version,
      inferenceStreamId: active.stream.inferenceStreamId, childProviderPartialObserved: true,
      requestedReceiptReplayedAfterTerminal: true };
  })()`, true);
  await writeFile(join(outputRoot, 'required-child-cancellation.json'), JSON.stringify(evidence, null, 2), 'utf8');
}
