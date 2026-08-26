import type { AgentToolJsonValue } from '@ariadne/agent-core';

import type { TrustedAgentToolRegistrationV1 } from '../../adapters/tool/TrustedAgentToolCatalogCompiler.js';
import type { AgentToolExecutionContext } from '../../control/ports/AgentToolExecution.js';
import { AgentProcessSessionService } from '../../control/resources/AgentProcessSessionService.js';
import {
  failed,
  hasUnknownKeys,
  isRecord,
  objectSchema,
  registration,
  requiredStringProperty,
  requireWorkspace,
  resolveExistingWorkspacePath,
  stringArrayProperty,
  stringProperty,
  succeeded,
  type WorkspaceBinding
} from './FirstPartyAgentToolSupport.js';

const MAX_STDIN_TEXT_LENGTH = 64 * 1024;
const MAX_READ_BYTES = 64 * 1024;

export function createProcessSessionAgentToolRegistrations(
  roots: ReadonlyMap<string, WorkspaceBinding>,
  sessions: AgentProcessSessionService
): readonly TrustedAgentToolRegistrationV1[] {
  return [
    startRegistration(roots, sessions),
    listRegistration(roots, sessions),
    readRegistration(roots, sessions),
    writeRegistration(roots, sessions),
    stopRegistration(roots, sessions)
  ];
}

function startRegistration(
  roots: ReadonlyMap<string, WorkspaceBinding>,
  sessions: AgentProcessSessionService
): TrustedAgentToolRegistrationV1 {
  return registration({
    toolName: 'workspace.process_start',
    capabilityIds: ['workspace.shell'],
    requiredWorkspaceAccess: 'write',
    sideEffect: 'external',
    approval: 'required',
    resourceSemantics: 'workspace_resource_id',
    lifecycleSemantics: 'resource_create',
    inputSchema: objectSchema({
      command: {
        type: 'string',
        description: 'Executable name or absolute executable path. No shell syntax.'
      },
      args: { type: 'array', items: { type: 'string' }, description: 'Argument vector.' },
      cwd: { type: 'string', description: 'Optional workspace-relative working directory.' }
    }, ['args', 'command']),
    outputSchema: { type: 'object' },
    validate: validateStart,
    execute: async (input, context) => {
      try {
        context.signal.throwIfAborted();
        const workspace = requireWorkspace(roots, context, 'write');
        const command = requiredStringProperty(input, 'command');
        const args = stringArrayProperty(input, 'args');
        const relativeCwd = stringProperty(input, 'cwd') ?? '.';
        const cwd = await resolveExistingWorkspacePath(workspace.rootPath, relativeCwd);
        context.signal.throwIfAborted();
        return succeeded(jsonValue(sessions.start({
          owner: owner(context),
          idempotencyKey: context.idempotencyKey,
          workspaceRoot: workspace.rootPath,
          command,
          args,
          cwd
        })));
      } catch (error) {
        return failed('workspace_process_start_failed', error);
      }
    }
  });
}

function listRegistration(
  roots: ReadonlyMap<string, WorkspaceBinding>,
  sessions: AgentProcessSessionService
): TrustedAgentToolRegistrationV1 {
  return registration({
    toolName: 'workspace.process_list',
    capabilityIds: ['workspace.shell'],
    requiredWorkspaceAccess: 'read',
    sideEffect: 'read',
    approval: 'never',
    resourceSemantics: 'workspace_resource_id',
    lifecycleSemantics: 'resource_observe',
    inputSchema: objectSchema({}, []),
    outputSchema: { type: 'object' },
    validate: (input) => isRecord(input) && Object.keys(input).length === 0
      ? { status: 'accepted' as const, input: {} }
      : { status: 'rejected' as const },
    execute: async (_input, context) => {
      try {
        requireWorkspace(roots, context, 'read');
        return succeeded(jsonValue({ sessions: sessions.list(owner(context)) }));
      } catch (error) {
        return failed('workspace_process_list_failed', error);
      }
    }
  });
}

function readRegistration(
  roots: ReadonlyMap<string, WorkspaceBinding>,
  sessions: AgentProcessSessionService
): TrustedAgentToolRegistrationV1 {
  return registration({
    toolName: 'workspace.process_read',
    capabilityIds: ['workspace.shell'],
    requiredWorkspaceAccess: 'read',
    sideEffect: 'read',
    approval: 'never',
    resourceSemantics: 'workspace_resource_id',
    lifecycleSemantics: 'resource_observe',
    inputSchema: objectSchema({
      resourceId: { type: 'string', description: 'Process resource id returned by process_start.' },
      cursor: { type: 'integer', minimum: 0, description: 'Next unread byte cursor. Defaults to 0.' },
      maxBytes: {
        type: 'integer', minimum: 1, maximum: MAX_READ_BYTES,
        description: 'Maximum bytes to return. Defaults to 65536.'
      }
    }, ['resourceId']),
    outputSchema: { type: 'object' },
    validate: validateRead,
    execute: async (input, context) => {
      try {
        requireWorkspace(roots, context, 'read');
        return succeeded(jsonValue(sessions.read(
          owner(context),
          requiredStringProperty(input, 'resourceId'),
          numberProperty(input, 'cursor') ?? 0,
          numberProperty(input, 'maxBytes') ?? MAX_READ_BYTES
        )));
      } catch (error) {
        return failed('workspace_process_read_failed', error);
      }
    }
  });
}

