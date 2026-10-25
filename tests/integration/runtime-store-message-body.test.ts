import { expect, it } from 'vitest';
import { ProjectionRuntimeHarness, deferred } from './support/projection-runtime-harness';
import { message, run, session, upsertChange } from '../../app/tests/projection-v3-fixture';
import type { PublicProjectionPersistenceClock } from '../../runtime/src/adapters/persistence/SqlitePublicProjectionStore';

async function fixture(count = 200, clock?: PublicProjectionPersistenceClock) {
  const f = new ProjectionRuntimeHarness(undefined, clock);
  await f.append([upsertChange('sessions', session('session-a'), 'session-a')]);
  await f.append(Array.from({ length: count }, (_, index) => {
    const id = `message-${String(index).padStart(3, '0')}`;
    return upsertChange('messages', { ...message(id, 'session-a'), content: `PRIVATE_BODY_${id}` }, id);
  }));
  await f.renderer.initialize(); await f.renderer.sessions.select('session-a'); return f;
}
it('publishes a true unread range without body calls, then limits and coalesces visible body requests', async () => {
  const f = await fixture(), before = f.renderer.getSnapshot();
  expect(before.messages).toHaveLength(64); expect(before.projectionWindows.messages).toMatchObject({ hasEarlier: true, hasLater: false });
  expect(before.messages.every(row => row.bodyState === 'unloaded' && !('content' in row))).toBe(true);
  expect(f.commands.some(command => ['projection.messages.body', 'projection.run_document.chunk', 'projection.messages.window', 'projection.scope.read'].includes(command.kind))).toBe(false);
  let active = 0, peak = 0; const started = deferred(), release = deferred();
  f.request = async (command, read) => {
    if (command.kind !== 'projection.messages.body') return read();
    active++; peak = Math.max(peak, active); if (active === 2) started.resolve();
    try { await release.promise; return await read(); } finally { active--; }
  };
  const rows = before.messages.slice(0, 32), operations = rows.map(row => f.renderer.messages.loadBody(row.messageId, row.sessionId, row.bodyReadToken!));
  expect(f.renderer.messages.loadBody(rows[0]!.messageId, rows[0]!.sessionId, rows[0]!.bodyReadToken!)).toBe(operations[0]);
  await started.promise; expect(f.commands.filter(command => command.kind === 'projection.messages.body')).toHaveLength(2);
  const extra = before.messages[32]!;
  await expect(f.renderer.messages.loadBody(extra.messageId, extra.sessionId, extra.bodyReadToken!)).rejects.toThrow('queue_capacity_exceeded');
  release.resolve(); await Promise.all(operations);
  expect(peak).toBe(2); expect(f.commands.filter(command => command.kind === 'projection.messages.body')).toHaveLength(32);
  expect(f.renderer.getSnapshot().messages.filter(row => row.bodyState === 'loaded')).toHaveLength(32);
  expect(f.renderer.getSnapshot().messages.find(row => row.messageId === rows[0]!.messageId)?.content).toBe(`PRIVATE_BODY_${rows[0]!.messageId}`);
});
it('drops queued and in-flight body results after fixed-C navigation changes the visible window', async () => {
  const f = await fixture(), before = f.renderer.getSnapshot(), started = deferred(), release = deferred(); let calls = 0;
  f.request = async (command, read) => {
    if (command.kind === 'projection.messages.body') { calls++; if (calls === 2) started.resolve(); await release.promise; }
    return read();
  };
  const operations = before.messages.slice(0, 4).map(row => f.renderer.messages.loadBody(row.messageId, row.sessionId, row.bodyReadToken!));
  await started.promise;
  await f.renderer.messages.showWindow({ kind: 'before', anchorMessageId: before.messages[0]!.messageId, limit: 64 });
  const navigated = f.renderer.getSnapshot();
  expect(navigated.projectionWindows.messages?.manifest).toEqual(before.projectionWindows.messages?.manifest);
  release.resolve(); await Promise.all(operations);
  expect(calls).toBe(2); expect(f.renderer.getSnapshot()).toBe(navigated);
  expect(navigated.messages.every(row => row.bodyState === 'unloaded' && row.content === undefined)).toBe(true);
});
it('binds explicit body reads to the selected Session and exact metadata-window token', async () => {
  const f = await fixture(1), row = f.renderer.getSnapshot().messages[0]!;
  await f.renderer.messages.loadBody(row.messageId, 'other-session', row.bodyReadToken!);
  await f.renderer.messages.loadBody(row.messageId, row.sessionId, `sha256:${'0'.repeat(64)}`);
  expect(f.commands.some(command => command.kind === 'projection.messages.body')).toBe(false);
  await expect(f.renderer.messages.loadBody('absent', row.sessionId, row.bodyReadToken!)).rejects.toThrow('outside_range');
  expect(() => f.renderer.messages.loadBody('x'.repeat(1000), row.sessionId, row.bodyReadToken!)).toThrow();
  await f.renderer.messages.loadBody(row.messageId, row.sessionId, row.bodyReadToken!);
  expect(f.renderer.getSnapshot().messages[0]).toMatchObject({ bodyState: 'loaded', content: `PRIVATE_BODY_${row.messageId}` });
});
it('shares the 32-ticket and two-physical body budget between Message and Inbox consumers', async () => {
  const f = await fixture(32), at = '2032-01-01T00:00:00.000Z';
  await f.append([upsertChange('runs', { ...run('run-mixed', 'running', 1), inbox: Array.from({ length: 33 }, (_, index) => ({
    inputId: `input-mixed-${index}`, messageId: `input-message-${index}`, version: 1, content: `INBOX_BODY_${index}`, state: 'queued' as const,
    delivery: 'next_turn' as const, queuedAt: at, updatedAt: at })) }, 'run-mixed')]);
  await f.renderer.refresh(); const snapshot = f.renderer.getSnapshot(), current = snapshot.runs[0]!;
  const started = deferred(), release = deferred(); let active = 0, peak = 0;
  f.request = async (command, read) => {
    if (command.kind !== 'projection.messages.body' && command.kind !== 'projection.run_document.chunk') return read();
    active++; peak = Math.max(peak, active); if (active === 2) started.resolve();
    try { await release.promise; return await read(); } finally { active--; }
  };
  const operations = snapshot.messages.slice(0, 16).flatMap((message, index) => [
    f.renderer.messages.loadBody(message.messageId, message.sessionId, message.bodyReadToken!),
    f.renderer.runs.loadInboxBody(current.runId, current.sessionId!, current.inbox[index]!.inputId, current.documentToken)
  ]);
  await started.promise;
  await expect(f.renderer.runs.loadInboxBody(current.runId, current.sessionId!, current.inbox[16]!.inputId, current.documentToken)).rejects.toThrow('queue_capacity_exceeded');
  release.resolve(); await Promise.all(operations);
  expect(peak).toBe(2);
  expect(f.renderer.getSnapshot().messages.filter(message => message.bodyState === 'loaded')).toHaveLength(16);
  expect(f.renderer.getSnapshot().runs[0]!.inbox.filter(input => input.bodyState === 'loaded')).toHaveLength(16);
});
it('latches a body proof failure without publishing changed bytes or fabricating a complete message', async () => {
  const f = await fixture(1), row = f.renderer.getSnapshot().messages[0]!;
  f.request = async (command, read) => {
    const result = await read();
    return command.kind === 'projection.messages.body' && result.kind === 'projection.messages.body_result' && result.body.status === 'ok'
      ? { ...result, body: { ...result.body, message: { ...result.body.message, content: 'FORGED_BODY' } } } : result;
  };
  await expect(f.renderer.messages.loadBody(row.messageId, row.sessionId, row.bodyReadToken!)).rejects.toThrow('projection_protocol_integrity_error');
  expect(f.renderer.getSnapshot().projectionIntegrityError).toContain('message_body_payload_digest_mismatch');
  expect(f.renderer.getSnapshot().messages[0]).toMatchObject({ bodyState: 'unloaded' });
  expect(JSON.stringify(f.renderer.getSnapshot())).not.toContain('FORGED_BODY');
});
it('preserves Message/Run/inference invalidations after replacing the old complete Session scope scan', async () => {
  const f = await fixture(1), row = f.renderer.getSnapshot().messages[0]!;
  await f.renderer.messages.loadBody(row.messageId, row.sessionId, row.bodyReadToken!);
  await f.append([upsertChange('messages', { ...message(row.messageId, 'session-a', 2), content: 'NEW_BODY' }, row.messageId)]);
  await f.renderer.refresh();
  expect(f.renderer.getSnapshot().messages[0]).toMatchObject({ bodyState: 'unloaded' });
  const next = f.renderer.getSnapshot().messages[0]!;
  await f.renderer.messages.loadBody(next.messageId, next.sessionId, next.bodyReadToken!);
  expect(f.renderer.getSnapshot().messages[0]?.content).toBe('NEW_BODY');
  const projected = { ...run('run-a', 'running'), interactionMessages: [{ ...message('interaction-a', 'session-a'), runId: 'run-a', content: 'INTERACTION' }] };
  await f.append([upsertChange('runs', projected, 'run-a')]); await f.renderer.refresh();
  expect(f.renderer.getSnapshot().messages.some(message => message.messageId === 'interaction-a')).toBe(true);
  expect(f.commands.some(command => command.kind === 'projection.conversation.receipts')).toBe(true);
  expect(f.commands.some(command => command.kind === 'projection.scope.read' || command.kind === 'projection.messages.window')).toBe(false);
});
it('renews an expired body range locally and requires the new metadata token before reading its body', async () => {
  let now = new Date('2032-01-01T00:00:00.000Z');
  const f = await fixture(1, { now: () => now }), first = f.renderer.getSnapshot(), row = first.messages[0]!;
  now = new Date(now.getTime() + 300_001);
  await f.renderer.messages.loadBody(row.messageId, row.sessionId, row.bodyReadToken!);
  const renewed = f.renderer.getSnapshot(), next = renewed.messages[0]!;
  expect(renewed.projectionIntegrityError).toBeNull(); expect(renewed.projectionWindows.messages?.manifest.snapshotId).not.toBe(first.projectionWindows.messages?.manifest.snapshotId);
  expect(next.bodyState).toBe('unloaded'); expect(next.bodyReadToken).not.toBe(row.bodyReadToken);
  const count = f.commands.filter(command => command.kind === 'projection.messages.body').length;
  await f.renderer.messages.loadBody(row.messageId, row.sessionId, row.bodyReadToken!);
  expect(f.commands.filter(command => command.kind === 'projection.messages.body')).toHaveLength(count);
  await f.renderer.messages.loadBody(next.messageId, next.sessionId, next.bodyReadToken!);
  expect(f.renderer.getSnapshot().messages[0]?.content).toBe(`PRIVATE_BODY_${row.messageId}`);
});
