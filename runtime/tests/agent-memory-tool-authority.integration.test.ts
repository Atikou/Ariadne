import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentRunCommandService, type AgentRun, type AgentRunCheckpointCommit, type AgentToolJsonValue } from '@ariadne/agent-core';
import { memoryCandidateToolInputSchema, type MemoryToolRequest } from '@ariadne/protocol/host';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAgentRunUnitOfWork } from '../src/adapters/persistence/SqliteAgentRunUnitOfWork.js';
import { Sha256AgentEffectInputDigester } from '../src/adapters/persistence/Sha256AgentEffectInputDigester.js';
import { compileTrustedAgentToolCatalog } from '../src/adapters/tool/TrustedAgentToolCatalogCompiler.js';
import { createMemoryAgentToolRegistrations } from '../src/composition/first-party-tools/MemoryAgentTools.js';
import { ProductionAgentMemoryToolAuthority } from '../src/composition/ProductionAgentMemoryToolAuthority.js';
import { createProductionLongMemoryService, type ProductionLongMemoryService } from '../src/composition/ProductionLongMemoryService.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';

const scope = { workspaceId: 'workspace-a', sessionId: 'session-a' };
const candidate = { scope: 'session', memoryType: 'preference', title: 'Language', content: 'Chinese responses', importance: 0.9,
  confidence: 0.9, sensitivity: 'workspace', retentionUntil: null } as const;
