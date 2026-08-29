import type { AgentToolJsonValue } from '@ariadne/agent-core';

import type { TrustedAgentToolRegistrationV1 } from '../../adapters/tool/TrustedAgentToolCatalogCompiler.js';
import { AgentProcessLiveWorkProducer } from '../../control/resources/AgentProcessLiveWorkProducer.js';
import { AgentTerminalLiveWorkProducer } from '../../control/resources/AgentTerminalLiveWorkProducer.js';
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
import {
  acceptedLiveWorkInput,
  liveWorkJobSnapshot,
  liveWorkJsonValue,
  liveWorkOwner,
  rejectedLiveWorkInput
} from './LiveWorkAgentToolSupport.js';

const DEFAULT_TERMINAL_COLUMNS = 120;
const DEFAULT_TERMINAL_ROWS = 30;
const MAX_TERMINAL_DIMENSION = 1_000;
const MAX_ARGUMENT_VECTOR_CHARACTERS = 28_000;

export function createLiveWorkStartAgentToolRegistrations(
  roots: ReadonlyMap<string, WorkspaceBinding>,
  processes: AgentProcessLiveWorkProducer,
  terminals: AgentTerminalLiveWorkProducer
): readonly TrustedAgentToolRegistrationV1[] {
  return [
    processStartRegistration(roots, processes),
    terminalStartRegistration(roots, terminals)
  ];
}

function processStartRegistration(
  roots: ReadonlyMap<string, WorkspaceBinding>,
  processes: AgentProcessLiveWorkProducer
): TrustedAgentToolRegistrationV1 {
  return registration({
    implementationModuleUrl: import.meta.url,
    toolName: 'workspace.process_start',
    model: {
      description: 'Start a durable bounded pipe process in the approved Workspace and return a live-work job handle.',
      guidance: ['Use job_output, job_wait, job_signal, or job_kill to control the returned job.']
    },
    presentation: { kind: 'command', label: '启动工作区进程', resultVisibility: 'protected' },
    capabilityIds: ['workspace.shell'],
    requiredWorkspaceAccess: 'write',
    sideEffect: 'external',
    approval: 'required',
    resourceSemantics: 'workspace_resource_id',
    lifecycleSemantics: 'resource_create',
    inputSchema: objectSchema({
      command: { type: 'string', description: 'Executable name or absolute path. No shell syntax.' },
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
        const cwd = await resolveExistingWorkspacePath(
          workspace.rootPath,
          stringProperty(input, 'cwd') ?? '.'
        );
        context.signal.throwIfAborted();
        return succeeded(liveWorkJsonValue(liveWorkJobSnapshot(processes.start({
          owner: liveWorkOwner(context),
          idempotencyKey: context.idempotencyKey,
          workspaceRoot: workspace.rootPath,
          command,
          args,
          cwd
        }))));
      } catch (error) {
        return failed('workspace_process_start_failed', error);
      }
    }
  });
}

