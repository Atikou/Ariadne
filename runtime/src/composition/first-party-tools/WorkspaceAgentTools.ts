import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { AgentToolJsonValue } from '@ariadne/agent-core';

import type {
  TrustedAgentToolRegistrationV1
} from '../../adapters/tool/TrustedAgentToolCatalogCompiler.js';
import type { AgentProcessSandbox } from '../../control/ports/AgentProcessSandbox.js';
import {
  MAX_DIRECTORY_ENTRIES,
  MAX_PROCESS_OUTPUT_BYTES,
  MAX_TEXT_BYTES,
  compareCodeUnits,
  failed,
  hasUnknownKeys,
  isRecord,
  normalizeRelativePath,
  objectSchema,
  optionalStringObject,
  registration,
  requiredStringObject,
  requiredStringPairObject,
  requiredStringProperty,
  requireWorkspace,
  resolveExistingWorkspacePath,
  resolveWritableWorkspacePath,
  stringArrayProperty,
  stringProperty,
  succeeded,
  type FirstPartyProcessSandboxFactory,
  type WorkspaceBinding
} from './FirstPartyAgentToolSupport.js';

export function createWorkspaceAgentToolRegistrations(
  roots: ReadonlyMap<string, WorkspaceBinding>,
  processSandboxFactory?: FirstPartyProcessSandboxFactory
): readonly TrustedAgentToolRegistrationV1[] {
  return [
    listFilesRegistration(roots),
    readFileRegistration(roots),
    runCommandRegistration(roots, processSandboxFactory),
    writeFileRegistration(roots)
  ];
}

function listFilesRegistration(
  roots: ReadonlyMap<string, WorkspaceBinding>
): TrustedAgentToolRegistrationV1 {
  return registration({
    toolName: 'workspace.list_files',
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

function readFileRegistration(
  roots: ReadonlyMap<string, WorkspaceBinding>
): TrustedAgentToolRegistrationV1 {
  return registration({
    toolName: 'workspace.read_file',
    capabilityIds: ['workspace.read'],
    requiredWorkspaceAccess: 'read',
    sideEffect: 'read',
    approval: 'never',
    inputSchema: objectSchema({
      path: { type: 'string', description: 'Workspace-relative UTF-8 file path.' }
    }, ['path']),
    outputSchema: { type: 'object' },
    validate: (input) => requiredStringObject(input, 'path'),
    execute: async (input, context) => {
      try {
        const workspace = requireWorkspace(roots, context, 'read');
        const relativePath = requiredStringProperty(input, 'path');
        const target = await resolveExistingWorkspacePath(workspace.rootPath, relativePath);
        const bytes = await readFile(target);
        if (bytes.byteLength > MAX_TEXT_BYTES) throw new Error('file_exceeds_read_limit');
        return succeeded({
          path: normalizeRelativePath(relativePath),
          content: bytes.toString('utf8'),
          byteLength: bytes.byteLength
        });
      } catch (error) {
        return failed('workspace_read_failed', error);
      }
    }
  });
}

function writeFileRegistration(
  roots: ReadonlyMap<string, WorkspaceBinding>
): TrustedAgentToolRegistrationV1 {
  return registration({
    toolName: 'workspace.write_file',
    capabilityIds: ['workspace.write'],
    requiredWorkspaceAccess: 'write',
    sideEffect: 'write',
    approval: 'required',
    inputSchema: objectSchema({
      path: { type: 'string', description: 'Workspace-relative UTF-8 file path.' },
      content: { type: 'string', description: 'Complete replacement content.' }
    }, ['content', 'path']),
    outputSchema: { type: 'object' },
    validate: (input) => requiredStringPairObject(input, 'path', 'content'),
    execute: async (input, context) => {
      try {
        const workspace = requireWorkspace(roots, context, 'write');
        const relativePath = requiredStringProperty(input, 'path');
        const content = requiredStringProperty(input, 'content', true);
        const byteLength = Buffer.byteLength(content, 'utf8');
        if (byteLength > MAX_TEXT_BYTES) throw new Error('file_exceeds_write_limit');
        const target = await resolveWritableWorkspacePath(workspace.rootPath, relativePath);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content, 'utf8');
        return succeeded({
          path: normalizeRelativePath(relativePath),
          byteLength
        });
      } catch (error) {
        return failed('workspace_write_failed', error);
      }
    }
  });
}

function runCommandRegistration(
  roots: ReadonlyMap<string, WorkspaceBinding>,
  processSandboxFactory?: FirstPartyProcessSandboxFactory
): TrustedAgentToolRegistrationV1 {
  return registration({
    toolName: 'workspace.run_command',
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
