import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LongMemoryCommand } from '@ariadne/protocol/public';
import { createProductionLongMemoryService, type ProductionLongMemoryService } from '../src/composition/ProductionLongMemoryService.js';
import { LongMemoryPublicCommandHandler, createLongMemoryCommandOwners } from '../src/composition/LongMemoryPublicCommandHandler.js';
import { SqliteConversationRunHandoffUnitOfWork } from '../src/adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import { ConversationAuthorityService } from '../src/control/conversation/ConversationAuthorityService.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';

const scope = { contractVersion: '5.0', workspaceId: 'workspace-a', sessionId: 'session-a' } as const;
const put = { ...scope, kind: 'memory.put', memoryId: 'memory-a', expectedVersion: null, scope: 'workspace', memoryType: 'preference',
  title: 'Communication preference', content: '用中文回答', importance: 0.9, confidence: 1, sensitivity: 'workspace', retentionUntil: null } as const;
const roots: string[] = []; const services: ProductionLongMemoryService[] = []; const conversations: SqliteConversationRunHandoffUnitOfWork[] = [];
afterEach(async () => {
  const shutdown = createShutdownContext(Date.now() + 5_000);
  try { for (const service of services.splice(0)) await service.close(shutdown);
    for (const conversation of conversations.splice(0)) await conversation.close(shutdown); }
  finally { shutdown.dispose(); }
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});
async function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), 'ariadne-memory-public-')); roots.push(directory);
  const memory = createProductionLongMemoryService(directory, { provider: 'lexical' }); services.push(memory);
  const conversation = new SqliteConversationRunHandoffUnitOfWork(directory); conversations.push(conversation);
  await new ConversationAuthorityService(conversation).createSession({ kind: 'conversation.create_session', commandId: 'session-create', eventId: 'session-event',
    workspaceId: scope.workspaceId, sessionId: scope.sessionId, expectedVersion: null, occurredAt: new Date().toISOString() });
  return { memory, conversation, owner: new LongMemoryPublicCommandHandler(memory, conversation, [scope.workspaceId]) };
}
const envelope = (commandId: string, command: LongMemoryCommand) => ({ commandId, command, correlationId: commandId,
  deadlineAt: '2098-01-01T00:00:00Z', signal: new AbortController().signal });

describe('public long-memory command owner', () => {
  it('commits user data with a metadata-only receipt and reconciles the exact command', async () => {
    const { owner } = await setup(); const request = envelope('create', put);
    const receipt = await owner.execute(request, put); expect(receipt).toMatchObject({ settlement: 'completed', outcome: {
      ok: true, result: { kind: 'memory.updated', memoryId: 'memory-a', version: 1 } } });
    expect(await owner.reconcile(request, put)).toEqual(receipt);
    const read = { ...scope, kind: 'memory.read', memoryId: 'memory-a' } as const;
    expect(await owner.execute(envelope('read', read), read)).toMatchObject({ outcome: { ok: true, result: {
      kind: 'memory.read_result', memory: { status: 'active', provenance: { kind: 'user' }, content: put.content } } } });
    const commandOwner = createLongMemoryCommandOwners(owner)[0]!;
    expect(commandOwner).toBeDefined();
  });
  it('denies unknown workspaces and mismatched sessions before any memory write', async () => {
    const { owner, memory } = await setup();
    for (const [command, code] of [[{ ...put, workspaceId: 'foreign' }, 'workspace_not_authorized'],
      [{ ...put, sessionId: 'absent' }, 'conversation_session_not_found']] as const) {
      expect(await owner.execute(envelope('denied-' + code, command), command)).toMatchObject({ outcome: { ok: false, error: { code } } });
    }
    expect(await memory.reconcile('denied-workspace_not_authorized', { ...put, workspaceId: 'foreign' })).toBeNull();
    expect(await memory.instructionMemories(scope, new AbortController().signal)).toEqual([]);
  });
  it('returns a specific optimistic conflict without overwriting the committed value', async () => {
    const { owner } = await setup(); await owner.execute(envelope('create', put), put);
    const stale = { ...put, content: 'stale edit' };
    expect(await owner.execute(envelope('stale', stale), stale)).toMatchObject({ outcome: { ok: false, error: { code: 'long_memory_version_conflict' } } });
    expect(await owner.reconcile(envelope('stale', stale), stale)).toBeNull();
  });
  it('reports service unavailability and observes pre-aborted requests', async () => {
    const { conversation } = await setup(); const owner = new LongMemoryPublicCommandHandler(undefined, conversation, [scope.workspaceId]);
    expect(await owner.execute(envelope('unavailable', put), put)).toMatchObject({ outcome: { ok: false, error: { code: 'long_memory_unavailable' } } });
    const abort = new AbortController(); abort.abort(new Error('caller cancelled'));
    await expect(owner.execute({ ...envelope('cancelled', put), signal: abort.signal }, put)).rejects.toThrow('caller cancelled');
  });
});
