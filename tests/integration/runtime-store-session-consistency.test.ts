import { expect, it } from 'vitest';
import { ProjectionRuntimeHarness } from './support/projection-runtime-harness';
import { NOW, message, session, upsertChange } from '../../app/tests/projection-v3-fixture';

it('selects only the current Session Message window without issuing an independent domain list query', async () => {
  const fixture = new ProjectionRuntimeHarness();
  await fixture.append(['session-a', 'session-b'].flatMap(id => [upsertChange('sessions', session(id), id),
    upsertChange('messages', message(`message-${id}`, id), `message-${id}`)]));
  await fixture.renderer.initialize(); await fixture.renderer.sessions.select('session-b');
  expect(fixture.renderer.getSnapshot()).toMatchObject({ selectedSessionId: 'session-b', messages: [{ messageId: 'message-session-b', sessionId: 'session-b' }], lastError: null });
  expect(fixture.commands.map(command => command.kind)).not.toContain('companion.messages.list');
});

it('creates a Session with the first message and keeps it out of the directory until durable Projection arrives', async () => {
  const fixture = new ProjectionRuntimeHarness(); fixture.status = { ...fixture.status, capabilities: ['companion.chat'] };
  let createdSessionId = '';
  fixture.request = async (command, read) => {
    if (command.kind === 'conversation.session.create') { createdSessionId = command.sessionId;
      return { kind: 'conversation.session.created', sessionId: command.sessionId, version: 1 }; }
    if (command.kind === 'conversation.message.accept') return { kind: 'conversation.message.accepted', sessionId: command.sessionId,
      sessionVersion: 2, messageId: command.messageId, messageVersion: 1, sagaId: 'first-message-saga' };
    return read();
  };
  await fixture.renderer.initialize();
  const accepted = await fixture.renderer.messages.send('Created', { workspaceId: 'workspace-primary' });
  expect(accepted.sessionId).toBe(createdSessionId);
  expect(fixture.renderer.getSnapshot()).toMatchObject({ selectedSessionId: createdSessionId, sessions: [], lastError: null });
  expect(fixture.commands.some(command => command.kind === 'projection.catalog.begin')).toBe(true);
});

it('prepares an existing-session send with a fresh explicit Session version when the directory view is older', async () => {
  const fixture = new ProjectionRuntimeHarness();
  await fixture.append([upsertChange('sessions', session('session-a'), 'session-a')]);
  await fixture.renderer.initialize(); await fixture.renderer.sessions.select('session-a');
  const visible = fixture.renderer.getSnapshot().sessions[0]!;
  await fixture.append([upsertChange('sessions', { ...session('session-a', 2), title: 'Asynchronous title' }, 'session-a')]);
  expect(fixture.renderer.getSnapshot().sessions[0]).toBe(visible);
  fixture.request = async (command, read) => {
    if (command.kind === 'conversation.message.accept') {
      expect(command.expectedSessionVersion).toBe(2);
      return { kind: 'conversation.message.accepted', sessionId: command.sessionId, sessionVersion: 3,
        messageId: command.messageId, messageVersion: 1, sagaId: 'fresh-session-send' };
    }
    return read();
  };
  await fixture.renderer.messages.send('Follow-up');
  expect(fixture.commands.filter(command => command.kind === 'conversation.message.accept')).toHaveLength(1);
});

it.each(['rename', 'archive', 'restore'] as const)('prepares %s from a fresh explicit Session read and submits exactly once', async action => {
  const fixture = new ProjectionRuntimeHarness();
  const original = { ...session('session-a'), status: action === 'restore' ? 'archived' as const : 'active' as const };
  await fixture.append([upsertChange('sessions', original, original.sessionId)]);
  await fixture.renderer.initialize();
  await fixture.append([upsertChange('sessions', { ...original, version: 2, title: 'Asynchronous title' }, original.sessionId)]);
  fixture.request = async (command, read) => {
    if (command.kind === `conversation.session.${action}`) {
      expect(command).toMatchObject({ sessionId: original.sessionId, workspaceId: original.workspaceId, expectedSessionVersion: 2 });
      return { kind: 'conversation.session.updated', sessionId: original.sessionId, version: 3 };
    }
    return read();
  };
  if (action === 'rename') await fixture.renderer.sessions.rename(original, 'User title');
  else await fixture.renderer.sessions[action](original);
  expect(fixture.commands.filter(command => command.kind === `conversation.session.${action}`)).toHaveLength(1);
});

it('rejects a Session mutation if the explicit fresh detail no longer belongs to the requested workspace', async () => {
  const fixture = new ProjectionRuntimeHarness();
  const original = session('session-a');
  await fixture.append([upsertChange('sessions', original, original.sessionId)]);
  await fixture.renderer.initialize();
  await fixture.append([upsertChange('sessions', { ...original, version: 2, workspaceId: 'workspace-other' }, original.sessionId)]);
  await expect(fixture.renderer.sessions.rename(original, 'User title')).rejects.toThrow('conversation_session_projection_missing');
  expect(fixture.commands.some(command => command.kind === 'conversation.session.rename')).toBe(false);
});

it('queries Sessions and forks from the immutable Message reference obtained through the current window', async () => {
  const fixture = new ProjectionRuntimeHarness();
  const reference = { sessionId: 'session-source', messageId: 'message-source', messageVersion: 1, contentDigest: `sha256:${'a'.repeat(64)}` };
  await fixture.append([upsertChange('sessions', session('session-source'), 'session-source'),
    upsertChange('messages', { ...message('message-source', 'session-source'), reference }, 'message-source')]);
  fixture.request = async (command, read) => {
    if (command.kind === 'conversation.sessions.query') return { kind: 'conversation.sessions.query_result', items: [{
      sessionId: 'session-source', workspaceId: command.workspaceId, version: 1, title: 'Conversation', status: 'active',
      updatedAt: NOW, lineage: null, matches: [{ reference, role: 'user', snippet: 'needle' }]
    }] };
    if (command.kind === 'conversation.message.resolve') return { kind: 'conversation.message.resolved', reference: command.reference,
      workspaceId: 'workspace-primary', role: 'user', content: 'needle', createdAt: NOW };
    if (command.kind === 'conversation.session.fork') {
      expect(command).toMatchObject({ sourceSessionId: 'session-source', expectedSourceSessionVersion: 1, boundary: reference });
      return { kind: 'conversation.session.forked', sessionId: command.sessionId, version: 1, sourceSessionId: command.sourceSessionId, boundary: command.boundary };
    }
    return read();
  };
  await fixture.renderer.initialize(); await fixture.renderer.sessions.select('session-source');
  expect(fixture.renderer.getSnapshot().messages[0]?.reference).toEqual(reference);
  await expect(fixture.renderer.sessions.query('workspace-primary', 'needle', 'all')).resolves.toMatchObject([{ sessionId: 'session-source', matches: [{ reference }] }]);
  await expect(fixture.renderer.sessions.resolveMessage(reference)).resolves.toMatchObject({ content: 'needle', reference });
  const forkedId = await fixture.renderer.sessions.forkFromMessage('session-source', reference);
  expect(fixture.renderer.getSnapshot().selectedSessionId).toBe(forkedId);
  expect(fixture.commands.some(command => command.kind === 'conversation.session.fork')).toBe(true);
});
