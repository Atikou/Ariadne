import { TASK_CENTER_QUERY_VERSION } from '@ariadne/protocol/public';
import { TaskCenterRuntimeService } from './TaskCenterRuntimeService.js';
import { defineAgentPublicCommandOwner } from './agent-entity/command-owners/AgentPublicCommandOwnerTable.js';
import { completedPublicError } from './AgentPublicCommandFailures.js';
import { readOwnedAuthorityFault } from '../adapters/persistence/SqliteAuthorityHealth.js';

export function createTaskCenterCommandOwners(service: TaskCenterRuntimeService | undefined) {
  return [defineAgentPublicCommandOwner('task-center.query', ['tasks.query'], async (envelope, command) => {
    if (service === undefined) return { outcome: { ok: true as const, result: {
      kind: 'tasks.query_reset' as const, contractVersion: TASK_CENTER_QUERY_VERSION, reason: 'unavailable' as const } }, settlement: 'completed' as const };
    try {
      const result = await service.query(command, envelope.signal);
      return { outcome: { ok: true as const, result }, settlement: 'completed' as const };
    } catch (error) {
      envelope.signal.throwIfAborted();
      if (readOwnedAuthorityFault(error) === null) throw error;
      return { outcome: { ok: true as const, result: { kind: 'tasks.query_reset' as const,
        contractVersion: TASK_CENTER_QUERY_VERSION, reason: 'unavailable' as const } }, settlement: 'completed' as const };
    }
  }, async () => ({ kind: 'not_committed' })),
  defineAgentPublicCommandOwner('task-center.navigation', ['tasks.navigate'], async (envelope, command) => {
    if (service === undefined) return completedPublicError(envelope, 'task_center_unavailable', 'Task navigation is unavailable.', false);
    try {
      const result = await service.navigate(command, envelope.signal);
      return { outcome: { ok: true as const, result }, settlement: 'completed' as const };
    } catch (error) {
      envelope.signal.throwIfAborted();
      if (readOwnedAuthorityFault(error) === null) throw error;
      return completedPublicError(envelope, 'task_center_source_unavailable', 'Task source is unavailable.', false);
    }
  }, async () => ({ kind: 'not_committed' })),
  defineAgentPublicCommandOwner('task-center.relations', ['tasks.relations'], async (envelope, command) => {
    if (service === undefined) return completedPublicError(envelope, 'task_center_unavailable', 'Task relations are unavailable.', false);
    try {
      const result = await service.relations(command, envelope.signal);
      return { outcome: { ok: true as const, result }, settlement: 'completed' as const };
    } catch (error) {
      envelope.signal.throwIfAborted();
      if (readOwnedAuthorityFault(error) === null) throw error;
      return completedPublicError(envelope, 'task_center_source_unavailable', 'Task source is unavailable.', false);
    }
  }, async () => ({ kind: 'not_committed' }))];
}
