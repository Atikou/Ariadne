import { describe, expect, it, vi } from 'vitest';
import { PERSONAL_ASSISTANT_WORKSPACE_ID, type PublicInferenceStreamProjection, type PublicMessageProjection,
  type PublicProjectionChange, type PublicRunProjection, type RuntimeCommand, type RuntimeResult } from '@ariadne/protocol/public';
import { ProjectionRuntimeHarness, deferred } from './support/projection-runtime-harness';
import { NOW, message, run, session, upsertChange } from '../../app/tests/projection-v3-fixture';

async function seed(fixture: ProjectionRuntimeHarness, changes: readonly PublicProjectionChange[]) {
  for (const change of changes) for (let version = 1; version <= change.aggregateVersion; version++) {
    if (change.operation !== 'upsert' || change.dto === null) throw new Error('upsert_fixture_required');
    await fixture.append([upsertChange(change.feature, { ...change.dto, version }, change.aggregateId)]);
  }
}
async function ready(fixture: ProjectionRuntimeHarness, changes: readonly PublicProjectionChange[] = [], selected = 'session-a') {
  fixture.status = { ...fixture.status, capabilities: ['companion.chat', 'companion.agent-plan', 'agent.inbox', 'agent.subagents'] };
  await seed(fixture, changes); await fixture.renderer.initialize();
  if (selected !== '') await fixture.renderer.sessions.select(selected);
  return fixture.renderer;
}
function accepted(command: Extract<RuntimeCommand, { kind: 'conversation.message.accept' }>): RuntimeResult {
  return { kind: 'conversation.message.accepted', sessionId: command.sessionId, sessionVersion: command.expectedSessionVersion + 1,
    messageId: command.messageId, messageVersion: 1, sagaId: 'test-saga' };
}
function user(id: string, content: string, time = NOW): PublicMessageProjection {
  return { ...message(id, 'session-a'), role: 'user', content, createdAt: time, updatedAt: time };
}
function stream(runId: string): PublicInferenceStreamProjection {
  return { inferenceStreamId: `stream-${runId}`, sessionId: 'session-a', runId, turnId: 'turn', attemptId: 'attempt', version: 1,
    status: 'streaming', retainedFromSequence: 1, finalSequence: 2, chunks: [
      { sequence: 1, channel: 'reasoning', text: '正在核对', observedAt: NOW },
      { sequence: 2, channel: 'token', text: '部分公开回答', observedAt: NOW }], updatedAt: NOW };
}
const sessionChange = () => upsertChange('sessions', session('session-a'), 'session-a');