const roots: string[] = []; const units: SqliteAgentRunUnitOfWork[] = []; const memories: ProductionLongMemoryService[] = [];
afterEach(async () => {
  const shutdown = createShutdownContext(Date.now() + 5_000);
  try { for (const memory of memories.splice(0)) await memory.close(shutdown); for (const unit of units.splice(0)) await unit.close(shutdown); }
  finally { shutdown.dispose(); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function checkpoint(version: number, at: string) {
  const checkpoint: AgentRunCheckpointCommit = { checkpointVersion: version, createdAt: at, payload: { format: 'ariadne.agent-checkpoint',
    schemaVersion: 1, engineContinuation: { phase: 'memory-fixture' }, modelContext: null } };
  return { checkpoint, turnInputPayloads: [] as const, effectPayloads: [] as const };
}
async function setup(request: MemoryToolRequest = { toolName: 'memory.stage_candidate', input: candidate }) {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-memory-tool-')); roots.push(root);
  const unit = new SqliteAgentRunUnitOfWork(root); units.push(unit);
  const memory = createProductionLongMemoryService(root, { provider: 'lexical' }); memories.push(memory);
  const catalog = compileTrustedAgentToolCatalog({ catalogId: 'memory-test-catalog', revision: 1,
    tools: createMemoryAgentToolRegistrations(new Map([[scope.workspaceId, { rootPath: root, access: 'write' }]])) });
  const entry = catalog.entries.find(item => item.tool.toolName === request.toolName)!;
  const runId = 'memory-tool-run'; const effectId = 'memory-tool-effect'; const idempotencyKey = 'memory-tool-key';
  const command = new AgentRunCommandService(unit); const date = (n: number) => new Date(Date.UTC(2030, 0, 1, 0, 0, n)).toISOString();
  const effectInput = entry.executable.normalizeAndValidate(request.input);
  if (effectInput.status !== 'accepted') throw new Error('fixture_input_invalid');
  const inputDigest = new Sha256AgentEffectInputDigester().digest(effectInput.input, { runId, effectId });
  await command.execute({ kind: 'run.start', commandId: 'start', runId, occurredAt: date(0), binding: {
    bindingVersion: 3, sessionId: scope.sessionId, objectiveRef: { kind: 'conversation_message', messageId: 'objective', messageVersion: 1, contentDigest: `sha256:${'a'.repeat(64)}` },
    workspace: { workspaceId: scope.workspaceId, revision: 1, grantDigest: `sha256:${'b'.repeat(64)}`, access: 'write', scopeIds: [scope.workspaceId] },
    model: { providerId: 'fixture-provider', modelId: 'fixture-model', settingsRevision: 1 }, policy: { policyId: 'fixture-policy', revision: 1, permissionMode: 'trusted' },
    capabilities: entry.document.capabilityIds.map(capabilityId => ({ capabilityId, scopeIds: [scope.workspaceId] })),
    toolCatalog: { catalogId: catalog.catalogId, revision: catalog.revision, digest: catalog.catalogDigest, allowedToolNames: catalog.entries.map(item => item.tool.toolName) },
    budget: { grantId: 'memory-tool-budget', runId, vector: { modelTurns: 5, toolCalls: 5, readCalls: 5, writeCalls: 5, shellCalls: 0, costMicrousd: 0 },
      deadlineAt: '2099-01-01T00:00:00.000Z', source: { kind: 'root' } }
  } }, { turnInputPayloads: [], effectPayloads: [] });
  await command.execute({ kind: 'run.begin', commandId: 'begin', runId, expectedVersion: 1, occurredAt: date(1) }, checkpoint(1, date(1)));
  await command.execute({ kind: 'run.register_effect', commandId: 'register', runId, expectedVersion: 2, occurredAt: date(2), effect: {
    effectId, toolCallId: 'memory-tool-call', tool: entry.tool, idempotencyKey, capabilityIds: entry.document.capabilityIds, scope: [scope.workspaceId], inputDigest
  } }, { ...checkpoint(2, date(2)), effectPayloads: [{ kind: 'record_input', effectId, inputDigest, input: effectInput.input, recordedAt: date(2) }] });
  await command.execute({ kind: 'run.authorize_effect', commandId: 'authorize', runId, expectedVersion: 3, occurredAt: date(3), effectId }, checkpoint(3, date(3)));
  await command.execute({ kind: 'run.start_effect', commandId: 'start-effect', runId, expectedVersion: 4, occurredAt: date(4), effectId }, checkpoint(4, date(4)));
  const loadRun = () => unit.transaction(transaction => transaction.loadRun(runId));
  const loadInput = (runId: string, effectId: string) => unit.loadEffectExecutionInput(runId, effectId);
  const authority = new ProductionAgentMemoryToolAuthority(memory, loadRun, loadInput, [catalog]);
  const invocation = { runId, effectId, idempotencyKey, request };
  const context = { runId, effectId, toolCallId: 'memory-tool-call', idempotencyKey, scope: [scope.workspaceId], capabilityIds: entry.document.capabilityIds,
    signal: new AbortController().signal, memory: authority };
  return { memory, unit, catalog, authority, invocation, context, entry, loadRun, loadInput };
}

describe('Agent memory tools with durable SQLite Run and protected Effect input', () => {
  it('stages one exact candidate through its pinned executable and replays without activation or duplication', async () => {
    const h = await setup(); const first = await h.entry.executable.execute(candidate, h.context);
    expect(first).toMatchObject({ status: 'succeeded', result: { kind: 'memory.updated', version: 1 } });
    expect(await h.entry.executable.execute(candidate, h.context)).toEqual(first);
    const result = await h.memory.execute('list', { kind: 'memory.query', contractVersion: '5.0', ...scope, scope: null, status: 'all', before: null, limit: 20 }, h.context.signal);
    expect(result).toMatchObject({ kind: 'memory.query_result', memories: [{ status: 'candidate', version: 1, scopeId: scope.sessionId,
      reviewedAt: null, provenance: { kind: 'agent', runId: h.context.runId } }] });
    expect(result.kind === 'memory.query_result' && result.memories).toHaveLength(1);
    expect((await h.memory.recall(scope, 'Chinese', 20, h.context.signal)).hits).toEqual([]);
  });

  it('reads only the bound Run owner scope and recalls only reviewed records', async () => {
    const h = await setup({ toolName: 'memory.recall', input: { query: 'Chinese', limit: 5 } });
    await h.memory.execute('user', { kind: 'memory.put', contractVersion: '5.0', ...scope, ...candidate, memoryId: 'user-memory', expectedVersion: null }, h.context.signal);
    await h.memory.execute('foreign', { kind: 'memory.put', contractVersion: '5.0', ...scope, workspaceId: 'foreign', ...candidate, scope: 'workspace',
      memoryId: 'foreign-memory', expectedVersion: null }, h.context.signal);
    const recalled = await h.entry.executable.execute({ query: 'Chinese', limit: 5 }, h.context);
    expect(recalled).toMatchObject({ status: 'succeeded', result: { hits: [{ memory: { memoryId: 'user-memory' } }] } });
    expect(JSON.stringify(recalled)).not.toContain('foreign-memory');
    const read = await setup({ toolName: 'memory.read', input: { memoryId: 'not-owned' } });
    expect(await read.entry.executable.execute({ memoryId: 'not-owned' }, read.context)).toMatchObject({ status: 'succeeded', result: { memory: null } });
  });

  it('rejects a changed input and a wrong Effect identity without writing a candidate', async () => {
    const h = await setup();
    await expect(h.authority.invoke({ ...h.invocation, request: { toolName: 'memory.stage_candidate', input: { ...candidate, content: 'unapproved input' } } }, h.context.signal)).rejects.toThrow('memory_tool_input_conflict');
    await expect(h.authority.invoke({ ...h.invocation, idempotencyKey: 'wrong-key' }, h.context.signal)).rejects.toThrow('memory_tool_effect_not_authorized');
    expect(await h.memory.instructionMemories(scope, h.context.signal)).toEqual([]);
    const page = await h.memory.execute('query', { kind: 'memory.query', contractVersion: '5.0', ...scope, scope: null, status: 'all', before: null, limit: 20 }, h.context.signal);
    expect(page).toMatchObject({ memories: [] });
  });

  it('fences a foreign scope, removed Run grant, retired Tool pin and persisted cancellation intent', async () => {
    const h = await setup(); const original = (await h.loadRun())!;
    const variants: Array<[AgentRun, string]> = [
      [{ ...original, effects: original.effects.map(effect => ({ ...effect, scope: ['foreign'] })) }, 'memory_tool_effect_not_authorized'],
      [{ ...original, binding: { ...original.binding, capabilities: [] } }, 'memory_tool_grant_not_authorized'],
      [{ ...original, effects: original.effects.map(effect => ({ ...effect, tool: { ...effect.tool, contractDigest: `sha256:${'0'.repeat(64)}` } })) }, 'memory_tool_pin_not_authorized'],
      [{ ...original, cancellationRequest: { commandId: 'cancel', requestedAt: original.updatedAt, reason: 'user cancelled' } }, 'memory_tool_run_not_authorized']
    ];
    for (const [run, code] of variants) {
      const authority = new ProductionAgentMemoryToolAuthority(h.memory, async () => run, h.loadInput, [h.catalog]);
      await expect(authority.invoke(h.invocation, h.context.signal)).rejects.toThrow(code);
    }
    expect((await h.memory.recall(scope, 'Chinese', 20, h.context.signal)).hits).toEqual([]);
  });

  it('rejects global writes and forged owner or review metadata at admission', async () => {
    const h = await setup();
    const attempts: AgentToolJsonValue[] = [{ ...candidate, scope: 'global' }, { ...candidate, workspaceId: 'foreign' },
      { ...candidate, reviewedAt: '2026-10-04T00:00:00Z' }, { ...candidate, provenance: { kind: 'user' } }];
    for (const input of attempts) {
      expect(memoryCandidateToolInputSchema.safeParse(input).success).toBe(false);
      expect(h.entry.executable.normalizeAndValidate(input).status).toBe('rejected');
    }
  });
});
