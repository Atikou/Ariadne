import { readdir } from 'node:fs/promises';

import type { AgentToolJsonValue } from '@ariadne/agent-core';

import type {
  TrustedAgentToolRegistrationV1
} from '../../adapters/tool/TrustedAgentToolCatalogCompiler.js';
import type { AgentProcessSandbox } from '../../control/ports/AgentProcessSandbox.js';
import { LocalWorkspaceFileService } from '../../adapters/filesystem/LocalWorkspaceFileService.js';
import {
  MAX_DIRECTORY_ENTRIES,
  MAX_PROCESS_OUTPUT_BYTES,
  compareCodeUnits,
  failed,
  hasUnknownKeys,
  isRecord,
  normalizeRelativePath,
  objectSchema,
  optionalStringObject,
  registration,
  requiredStringProperty,
  requireWorkspace,
  resolveExistingWorkspacePath,
  stringArrayProperty,
  stringProperty,
  succeeded,
  type FirstPartyProcessSandboxFactory,
  type WorkspaceBinding
} from './FirstPartyAgentToolSupport.js';
import { createWorkspaceFileAgentToolRegistrations } from './WorkspaceFileAgentTools.js';
import { createWorkspaceSearchAgentToolRegistrations } from './WorkspaceSearchAgentTools.js';

export function createWorkspaceAgentToolRegistrations(
  roots: ReadonlyMap<string, WorkspaceBinding>,
  processSandboxFactory?: FirstPartyProcessSandboxFactory
): readonly TrustedAgentToolRegistrationV1[] {
  const workspaceFiles = new LocalWorkspaceFileService();
  return [
    listFilesRegistration(roots),
    ...createWorkspaceFileAgentToolRegistrations(roots, workspaceFiles),
    ...createWorkspaceSearchAgentToolRegistrations(roots, workspaceFiles),
    runCommandRegistration(roots, processSandboxFactory)
  ];
}

function listFilesRegistration(
  roots: ReadonlyMap<string, WorkspaceBinding>
): TrustedAgentToolRegistrationV1 {
  return registration({
    implementationModuleUrl: import.meta.url,
    toolName: 'workspace.list_files',
    model: {
      description: 'List the immediate entries of one approved Workspace directory.',
      guidance: ['Use workspace.glob for recursive path discovery.']
    },
    presentation: { kind: 'file_search', label: '列出工作区文件', resultVisibility: 'protected' },
    capabilityIds: ['workspace.read'],
    requiredWorkspaceAccess: 'read',
    sideEffect: 'read',
    approval: 'never',
    inputSchema: objectSchema({
      directory: {
        type: 'string',
        description: 'Workspace-relative directory. Defaults to the workspace root.'
      }
    }, []),
    outputSchema: { type: 'object' },
    validate: (input) => optionalStringObject(input, 'directory'),
    execute: async (input, context) => {
      try {
        const workspace = requireWorkspace(roots, context, 'read');
        const directory = stringProperty(input, 'directory') ?? '.';
        const target = await resolveExistingWorkspacePath(workspace.rootPath, directory);
        const entries = await readdir(target, { withFileTypes: true });
        const bounded = entries
          .sort((left, right) => compareCodeUnits(left.name, right.name))
          .slice(0, MAX_DIRECTORY_ENTRIES)
          .map((entry) => ({
            name: entry.name,
            kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other'
          }));
        return succeeded({
          directory: normalizeRelativePath(directory),
          entries: bounded,
          truncated: entries.length > bounded.length
        });
      } catch (error) {
        return failed('workspace_list_failed', error);
      }
    }
  });
}

function runCommandRegistration(
  roots: ReadonlyMap<string, WorkspaceBinding>,
  processSandboxFactory?: FirstPartyProcessSandboxFactory
): TrustedAgentToolRegistrationV1 {
  return registration({
    implementationModuleUrl: import.meta.url,
    toolName: 'workspace.run_command',
    model: {
      description: 'Run one bounded executable with an explicit argument vector inside the approved Workspace sandbox.',
      guidance: [
        'No shell syntax is accepted.',
        'Prefer structured Workspace Tools for reading, searching, or editing files.'
      ]
    },
    presentation: { kind: 'command', label: '运行工作区命令', resultVisibility: 'protected' },
    capabilityIds: ['workspace.shell'],
    requiredWorkspaceAccess: 'write',
    sideEffect: 'external',
    approval: 'required',
    inputSchema: objectSchema({
      command: {
        type: 'string',
        description: 'Executable name or absolute executable path. No shell syntax.'
      },
      args: { type: 'array', items: { type: 'string' }, description: 'Argument vector.' },
      cwd: { type: 'string', description: 'Optional workspace-relative working directory.' }
    }, ['args', 'command']),
    outputSchema: { type: 'object' },
    validate: validateCommandInput,
    execute: async (input, context) => {
      try {
        const workspace = requireWorkspace(roots, context, 'write');
        const command = requiredStringProperty(input, 'command');
        const args = stringArrayProperty(input, 'args');
        const relativeCwd = stringProperty(input, 'cwd') ?? '.';
        const cwd = await resolveExistingWorkspacePath(workspace.rootPath, relativeCwd);
        if (processSandboxFactory === undefined) {
          throw new Error('workspace_process_sandbox_unavailable');
        }
        return succeeded(await executeProcess(
          processSandboxFactory(workspace.rootPath),
          workspace,
          command,
          args,
          cwd,
          context.signal
        ));
      } catch (error) {
        return failed('workspace_command_failed', error);
      }
    }
  });
}

function validateCommandInput(input: AgentToolJsonValue) {
  if (!isRecord(input) || hasUnknownKeys(input, ['command', 'args', 'cwd'])) {
    return { status: 'rejected' as const };
  }
  const { command, args, cwd } = input;
  if (
    typeof command !== 'string'
    || command.length === 0
    || !Array.isArray(args)
    || args.length > 128
    || args.some((value) => typeof value !== 'string' || value.length > 8_192)
    || (cwd !== undefined && (typeof cwd !== 'string' || cwd.length === 0))
  ) return { status: 'rejected' as const };
  return {
    status: 'accepted' as const,
    input: { command, args: [...args], ...(cwd === undefined ? {} : { cwd }) }
  };
}

async function executeProcess(
  sandbox: AgentProcessSandbox,
  workspace: WorkspaceBinding,
  command: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal
): Promise<AgentToolJsonValue> {
  const result = await sandbox.runFile({
    file: command,
    args: [...args],
    cwd,
    workspaceRoot: workspace.rootPath,
    mode: sandbox.mode,
    networkMode: 'offline',
    timeoutMs: 30_000,
    maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
    signal
  });
  if (result.spawnFailed) {
    throw new Error(result.errorCode ?? 'workspace_process_start_failed');
  }
  return {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
    outputTruncated: result.truncated,
    timedOut: result.timedOut,
    isolation: {
      backend: result.isolation.backend,
      enforced: result.isolation.enforced,
      mode: result.isolation.mode,
      networkMode: result.isolation.networkMode
    }
  };
}
