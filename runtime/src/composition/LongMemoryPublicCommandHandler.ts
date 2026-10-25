import type { LongMemoryCommand } from '@ariadne/protocol/public';
import type { LongMemoryAuthority, LongMemoryMutation } from '../control/ports/LongMemoryAuthority.js';
import type { SqliteConversationRunHandoffUnitOfWork } from '../adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import type { RuntimeCommandEnvelope } from '../ingress/RuntimeIngress.js';
import type { RuntimeApplicationCommandResult } from '../ingress/RuntimeApplication.js';
import { completedPublicError } from './AgentPublicCommandFailures.js';
import { defineAgentPublicCommandOwner, type AgentPublicCommandOwner } from './agent-entity/command-owners/AgentPublicCommandOwnerTable.js';

const kinds = ['memory.query', 'memory.read', 'memory.put', 'memory.transition', 'memory.delete', 'memory.recall'] as const;
const mutations = new Set(['memory.put','memory.transition','memory.delete']);
const errors: Readonly<Record<string, string>> = {
  long_memory_version_conflict: '记忆已被更新，请刷新后再操作。', long_memory_scope_conflict: '记忆属于其他作用域，不能覆盖或移动。',
  long_memory_not_found: '记忆已删除或不属于当前作用域。', long_memory_command_conflict: '命令身份已用于其他记忆操作。',
  long_memory_version_exhausted: '记忆版本已达到上限。', long_memory_clock_regressed: '记忆时钟早于已提交的更新。'
};
export class LongMemoryPublicCommandHandler {
  private readonly workspaces: ReadonlySet<string>;
  public constructor(private readonly authority: LongMemoryAuthority | undefined,
    private readonly conversation: SqliteConversationRunHandoffUnitOfWork, workspaceIds: readonly string[]) { this.workspaces = new Set(workspaceIds); }
  public async execute(envelope: RuntimeCommandEnvelope, command: LongMemoryCommand): Promise<RuntimeApplicationCommandResult> {
    const unavailable = await this.validate(envelope, command); if (unavailable) return unavailable;
    try { const result = await this.authority!.execute(envelope.commandId, command, envelope.signal);
      return { settlement: 'completed', outcome: { ok: true, result } }; }
    catch (error) { if (error instanceof Error && errors[error.message]) return completedPublicError(envelope, error.message, errors[error.message]!, false); throw error; }
  }
  public async reconcile(envelope: RuntimeCommandEnvelope, command: LongMemoryMutation): Promise<RuntimeApplicationCommandResult | null> {
    const unavailable = await this.validate(envelope, command); if (unavailable) return unavailable;
    const result = await this.authority!.reconcile(envelope.commandId, command);
    return result ? { settlement: 'completed', outcome: { ok: true, result } } : null;
  }
  private async validate(envelope: RuntimeCommandEnvelope, command: LongMemoryCommand): Promise<RuntimeApplicationCommandResult | null> {
    envelope.signal.throwIfAborted(); if (!this.authority) return completedPublicError(envelope, 'long_memory_unavailable', '长期记忆服务不可用。', false);
    if (this.workspaces.size > 0 && !this.workspaces.has(command.workspaceId)) return completedPublicError(envelope, 'workspace_not_authorized', '工作区未获授权。', false);
    const session = await this.conversation.readSession(command.sessionId); envelope.signal.throwIfAborted();
    if (!session || session.workspaceId !== command.workspaceId) return completedPublicError(envelope, 'conversation_session_not_found', '会话不属于当前工作区。', false);
    return null;
  }
}
export function createLongMemoryCommandOwners(handler: LongMemoryPublicCommandHandler): readonly AgentPublicCommandOwner[] {
  return [defineAgentPublicCommandOwner('long-memory', kinds, (envelope, command) => handler.execute(envelope, command),
    async (envelope, command) => {
      if (!mutations.has(command.kind)) return { kind: 'not_committed' };
      const result = await handler.reconcile(envelope, command as LongMemoryMutation);
      return result?.outcome.ok ? { kind: 'committed', outcome: result.outcome } : { kind: 'not_committed' };
    })];
}