function terminalStartRegistration(
  roots: ReadonlyMap<string, WorkspaceBinding>,
  terminals: AgentTerminalLiveWorkProducer
): TrustedAgentToolRegistrationV1 {
  return registration({
    implementationModuleUrl: import.meta.url,
    toolName: 'workspace.terminal_start',
    model: {
      description: 'Start an interactive pseudoterminal in the approved Workspace and return a live-work job handle.',
      guidance: ['Use job_write and job_resize only for a terminal job that advertises those capabilities.']
    },
    presentation: { kind: 'terminal', label: '启动工作区终端', resultVisibility: 'protected' },
    capabilityIds: ['workspace.shell'],
    requiredWorkspaceAccess: 'write',
    sideEffect: 'external',
    approval: 'required',
    resourceSemantics: 'workspace_resource_id',
    lifecycleSemantics: 'resource_create',
    inputSchema: objectSchema({
      command: { type: 'string', description: 'Executable hosted by the pseudoterminal. No shell syntax.' },
      args: { type: 'array', items: { type: 'string' }, description: 'Argument vector.' },
      cwd: { type: 'string', description: 'Optional workspace-relative working directory.' },
      columns: { type: 'integer', minimum: 1, maximum: MAX_TERMINAL_DIMENSION },
      rows: { type: 'integer', minimum: 1, maximum: MAX_TERMINAL_DIMENSION }
    }, ['args', 'command']),
    outputSchema: { type: 'object' },
    validate: validateTerminalStart,
    execute: async (input, context) => {
      try {
        context.signal.throwIfAborted();
        const workspace = requireWorkspace(roots, context, 'write');
        const command = requiredStringProperty(input, 'command');
        const args = stringArrayProperty(input, 'args');
        const cwd = await resolveExistingWorkspacePath(
          workspace.rootPath,
          stringProperty(input, 'cwd') ?? '.'
        );
        context.signal.throwIfAborted();
        return succeeded(liveWorkJsonValue(liveWorkJobSnapshot(terminals.start({
          owner: liveWorkOwner(context),
          idempotencyKey: context.idempotencyKey,
          workspaceRoot: workspace.rootPath,
          command,
          args,
          cwd,
          columns: integerProperty(input, 'columns') ?? DEFAULT_TERMINAL_COLUMNS,
          rows: integerProperty(input, 'rows') ?? DEFAULT_TERMINAL_ROWS
        }))));
      } catch (error) {
        return failed('workspace_terminal_start_failed', error);
      }
    }
  });
}

function validateStart(input: AgentToolJsonValue) {
  if (!isRecord(input) || hasUnknownKeys(input, ['command', 'args', 'cwd'])) {
    return rejectedLiveWorkInput();
  }
  const { command, args, cwd } = input;
  if (!validInvocation(command, args, cwd)) return rejectedLiveWorkInput();
  return acceptedLiveWorkInput(liveWorkJsonValue({
    command,
    args: [...args],
    ...(cwd === undefined ? {} : { cwd })
  }));
}

function validateTerminalStart(input: AgentToolJsonValue) {
  if (!isRecord(input)
    || hasUnknownKeys(input, ['command', 'args', 'cwd', 'columns', 'rows'])) {
    return rejectedLiveWorkInput();
  }
  const { command, args, cwd, columns, rows } = input;
  if (!validInvocation(command, args, cwd)
    || !optionalInteger(columns, 1, MAX_TERMINAL_DIMENSION)
    || !optionalInteger(rows, 1, MAX_TERMINAL_DIMENSION)) return rejectedLiveWorkInput();
  return acceptedLiveWorkInput(liveWorkJsonValue({
    command,
    args: [...args],
    ...(cwd === undefined ? {} : { cwd }),
    ...(columns === undefined ? {} : { columns }),
    ...(rows === undefined ? {} : { rows })
  }));
}

function validInvocation(
  command: AgentToolJsonValue | undefined,
  args: AgentToolJsonValue | undefined,
  cwd: AgentToolJsonValue | undefined
): args is readonly AgentToolJsonValue[] {
  return typeof command === 'string' && command.length > 0
    && Array.isArray(args) && args.length <= 128
    && args.every((value) => typeof value === 'string' && value.length <= 8_192)
    && args.reduce<number>(
      (total, value) => total + (typeof value === 'string' ? value.length + 3 : 0),
      0
    ) <= MAX_ARGUMENT_VECTOR_CHARACTERS
    && (cwd === undefined || (typeof cwd === 'string' && cwd.length > 0));
}

function optionalInteger(value: AgentToolJsonValue | undefined, min: number, max: number): boolean {
  return value === undefined
    || (typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max);
}

function integerProperty(input: AgentToolJsonValue, key: string): number | undefined {
  if (!isRecord(input)) throw new Error('tool_input_invalid');
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number') throw new Error('tool_input_invalid');
  return value;
}
