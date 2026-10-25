import { expect, it } from 'vitest';
import { ProjectionRuntimeHarness } from './support/projection-runtime-harness';
import { NOW, message, session, upsertChange } from '../../app/tests/projection-v3-fixture';
import { openConversationSearchResult } from '../../app/src/renderer/src/modules/chat/conversation-search';

it('opens an off-page search result and reads only the window around its exact Message reference', async () => {
  const fixture = new ProjectionRuntimeHarness(), id = 'session-149', anchor = 'message-010';
  const reference = { sessionId: id, messageId: anchor, messageVersion: 1, contentDigest: `sha256:${'a'.repeat(64)}` };
  await fixture.append(Array.from({ length: 150 }, (_, index) => upsertChange('sessions', session(`session-${String(index).padStart(3, '0')}`), `session-${String(index).padStart(3, '0')}`)));
  await fixture.append(Array.from({ length: 100 }, (_, index) => {
    const messageId = `message-${String(index).padStart(3, '0')}`;
    return upsertChange('messages', { ...message(messageId, id), ...(messageId === anchor ? { reference } : {}) }, messageId);
  }));
  fixture.request = async (command, read) => command.kind === 'conversation.message.resolve'
    ? { kind: 'conversation.message.resolved', reference, workspaceId: 'workspace-primary', role: 'assistant', content: 'needle', createdAt: NOW } : read();
  await fixture.renderer.initialize();
  expect(fixture.renderer.getSnapshot().sessions.some(row => row.sessionId === id)).toBe(false);
  await openConversationSearchResult(fixture.renderer, { sessionId: id, workspaceId: 'workspace-primary', version: 1, title: 'Result',
    status: 'active', updatedAt: NOW, lineage: null, matches: [{ reference, role: 'assistant', snippet: 'needle' }] }, () => true);
  expect(fixture.renderer.getSnapshot()).toMatchObject({ selectedSessionId: id, lastError: null });
  expect(fixture.renderer.messages.view.getSnapshot().messageWindow?.window).toEqual({ kind: 'around', anchorMessageId: anchor, limit: 64 });
  expect(fixture.renderer.getSnapshot().messages.find(row => row.messageId === anchor)?.reference).toEqual(reference);
  expect(fixture.renderer.getSnapshot().messages.length).toBeLessThanOrEqual(64);
  expect(fixture.commands.some(command => command.kind === 'projection.view.page')).toBe(false);
});

it('does not navigate after the immutable Message reference is unavailable', async () => {
  const fixture = new ProjectionRuntimeHarness(), reference = { sessionId: 'deleted', messageId: 'missing', messageVersion: 1, contentDigest: `sha256:${'a'.repeat(64)}` };
  fixture.request = async (command, read) => { if (command.kind === 'conversation.message.resolve') throw new Error('conversation_message_reference_unavailable'); return read(); };
  await fixture.renderer.initialize();
  await expect(openConversationSearchResult(fixture.renderer, { sessionId: 'deleted', workspaceId: 'workspace-primary', version: 1,
    title: 'Deleted result', status: 'active', updatedAt: NOW, lineage: null, matches: [{ reference, role: 'assistant', snippet: 'needle' }] }, () => true))
    .rejects.toThrow('conversation_message_reference_unavailable');
  expect(fixture.renderer.getSnapshot().selectedSessionId).toBeNull();
  expect(fixture.commands.some(command => command.kind === 'projection.messages.window')).toBe(false);
});

it('rejects a resolved Message response correlated to a different immutable version', async () => {
  const fixture = new ProjectionRuntimeHarness(), reference = { sessionId: 'session-a', messageId: 'anchor', messageVersion: 1, contentDigest: `sha256:${'a'.repeat(64)}` };
  fixture.request = async (command, read) => command.kind === 'conversation.message.resolve'
    ? { kind: 'conversation.message.resolved', reference: { ...reference, messageVersion: 2 }, workspaceId: 'workspace-primary', role: 'assistant', content: 'different version', createdAt: NOW } : read();
  await fixture.renderer.initialize();
  await expect(fixture.renderer.sessions.resolveMessage(reference)).rejects.toThrow('runtime_result_invalid:conversation.message.resolved');
});
