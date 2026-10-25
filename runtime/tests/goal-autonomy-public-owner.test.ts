import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PUBLIC_PROJECTION_CONTRACT_VERSION, type ProductivityCommand } from '@ariadne/protocol/public';
import { SqliteProductivityStore } from '../src/adapters/persistence/SqliteProductivityStore.js';
import { SqliteConversationRunHandoffUnitOfWork } from '../src/adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import { ProductivityPublicCommandHandler } from '../src/composition/ProductivityPublicCommandHandler.js';
import { ConversationAuthorityService } from '../src/control/conversation/ConversationAuthorityService.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';

const scope = { contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, workspaceId: 'workspace-1', sessionId: 'session-1' } as const;
const deadlineAt = '2098-01-01T00:00:00Z';
const start = { ...scope, kind: 'goal.autonomy.start' as const, goalId: 'goal-1', expectedVersion: 1,
  criteria: ['Original criterion'], maxConcurrency: 1, deadlineAt };
const roots: string[] = [];
const stores: SqliteProductivityStore[] = [];
const conversations: SqliteConversationRunHandoffUnitOfWork[] = [];
afterEach(async () => {
  const shutdown = createShutdownContext(Date.now() + 5_000);
  try {
    for (const store of stores.splice(0)) await store.close(shutdown);
    for (const conversation of conversations.splice(0)) await conversation.close(shutdown);
  } finally { shutdown.dispose(); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-goal-owner-')); roots.push(root);
  const store = new SqliteProductivityStore(root); stores.push(store);
  const conversation = new SqliteConversationRunHandoffUnitOfWork(root); conversations.push(conversation);
  const authority = new ConversationAuthorityService(conversation);
  await authority.createSession({ kind: 'conversation.create_session', commandId: 'create-parent', eventId: 'create-parent-event',
    workspaceId: scope.workspaceId, sessionId: scope.sessionId, expectedVersion: null, occurredAt: new Date().toISOString() });
  await store.execute('goal', { ...scope, kind: 'goal.put', goalId: 'goal-1', expectedVersion: null,
    title: 'Original Goal', phase: 'implementation', status: 'active', roundCap: 3 });
  const accept = (messageId: string, version: number, content: string) => authority.acceptUserMessage({
    kind: 'conversation.accept_user_message', commandId: `${messageId}-command`, eventId: `${messageId}-event`,
    workspaceId: scope.workspaceId, sessionId: scope.sessionId, expectedSessionVersion: version,
    messageId, expectedMessageVersion: null, content, sagaId: `${messageId}-saga`, handoffCommandId: `${messageId}-handoff`,
    handoffOutboxMessageId: `${messageId}-outbox`, occurredAt: new Date().toISOString() });
  return { store, conversation, accept };
}
async function send(owner: ProductivityPublicCommandHandler, commandId: string, command: ProductivityCommand) {
  return owner.execute({ commandId, command, signal: new AbortController().signal, correlationId: commandId, deadlineAt }, command);
}
describe('Goal autonomous public admission and immutable parent context', () => {
  it('rejects a new start while its production executor is unavailable without changing Goal authority', async () => {
    const h = await setup();
    const owner = new ProductivityPublicCommandHandler(h.store, h.conversation, [scope.workspaceId], true);
    expect(await send(owner, 'start', start)).toMatchObject({ settlement: 'completed', outcome: { ok: false, error: { code: 'goal_autonomy_unavailable' } } });
    expect((await h.store.query(scope.workspaceId, scope.sessionId)).goal!.version).toBe(1);
    expect(await h.store.pendingGoalAutonomy()).toEqual([]);
  });

  it('freezes exact parent history and replays the receipt before attempting fresh admission or capture', async () => {
    const h = await setup(); await h.accept('first', 1, 'Original parent requirement');
    const admission = vi.fn(); const owner = new ProductivityPublicCommandHandler(h.store, h.conversation, [scope.workspaceId], true, admission);
    const receipt = await send(owner, 'start', start); expect(receipt.outcome.ok).toBe(true);
    const goal = (await h.store.pendingGoalAutonomy())[0]!;
    expect(goal.agentExecution!.context).toMatchObject({ sourceSessionId: scope.sessionId, sourceSessionVersion: 2,
      boundary: { sessionId: scope.sessionId, messageId: 'first', messageVersion: 1 } });
    await h.accept('later', 2, 'Later requirement');
    admission.mockImplementation(() => { throw new Error('goal_autonomy_unavailable'); });
    expect(await send(owner, 'start', start)).toEqual(receipt);
    expect(admission).toHaveBeenCalledTimes(1);
    expect((await h.store.pendingGoalAutonomy())[0]!.agentExecution!.context).toEqual(goal.agentExecution!.context);
  });

  it('requires current production admission for resume and reconciles a committed resume despite later unavailability', async () => {
    const h = await setup(); const admission = vi.fn();
    const available = new ProductivityPublicCommandHandler(h.store, h.conversation, [scope.workspaceId], true, admission);
    const unavailable = new ProductivityPublicCommandHandler(h.store, h.conversation, [scope.workspaceId], true);
    await send(available, 'start', start);
    await send(unavailable, 'pause', { ...scope, kind: 'goal.autonomy.transition', goalId: 'goal-1', expectedVersion: 2, action: 'pause' });
    await h.store.pollGoalAutonomy('goal-1');
    const paused = (await h.store.query(scope.workspaceId, scope.sessionId)).goal!;
    const resume = { ...scope, kind: 'goal.autonomy.transition' as const, goalId: 'goal-1', expectedVersion: paused.version, action: 'resume' as const };
    expect(await send(unavailable, 'resume', resume)).toMatchObject({ outcome: { ok: false, error: { code: 'goal_autonomy_unavailable' } } });
    expect((await h.store.query(scope.workspaceId, scope.sessionId)).goal!.version).toBe(paused.version);
    const receipt = await send(available, 'resume', resume); expect(receipt.outcome.ok).toBe(true);
    expect(await send(unavailable, 'resume', resume)).toEqual(receipt);
    expect(admission).toHaveBeenCalledTimes(2);
  });
});