function writeRegistration(
  roots: ReadonlyMap<string, WorkspaceBinding>,
  sessions: AgentProcessSessionService
): TrustedAgentToolRegistrationV1 {
  return registration({
    toolName: 'workspace.process_write',
    capabilityIds: ['workspace.shell'],
    requiredWorkspaceAccess: 'write',
    sideEffect: 'external',
    approval: 'required',
    resourceSemantics: 'workspace_resource_id',
    lifecycleSemantics: 'resource_mutate',
    inputSchema: objectSchema({
      resourceId: { type: 'string', description: 'Owned process resource id.' },
      text: { type: 'string', description: 'UTF-8 text written to stdin.' },
      submit: { type: 'boolean', description: 'Append a newline. Defaults to true.' }
    }, ['resourceId', 'text']),
    outputSchema: { type: 'object' },
    validate: validateWrite,
    execute: async (input, context) => {
      try {
        requireWorkspace(roots, context, 'write');
        context.signal.throwIfAborted();
        return succeeded(jsonValue(await sessions.write(
          owner(context),
          requiredStringProperty(input, 'resourceId'),
          requiredStringProperty(input, 'text', true),
          booleanProperty(input, 'submit') ?? true
        )));
      } catch (error) {
        return failed('workspace_process_write_failed', error);
      }
    }
  });
}

function stopRegistration(
  roots: ReadonlyMap<string, WorkspaceBinding>,
  sessions: AgentProcessSessionService
): TrustedAgentToolRegistrationV1 {
  return registration({
    toolName: 'workspace.process_stop',
    capabilityIds: ['workspace.shell'],
    requiredWorkspaceAccess: 'write',
    sideEffect: 'external',
    approval: 'required',
    resourceSemantics: 'workspace_resource_id',
    lifecycleSemantics: 'resource_close',
    inputSchema: objectSchema({
      resourceId: { type: 'string', description: 'Owned process resource id.' }
    }, ['resourceId']),
    outputSchema: { type: 'object' },
    validate: (input) => {
      if (!isRecord(input) || hasUnknownKeys(input, ['resourceId'])) {
        return { status: 'rejected' as const };
      }
      const resourceId = input.resourceId;
      return typeof resourceId === 'string' && resourceId.length > 0
        ? { status: 'accepted' as const, input: { resourceId } }
        : { status: 'rejected' as const };
    },
    execute: async (input, context) => {
      try {
        requireWorkspace(roots, context, 'write');
        context.signal.throwIfAborted();
        return succeeded(jsonValue(await sessions.stop(
          owner(context),
          requiredStringProperty(input, 'resourceId')
        )));
      } catch (error) {
        return failed('workspace_process_stop_failed', error);
      }
    }
  });
}

function owner(context: AgentToolExecutionContext) {
  if (context.scope.length !== 1) throw new Error('workspace_scope_required');
  return { runId: context.runId, workspaceId: context.scope[0]! };
}

function validateStart(input: AgentToolJsonValue) {
  if (!isRecord(input) || hasUnknownKeys(input, ['command', 'args', 'cwd'])) {
    return { status: 'rejected' as const };
  }
  const { command, args, cwd } = input;
  if (
    typeof command !== 'string' || command.length === 0
    || !Array.isArray(args) || args.length > 128
    || args.some((value) => typeof value !== 'string' || value.length > 8_192)
    || (cwd !== undefined && (typeof cwd !== 'string' || cwd.length === 0))
  ) return { status: 'rejected' as const };
  return {
    status: 'accepted' as const,
    input: { command, args: [...args], ...(cwd === undefined ? {} : { cwd }) }
  };
}

function validateRead(input: AgentToolJsonValue) {
  if (!isRecord(input) || hasUnknownKeys(input, ['resourceId', 'cursor', 'maxBytes'])) {
    return { status: 'rejected' as const };
  }
  const { resourceId, cursor, maxBytes } = input;
  if (
    typeof resourceId !== 'string' || resourceId.length === 0
    || (cursor !== undefined && (!Number.isSafeInteger(cursor) || (cursor as number) < 0))
    || (maxBytes !== undefined && (
      !Number.isSafeInteger(maxBytes) || (maxBytes as number) < 1 || (maxBytes as number) > MAX_READ_BYTES
    ))
  ) return { status: 'rejected' as const };
  return {
    status: 'accepted' as const,
    input: {
      resourceId,
      ...(cursor === undefined ? {} : { cursor }),
      ...(maxBytes === undefined ? {} : { maxBytes })
    }
  };
}

function validateWrite(input: AgentToolJsonValue) {
  if (!isRecord(input) || hasUnknownKeys(input, ['resourceId', 'text', 'submit'])) {
    return { status: 'rejected' as const };
  }
  const { resourceId, text, submit } = input;
  if (
    typeof resourceId !== 'string' || resourceId.length === 0
    || typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_STDIN_TEXT_LENGTH
    || (submit !== undefined && typeof submit !== 'boolean')
  ) return { status: 'rejected' as const };
  return {
    status: 'accepted' as const,
    input: { resourceId, text, ...(submit === undefined ? {} : { submit }) }
  };
}

function numberProperty(input: AgentToolJsonValue, key: string): number | undefined {
  if (!isRecord(input)) throw new Error('tool_input_invalid');
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number') throw new Error('tool_input_invalid');
  return value;
}

function booleanProperty(input: AgentToolJsonValue, key: string): boolean | undefined {
  if (!isRecord(input)) throw new Error('tool_input_invalid');
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error('tool_input_invalid');
  return value;
}

function jsonValue(value: unknown): AgentToolJsonValue {
  return structuredClone(value) as AgentToolJsonValue;
}