describe('RuntimeStore bounded chat boundary', () => {
  it('sends image-only input through the attachment command without placing bytes in the read model', async () => {
    const fixture = new ProjectionRuntimeHarness();
    fixture.request = async (command, read) => {
      if (command.kind === 'conversation.message.accept') {
        expect(command).toMatchObject({ content: '', execution: { mode: 'agent', modelId: 'vision-model' },
          attachments: [{ mediaType: 'image/png', data: 'aGVsbG8=', name: 'screen.png' }] });
        return accepted(command);
      }
      return read();
    };
    const store = await ready(fixture, [sessionChange()]);
    await store.messages.send('', { modelId: 'vision-model', attachments: [{ mediaType: 'image/png', data: 'aGVsbG8=', name: 'screen.png' }] });
    expect(fixture.commands.filter(command => command.kind === 'conversation.message.accept')).toHaveLength(1);
    expect(JSON.stringify(store.getSnapshot().messages)).not.toContain('aGVsbG8=');
  });

  it('presents only durable image metadata in the current Message window', async () => {
    const fixture = new ProjectionRuntimeHarness();
    const attachment = { attachmentId: `sha256:${'c'.repeat(64)}`, mediaType: 'image/webp' as const, bytes: 1024, width: 800, height: 600, name: 'diagram.webp' };
    const store = await ready(fixture, [sessionChange(), upsertChange('messages', { ...user('image-message', ''), attachments: [attachment] }, 'image-message')]);
    expect(store.getSnapshot().messages[0]?.attachments).toEqual([attachment]);
    expect(JSON.stringify(store.getSnapshot().messages)).not.toMatch(/data:image|localPath/u);
  });

  it('shows retained stream text until the authoritative assistant message supersedes it', async () => {
    const fixture = new ProjectionRuntimeHarness(), projected = run('run-stream', 'running'), partial = stream(projected.runId);
    const store = await ready(fixture, [sessionChange(), upsertChange('runs', projected, projected.runId), upsertChange('inference_streams', partial, partial.inferenceStreamId)]);
    expect(store.getSnapshot().messages).toMatchObject([{ messageId: partial.inferenceStreamId, content: '部分公开回答', status: 'streaming', reasoning: { content: '正在核对' } }]);
    await fixture.append([upsertChange('messages', { ...message('terminal', 'session-a'), runId: projected.runId, content: '最终权威回答' }, 'terminal')]);
    await store.refresh();
    const terminal = store.getSnapshot().messages.find(item => item.messageId === 'terminal')!;
    expect(terminal).toMatchObject({ bodyState: 'unloaded' }); expect(terminal).not.toHaveProperty('content');
    await store.messages.loadBody(terminal.messageId, terminal.sessionId, terminal.bodyReadToken!);
    expect(store.getSnapshot().messages).toMatchObject([{ messageId: 'terminal', content: '最终权威回答', status: 'completed' }]);
    expect(store.getSnapshot().messages).toHaveLength(1);
  });

  it('orders a processing stream after its same-timestamp starting user Message', async () => {
    const fixture = new ProjectionRuntimeHarness(), projected = run('run-stream-order', 'running'), partial = stream(projected.runId);
    const store = await ready(fixture, [sessionChange(), upsertChange('runs', projected, projected.runId),
      upsertChange('messages', { ...user('starting-user', 'Start this run.'), runId: projected.runId }, 'starting-user'),
      upsertChange('inference_streams', partial, partial.inferenceStreamId)]);
    expect(store.getSnapshot().messages.map(item => ({ role: item.role, status: item.status }))).toEqual([
      { role: 'user', status: 'completed' }, { role: 'assistant', status: 'streaming' }]);
  });

  it('creates personal-assistant chat without requiring a workspace', async () => {
    const fixture = new ProjectionRuntimeHarness();
    fixture.request = async (command, read) => {
      if (command.kind === 'conversation.session.create') {
        expect(command).toMatchObject({ workspaceId: PERSONAL_ASSISTANT_WORKSPACE_ID, title: '读取这台电脑上的说明文件' });
        return { kind: 'conversation.session.created', sessionId: command.sessionId, version: 1 };
      }
      if (command.kind === 'conversation.message.accept') { expect(command.execution).toEqual({ mode: 'chat' }); return accepted(command); }
      return read();
    };
    const store = await ready(fixture, [], '');
    await expect(store.messages.send('读取这台电脑上的说明文件')).resolves.toMatchObject({ sessionId: expect.any(String) });
  });

  it('routes rename, archive and restore through successive durable Session versions', async () => {
    const fixture = new ProjectionRuntimeHarness(); let current = session('session-a');
    fixture.request = async (command, read) => {
      if (command.kind === 'conversation.session.rename' || command.kind === 'conversation.session.archive' || command.kind === 'conversation.session.restore') {
        expect(command.expectedSessionVersion).toBe(current.version);
        current = { ...current, version: current.version + 1,
          title: command.kind === 'conversation.session.rename' ? command.title : current.title,
          status: command.kind === 'conversation.session.archive' ? 'archived' : 'active' };
        await fixture.append([upsertChange('sessions', current, current.sessionId)]);
        return { kind: 'conversation.session.updated', sessionId: current.sessionId, version: current.version };
      }
      return read();
    };
    const store = await ready(fixture, [sessionChange()]), visible = store.getSnapshot().sessions[0]!;
    await store.sessions.rename(visible, ' Durable title '); await store.sessions.archive(visible); await store.sessions.restore(visible);
    expect(fixture.commands.filter(command => ['conversation.session.rename', 'conversation.session.archive', 'conversation.session.restore'].includes(command.kind)))
      .toMatchObject([{ kind: 'conversation.session.rename', expectedSessionVersion: 1, title: 'Durable title' },
        { kind: 'conversation.session.archive', expectedSessionVersion: 2 }, { kind: 'conversation.session.restore', expectedSessionVersion: 3 }]);
  });

  it('retains the sending overlay until durable user, Run and assistant data arrive', async () => {
    const fixture = new ProjectionRuntimeHarness(), gate = deferred<RuntimeResult>(), received = deferred(); let clientId = '';
    fixture.request = async (command, read) => {
      if (command.kind === 'conversation.message.accept') { clientId = command.messageId; received.resolve(); return gate.promise; }
      return read();
    };
    const store = await ready(fixture, [sessionChange()]); const sending = store.messages.send('Hello projection'); await received.promise;
    expect(store.getSnapshot().messages).toMatchObject([{ role: 'user', content: 'Hello projection', deliveryState: 'pending' }, { role: 'assistant', status: 'streaming' }]);
    gate.resolve({ kind: 'conversation.message.accepted', sessionId: 'session-a', sessionVersion: 2, messageId: clientId, messageVersion: 1, sagaId: 'test-saga' });
    await sending;
    await fixture.append([upsertChange('messages', user(clientId, 'Hello projection'), clientId),
      upsertChange('messages', { ...message('assistant-chat', 'session-a'), runId: 'run-chat', content: 'Projected answer', createdAt: '2026-07-31T00:00:01.000Z', updatedAt: '2026-07-31T00:00:01.000Z' }, 'assistant-chat'),
      upsertChange('runs', { ...run('run-chat', 'completed'), sourceMessageId: clientId }, 'run-chat')]);
    await store.refresh();
    expect(store.getSnapshot().messages.map(item => item.messageId)).toEqual([clientId, 'assistant-chat']);
    expect(store.getSnapshot().pendingOverlayIds).toEqual([]);
    expect(fixture.commands.map(command => command.kind)).not.toContain('companion.chat.start');
  });

  it('keeps processing after a durable starting user with a later projection timestamp', async () => {
    const fixture = new ProjectionRuntimeHarness(); let clientId = '';
    fixture.request = async (command, read) => {
      if (command.kind === 'conversation.message.accept') { clientId = command.messageId; return accepted(command); } return read();
    };
    const store = await ready(fixture, [sessionChange()]); await store.messages.send('Delayed projection');
    await fixture.append([upsertChange('messages', user(clientId, 'Delayed projection', '2099-09-02T03:18:50.206Z'), clientId)]);
    await store.refresh();
    const durable = store.getSnapshot().messages.find(item => item.messageId === clientId)!;
    await store.messages.loadBody(durable.messageId, durable.sessionId, durable.bodyReadToken!);
    expect(store.getSnapshot().messages.map(item => ({ role: item.role, content: item.content, status: item.status }))).toEqual([
      { role: 'user', content: 'Delayed projection', status: 'completed' }, { role: 'assistant', content: '', status: 'streaming' }]);
  });

  it('creates a Session before its first Message, generates one title and preserves plan options', async () => {
    const fixture = new ProjectionRuntimeHarness();
    fixture.request = async (command, read) => {
      if (command.kind === 'conversation.session.create') { expect(command.title).toBe('First message'); return { kind: 'conversation.session.created', sessionId: command.sessionId, version: 1 }; }
      if (command.kind === 'conversation.message.accept') {
        expect(command).toMatchObject({ expectedSessionVersion: 1, execution: { mode: 'plan', modelId: 'model-selected', inference: { reasoningMode: 'on', reasoningEffort: 'high' }, localFallbackModelId: null } });
        return accepted(command);
      }
      if (command.kind === 'conversation.session.title.generate') return { kind: 'conversation.session.title.generated', sessionId: command.sessionId, sessionVersion: command.expectedSessionVersion, title: '模型生成的标题' };
      if (command.kind === 'conversation.session.rename') return { kind: 'conversation.session.updated', sessionId: command.sessionId, version: command.expectedSessionVersion + 1 };
      return read();
    };
    const store = await ready(fixture, [], ''); store.sessions.setPlanModeEnabled(true, null);
    const result = await store.messages.send('First message', { workspaceId: 'workspace-primary', modelId: 'model-selected', inference: { reasoningMode: 'on', reasoningEffort: 'high' }, localFallbackModelId: null });
    expect(store.getSnapshot()).toMatchObject({ selectedSessionId: result.sessionId, sessions: [] });
    await vi.waitFor(() => expect(fixture.commands.filter(command => command.kind === 'conversation.session.rename')).toHaveLength(1));
    const writes = fixture.commands.filter(command => command.kind.startsWith('conversation.')).map(command => command.kind);
    expect(writes).toEqual(['conversation.session.create', 'conversation.message.accept', 'conversation.session.title.generate', 'conversation.session.rename']);
  });

  it('clears processing when a terminal assistant Message arrives before any Run', async () => {
    const fixture = new ProjectionRuntimeHarness(); let clientId = '';
    fixture.request = async (command, read) => { if (command.kind === 'conversation.message.accept') { clientId = command.messageId; return accepted(command); } return read(); };
    const store = await ready(fixture, [sessionChange()]); await store.messages.send('Plan this');
    await fixture.append([upsertChange('messages', user(clientId, 'Plan this'), clientId),
      upsertChange('messages', { ...message('assistant-start-failed', 'session-a'), content: '任务无法启动：当前运行权限或工具配置不可用。', createdAt: '2026-07-31T00:00:01.000Z', updatedAt: '2026-07-31T00:00:01.000Z' }, 'assistant-start-failed')]);
    await store.refresh();
    expect(store.getSnapshot().pendingOverlayIds).toEqual([]);
    const failedStart = store.getSnapshot().messages.find(item => item.messageId === 'assistant-start-failed')!;
    await store.messages.loadBody(failedStart.messageId, failedStart.sessionId, failedStart.bodyReadToken!);
    expect(store.getSnapshot().messages).toMatchObject([{ messageId: clientId, role: 'user' }, { messageId: 'assistant-start-failed', role: 'assistant', content: expect.stringContaining('无法启动') }]);
  });

  it('clears pending overlays when Runtime resets', async () => {
    const fixture = new ProjectionRuntimeHarness();
    fixture.request = async (command, read) => command.kind === 'conversation.message.accept' ? accepted(command) : read();
    const store = await ready(fixture, [sessionChange()]); await store.messages.send('Pending overlay');
    expect(store.getSnapshot().messages).toHaveLength(2);
    fixture.emitStatus({ ...fixture.status, availability: 'restarting', observedAt: '2026-07-31T00:00:01.000Z' });
    expect(store.getSnapshot()).toMatchObject({ messages: [], pendingOverlayIds: [] });
  });

  it('reads durable Run interactions between the objective and terminal Message in one bounded history', async () => {
    const fixture = new ProjectionRuntimeHarness();
    const projected: PublicRunProjection = { ...run('run-interactions', 'completed', 8), interactionMessages: [
      { ...message('intermediate-assistant', 'session-a'), runId: 'run-interactions', content: 'Intermediate response.', createdAt: '2026-07-31T00:00:01.000Z', updatedAt: '2026-07-31T00:00:01.000Z' },
      { ...user('inbox-user', 'Continue with this.', '2026-07-31T00:00:02.000Z'), runId: 'run-interactions' }] };
    const store = await ready(fixture, [sessionChange(), upsertChange('runs', projected, projected.runId),
      upsertChange('messages', { ...user('objective', 'Initial objective.'), runId: projected.runId }, 'objective'),
      upsertChange('messages', { ...message('terminal', 'session-a'), runId: projected.runId, content: 'Final response.', createdAt: '2026-07-31T00:00:04.000Z', updatedAt: '2026-07-31T00:00:04.000Z' }, 'terminal')]);
    expect(store.getSnapshot().messages.map(item => item.messageId)).toEqual(['objective', 'intermediate-assistant', 'inbox-user', 'terminal']);
  });

  it('routes enqueue, replace and remove through the unified Agent inbox protocol', async () => {
    const fixture = new ProjectionRuntimeHarness();
    fixture.request = async (command, read) => {
      if (command.kind === 'agent.inbox.enqueue') return { kind: 'agent.inbox.enqueued', runId: command.runId, runVersion: 5, inputId: command.inputId, inputVersion: 1 };
      if (command.kind === 'agent.inbox.replace') return { kind: 'agent.inbox.replaced', runId: command.runId, runVersion: 6, inputId: command.inputId, inputVersion: 2 };
      if (command.kind === 'agent.inbox.remove') return { kind: 'agent.inbox.removed', runId: command.runId, runVersion: 7, inputId: command.inputId };
      return read();
    };
    const store = await ready(fixture, [sessionChange(), upsertChange('runs', run('run-inbox-ui', 'running', 4), 'run-inbox-ui')]), projected = store.getSnapshot().runs[0]!;
    const receipt = await store.runs.enqueueInput(projected, 'Steer before the next step.', 'next_step'); expect(receipt.state).toBe('accepted');
    await store.runs.replaceInput(projected, receipt.inputId, 1, 'Revised steering.'); await store.runs.removeInput(projected, receipt.inputId, 2);
    expect(fixture.commands.filter(command => command.kind.startsWith('agent.inbox.'))).toMatchObject([
      { kind: 'agent.inbox.enqueue', runId: projected.runId, sessionId: 'session-a', inputId: receipt.inputId, delivery: 'next_step', content: 'Steer before the next step.' },
      { kind: 'agent.inbox.replace', inputId: receipt.inputId, expectedInputVersion: 1, content: 'Revised steering.' },
      { kind: 'agent.inbox.remove', inputId: receipt.inputId, expectedInputVersion: 2 }]);
  });

  it('reconciles an uncertain inbox delivery using the exact same command and command ID', async () => {
    const fixture = new ProjectionRuntimeHarness(); const sent: { command: RuntimeCommand; commandId?: string }[] = []; let uncertain = true;
    fixture.requestFailure = (command, options) => {
      if (command.kind !== 'agent.inbox.enqueue') return null;
      sent.push({ command, commandId: options?.commandId });
      if (!uncertain) return null; uncertain = false;
      return { ok: false, error: { code: 'command_outcome_uncertain', message: 'Runtime disconnected before confirming the command outcome.', retryable: false, correlationId: options!.commandId! } };
    };
    fixture.request = async (command, read) => command.kind === 'agent.inbox.enqueue'
      ? { kind: 'agent.inbox.enqueued', runId: command.runId, runVersion: 5, inputId: command.inputId, inputVersion: 1 } : read();
    const store = await ready(fixture, [sessionChange(), upsertChange('runs', run('run-inbox-reconcile', 'running', 4), 'run-inbox-reconcile')]);
    const first = await store.runs.enqueueInput(store.getSnapshot().runs[0]!, 'Keep the same logical command.', 'next_turn');
    expect(first).toMatchObject({ state: 'reconcile', attempt: 1 }); expect(store.getSnapshot().agentInputDeliveries).toEqual([first]);
    const reconciled = await store.runs.reconcileInputDelivery(first.commandId);
    expect(reconciled).toMatchObject({ commandId: first.commandId, inputId: first.inputId, state: 'accepted', attempt: 2 });
    expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0]); expect(sent[0]?.commandId).toBe(first.commandId);
  });

  it('waits for exact Inbox proof even when a verified Inbox page already shows the same input', async () => {
    const fixture = new ProjectionRuntimeHarness(), projected = run('run-proof-settlement', 'running', 1);
    fixture.requestFailure = (command, options) => command.kind !== 'agent.inbox.enqueue' ? null
      : { ok: false, error: { code: 'command_outcome_uncertain', message: 'Outcome unknown.', retryable: false, correlationId: options!.commandId! } };
    const store = await ready(fixture, [sessionChange(), upsertChange('runs', projected, projected.runId)]);
    const receipt = await store.runs.enqueueInput(store.getSnapshot().runs[0]!, 'Exact proof required.', 'next_turn');
    expect(receipt.state).toBe('reconcile');
    await fixture.append([upsertChange('runs', { ...projected, version: 2, inbox: [{ inputId: receipt.inputId,
      messageId: 'input-message-proof', version: 1, delivery: 'next_turn', content: receipt.content, state: 'queued', queuedAt: NOW, updatedAt: NOW }] }, projected.runId)]);
    const proofReady = deferred<void>(), proofReleased = deferred<void>();
    fixture.request = async (command, read) => {
      const result = await read();
      if (command.kind === 'projection.run_document.inbox') { proofReady.resolve(); await proofReleased.promise; }
      return result;
    };
    const refreshing = store.refresh(); await proofReady.promise;
    expect(store.getSnapshot().runs[0]!.inbox[0]!.inputId).toBe(receipt.inputId);
    expect(store.getSnapshot().runs[0]!.inbox[0]!.bodyState).toBe('unloaded');
    expect(store.getSnapshot().agentInputDeliveries[0]!.state).toBe('reconcile');
    proofReleased.resolve(); await refreshing;
    expect(store.getSnapshot().agentInputDeliveries[0]!.state).toBe('accepted');
    expect(fixture.commands.filter(command => command.kind === 'agent.inbox.enqueue')).toHaveLength(1);
    expect(fixture.commands.filter(command => command.kind === 'projection.run_document.inbox')).toMatchObject([{ request: { inputId: receipt.inputId } }]);
    expect(fixture.commands.some(command => command.kind === 'projection.run_document.chunk'
      || (command.kind === 'projection.catalog.detail' && command.request.manifest.feature === 'runs'))).toBe(false);
  });

  it('restores an unsettled encrypted sender record and reconciles its exact identity after reload', async () => {
    const command = { kind: 'agent.inbox.enqueue' as const, contractVersion: '5.0' as const, runId: 'run-restored', sessionId: 'session-a',
      inputId: 'input-restored', delivery: 'next_turn' as const, content: 'Resume this exact delivery after Renderer reload.' };
    const settle = vi.fn(async () => undefined), sent: { command: RuntimeCommand; commandId?: string }[] = [];
    const fixture = new ProjectionRuntimeHarness({ list: async () => [{ commandId: 'command-restored', command, createdAt: '2026-07-30T23:59:00.000Z' }],
      stage: async () => { throw new Error('stage_not_expected'); }, stageBatch: async () => { throw new Error('stage_batch_not_expected'); }, settle });
    fixture.request = async (request, read, options) => {
      if (request.kind !== 'agent.inbox.enqueue') return read(); sent.push({ command: request, commandId: options?.commandId });
      return { kind: 'agent.inbox.enqueued', runId: request.runId, runVersion: 5, inputId: request.inputId, inputVersion: 1 };
    };
    const store = await ready(fixture, [sessionChange(), upsertChange('runs', run('run-restored', 'running', 4), 'run-restored')]);
    const restored = store.getSnapshot().agentInputDeliveries[0]!; expect(restored).toMatchObject({ commandId: 'command-restored', inputId: 'input-restored', state: 'reconcile', attempt: 1 });
    await expect(store.runs.reconcileInputDelivery(restored.commandId)).resolves.toMatchObject({ state: 'accepted', attempt: 2 });
    expect(sent).toEqual([{ command, commandId: 'command-restored' }]); await vi.waitFor(() => expect(settle).toHaveBeenCalledWith({ commandId: 'command-restored' }));
  });

  it.each(['send', 'interrupt'] as const)('routes a continuable Child %s through direct-parent authority with summary identity', async action => {
    const fixture = new ProjectionRuntimeHarness(), parent = run('run-parent', 'waiting_children', 3);
    const child: PublicRunProjection = { ...run('run-child', action === 'send' ? 'paused' : 'running', 6), parentRunId: parent.runId,
      delegationId: 'delegation-child', subagentMode: 'continuable', subagentProviderId: 'ariadne.in_process', title: 'SubAgent task' };
    fixture.request = async (command, read) => {
      if (command.kind === 'agent.subagent.send') return { kind: 'agent.subagent.input.sent', parentRunId: command.parentRunId, childRunId: command.childRunId, childRunVersion: 7, inputId: command.inputId, inputVersion: 1 };
      if (command.kind === 'agent.subagent.interrupt') return { kind: 'agent.subagent.interrupted', parentRunId: command.parentRunId, childRunId: command.childRunId, childRunVersion: 8, previousStatus: 'active' };
      return read();
    };
    const store = await ready(fixture, [sessionChange(), upsertChange('runs', parent, parent.runId), upsertChange('runs', child, child.runId)]);
    const presentedParent = store.getSnapshot().runs.find(candidate => candidate.runId === parent.runId)!;
    const presentedChild = store.getSnapshot().runSummaries.find(candidate => candidate.runId === child.runId)!;
    expect(presentedParent).toBeDefined(); expect(presentedChild).toBeDefined();
    if (action === 'send') {
      const inputId = await store.runs.sendSubagentInput(presentedParent, presentedChild, 'Continue with the second bounded check.');
      expect(fixture.commands.find(command => command.kind === 'agent.subagent.send')).toMatchObject({ parentRunId: parent.runId, childRunId: child.runId, sessionId: 'session-a', inputId, content: 'Continue with the second bounded check.' });
    } else {
      await store.runs.interruptSubagent(presentedParent, presentedChild);
      expect(fixture.commands.find(command => command.kind === 'agent.subagent.interrupt')).toMatchObject({ parentRunId: parent.runId, childRunId: child.runId, sessionId: 'session-a', expectedChildVersion: 6, reason: 'user_requested' });
    }
  });

  it.each(['agent.run.cancelled', 'agent.run.cancellation.requested'] as const)('cancels an explicitly read Run version and accepts %s', async kind => {
    const fixture = new ProjectionRuntimeHarness();
    fixture.request = async (command, read) => {
      if (command.kind === 'agent.run.cancel') { expect(command).toMatchObject({ runId: 'run-cancel', expectedVersion: 7, reason: 'user_requested' }); return { kind, runId: command.runId, runVersion: 8 }; } return read();
    };
    const store = await ready(fixture, [sessionChange(), upsertChange('runs', run('run-cancel', 'running', 7), 'run-cancel')]);
    await store.runs.requestCancellation(store.getSnapshot().runs[0]!);
    expect(fixture.commands.filter(command => command.kind === 'agent.run.cancel')).toHaveLength(1);
  });
});
