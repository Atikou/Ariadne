import { createHash } from 'node:crypto';
import { sameAgentPinnedToolIdentity, type AgentEffectExecutionInput, type AgentRun } from '@ariadne/agent-core';
import { memoryToolRequestSchema } from '@ariadne/protocol/host';
import type { AgentMemoryToolAuthority } from '../control/ports/AgentMemoryToolAuthority.js';
import type { LongMemoryAuthority } from '../control/ports/LongMemoryAuthority.js';
import type { AgentToolCatalogSnapshot } from '../control/ports/AgentToolExecution.js';

/** Checks the exact durable Effect, implementation pin and protected input before scoped memory access. */
export class ProductionAgentMemoryToolAuthority implements AgentMemoryToolAuthority {
  public constructor(private readonly memory: LongMemoryAuthority,
    private readonly loadRun: (runId: string) => Promise<AgentRun | null>,
    private readonly loadEffectInput: (runId: string, effectId: string) => Promise<AgentEffectExecutionInput>,
    private readonly catalogs: readonly AgentToolCatalogSnapshot[]) {}
  public async invoke(invocation: Parameters<AgentMemoryToolAuthority['invoke']>[0], signal: AbortSignal) {
    signal.throwIfAborted(); const request = memoryToolRequestSchema.parse(invocation.request);
    const run = await this.loadRun(invocation.runId);
    if (run === null || run.runId !== invocation.runId || run.cancellationRequest !== undefined) throw new Error('memory_tool_run_not_authorized');
    const effect = run.effects.find(item => item.effectId === invocation.effectId);
    if (!effect || effect.runId !== run.runId || effect.idempotencyKey !== invocation.idempotencyKey || effect.tool.toolName !== request.toolName
      || effect.scope.length !== 1 || effect.scope[0] !== run.binding.workspace.workspaceId
      || !['started','uncertain','succeeded'].includes(effect.state.status)) throw new Error('memory_tool_effect_not_authorized');
    const pinned = this.catalogs.flatMap(catalog => catalog.entries).find(entry => entry.tool.toolName === request.toolName
      && sameAgentPinnedToolIdentity(entry.tool, effect.tool));
    if (!pinned) throw new Error('memory_tool_pin_not_authorized');
    const binding = run.binding;
    if (binding.toolCatalog.catalogId !== pinned.tool.catalogId || binding.toolCatalog.revision !== pinned.tool.revision
      || binding.toolCatalog.digest !== pinned.tool.digest || !binding.toolCatalog.allowedToolNames.includes(request.toolName)
      || (pinned.document.requiredWorkspaceAccess === 'write' && binding.workspace.access !== 'write')
      || pinned.document.capabilityIds.some(capability => !effect.capabilityIds.includes(capability)
        || !binding.capabilities.some(grant => grant.capabilityId === capability && grant.scopeIds.includes(binding.workspace.workspaceId)))) {
      throw new Error('memory_tool_grant_not_authorized');
    }
    const input = await this.loadEffectInput(run.runId, effect.effectId);
    if (input.runId !== run.runId || input.effectId !== effect.effectId || input.inputDigest !== effect.inputDigest
      || JSON.stringify(memoryToolRequestSchema.parse({ toolName: request.toolName, input: input.input }).input) !== JSON.stringify(request.input)) {
      throw new Error('memory_tool_input_conflict');
    }
    signal.throwIfAborted(); const owner = { workspaceId: run.binding.workspace.workspaceId, sessionId: run.binding.sessionId };
    const commandId = 'memory-tool.' + createHash('sha256').update(JSON.stringify([run.runId, effect.effectId, invocation.idempotencyKey])).digest('hex');
    if (request.toolName === 'memory.recall') return this.memory.recall(owner, request.input.query, request.input.limit, signal);
    if (request.toolName === 'memory.read') return this.memory.execute(commandId, { kind: 'memory.read', contractVersion: '5.0', ...owner, ...request.input }, signal);
    return this.memory.stageCandidate(commandId, { ...owner, ...request.input, memoryId: 'candidate.' + commandId.slice('memory-tool.'.length), runId: run.runId }, signal);
  }
}
