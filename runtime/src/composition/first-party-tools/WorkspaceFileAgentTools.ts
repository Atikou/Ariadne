import type { AgentToolJsonValue } from '@ariadne/agent-core';

import {
  LocalWorkspaceFileError,
  LocalWorkspaceFileService
} from '../../adapters/filesystem/LocalWorkspaceFileService.js';
import type {
  TrustedAgentToolRegistrationV1
} from '../../adapters/tool/TrustedAgentToolCatalogCompiler.js';
import type {
  AgentToolInputValidationResult
} from '../../control/ports/AgentToolExecution.js';
import type {
  WorkspaceFileVersion,
  WorkspaceTextEdit
} from '../../control/ports/WorkspaceFileService.js';
import {
  MAX_TEXT_BYTES,
  failed,
  hasUnknownKeys,
  isRecord,
  normalizeRelativePath,
  objectSchema,
  registration,
  requiredStringObject,
  requiredStringProperty,
  requireWorkspace,
  resolveExistingWorkspacePath,
  resolveWritableWorkspacePath,
  succeeded,
  type WorkspaceBinding
} from './FirstPartyAgentToolSupport.js';

export function createWorkspaceFileAgentToolRegistrations(
  roots: ReadonlyMap<string, WorkspaceBinding>,
  workspaceFiles: LocalWorkspaceFileService
): readonly TrustedAgentToolRegistrationV1[] {
  return [
    readFileRegistration(roots, workspaceFiles),
    applyTextEditsRegistration(roots, workspaceFiles),
    writeFileRegistration(roots, workspaceFiles),
    moveFileRegistration(roots, workspaceFiles),
    deleteFileRegistration(roots, workspaceFiles)
  ];
}

function moveFileRegistration(
  roots: ReadonlyMap<string, WorkspaceBinding>,
  workspaceFiles: LocalWorkspaceFileService
): TrustedAgentToolRegistrationV1 {
  return registration({
    implementationModuleUrl: import.meta.url,
    toolName: 'workspace.move_file',
    model: {
      description: 'Move one observed regular UTF-8 file to a new absent Workspace path.',
      guidance: [
        'Use the exact version returned by workspace.read_file.',
        'The destination is never overwritten.'
      ]
    },
    presentation: { kind: 'file_change', label: '移动工作区文件', resultVisibility: 'protected' },
    capabilityIds: ['workspace.write'],
    requiredWorkspaceAccess: 'write',
    sideEffect: 'write',
    approval: 'required',
    inputSchema: objectSchema({
      sourcePath: { type: 'string' },
      destinationPath: { type: 'string' },
      expectedVersion: { type: 'string', pattern: '^workspace-file-v1:[a-f0-9]{64}$' }
    }, ['destinationPath', 'expectedVersion', 'sourcePath']),
    outputSchema: objectSchema({
      sourcePath: { type: 'string' },
      destinationPath: { type: 'string' },
      operation: { const: 'moved' },
      byteLength: { type: 'integer', minimum: 0 },
      previousVersion: { type: 'string', pattern: '^workspace-file-v1:[a-f0-9]{64}$' },
      version: { type: 'string', pattern: '^workspace-file-v1:[a-f0-9]{64}$' }
    }, ['byteLength', 'destinationPath', 'operation', 'previousVersion', 'sourcePath', 'version']),
    validate: validateWorkspaceMoveInput,
    execute: async (input, context) => {
      try {
        const workspace = requireWorkspace(roots, context, 'write');
        const sourcePath = requiredStringProperty(input, 'sourcePath');
        const destinationPath = requiredStringProperty(input, 'destinationPath');
        const expectedVersion = requiredStringProperty(input, 'expectedVersion') as WorkspaceFileVersion;
        const [source, destination] = await Promise.all([
          resolveExistingWorkspacePath(workspace.rootPath, sourcePath),
          resolveWritableWorkspacePath(workspace.rootPath, destinationPath)
        ]);
        const result = await workspaceFiles.moveText({
          sourceAbsolutePath: source,
          destinationAbsolutePath: destination,
          expectedVersion,
          maxBytes: MAX_TEXT_BYTES,
          signal: context.signal
        });
        return succeeded({
          sourcePath: normalizeRelativePath(sourcePath),
          destinationPath: normalizeRelativePath(destinationPath),
          operation: result.operation,
          byteLength: result.byteLength,
          previousVersion: expectedVersion,
          version: result.version
        });
      } catch (error) {
        return failed(workspaceFileErrorCode(error, 'workspace_move_failed'), error);
      }
    }
  });
}

function deleteFileRegistration(
  roots: ReadonlyMap<string, WorkspaceBinding>,
  workspaceFiles: LocalWorkspaceFileService
): TrustedAgentToolRegistrationV1 {
  return registration({
    implementationModuleUrl: import.meta.url,
    toolName: 'workspace.delete_file',
    model: {
      description: 'Delete one observed regular UTF-8 Workspace file using exact version CAS.',
      guidance: ['Use the exact version returned by workspace.read_file. Directories are rejected.']
    },
    presentation: { kind: 'file_change', label: '删除工作区文件', resultVisibility: 'protected' },
    capabilityIds: ['workspace.write'],
    requiredWorkspaceAccess: 'write',
    sideEffect: 'write',
    approval: 'required',
    inputSchema: objectSchema({
      path: { type: 'string' },
      expectedVersion: { type: 'string', pattern: '^workspace-file-v1:[a-f0-9]{64}$' }
    }, ['expectedVersion', 'path']),
    outputSchema: objectSchema({
      path: { type: 'string' },
      operation: { const: 'deleted' },
      byteLength: { type: 'integer', minimum: 0 },
      previousVersion: { type: 'string', pattern: '^workspace-file-v1:[a-f0-9]{64}$' }
    }, ['byteLength', 'operation', 'path', 'previousVersion']),
    validate: validateWorkspaceDeleteInput,
    execute: async (input, context) => {
      try {
        const workspace = requireWorkspace(roots, context, 'write');
        const relativePath = requiredStringProperty(input, 'path');
        const expectedVersion = requiredStringProperty(input, 'expectedVersion') as WorkspaceFileVersion;
        const target = await resolveExistingWorkspacePath(workspace.rootPath, relativePath);
        const result = await workspaceFiles.deleteText({
          absolutePath: target,
          expectedVersion,
          maxBytes: MAX_TEXT_BYTES,
          signal: context.signal
        });
        return succeeded({
          path: normalizeRelativePath(relativePath),
          operation: result.operation,
          byteLength: result.byteLength,
          previousVersion: expectedVersion
        });
      } catch (error) {
        return failed(workspaceFileErrorCode(error, 'workspace_delete_failed'), error);
      }
    }
  });
}

function readFileRegistration(
  roots: ReadonlyMap<string, WorkspaceBinding>,
  workspaceFiles: LocalWorkspaceFileService
): TrustedAgentToolRegistrationV1 {
  return registration({
    implementationModuleUrl: import.meta.url,
    toolName: 'workspace.read_file',
    toolVersion: '2.0.0',
    model: {
      description: 'Read one bounded UTF-8 Workspace file and return its opaque freshness version.',
      guidance: ['Retain the returned version for replace_if_version or apply_text_edits.']
    },
    presentation: { kind: 'file_read', label: '读取工作区文件', resultVisibility: 'protected' },
    capabilityIds: ['workspace.read'],
    requiredWorkspaceAccess: 'read',
    sideEffect: 'read',
    approval: 'never',
    inputSchema: objectSchema({
      path: { type: 'string', description: 'Workspace-relative UTF-8 file path.' }
    }, ['path']),
    outputSchema: objectSchema({
      path: { type: 'string' },
      content: { type: 'string' },
      byteLength: { type: 'integer', minimum: 0 },
      version: {
        type: 'string',
        pattern: '^workspace-file-v1:[a-f0-9]{64}$'
      }
    }, ['byteLength', 'content', 'path', 'version']),
    validate: (input) => requiredStringObject(input, 'path'),
    execute: async (input, context) => {
      try {
        const workspace = requireWorkspace(roots, context, 'read');
        const relativePath = requiredStringProperty(input, 'path');
        const target = await resolveExistingWorkspacePath(workspace.rootPath, relativePath);
        const result = await workspaceFiles.readText({
          absolutePath: target,
          maxBytes: MAX_TEXT_BYTES,
          signal: context.signal
        });
        return succeeded({
          path: normalizeRelativePath(relativePath),
          content: result.content,
          byteLength: result.byteLength,
          version: result.version
        });
      } catch (error) {
        return failed(workspaceFileErrorCode(error, 'workspace_read_failed'), error);
      }
    }
  });
}

function writeFileRegistration(
  roots: ReadonlyMap<string, WorkspaceBinding>,
  workspaceFiles: LocalWorkspaceFileService
): TrustedAgentToolRegistrationV1 {
  return registration({
    implementationModuleUrl: import.meta.url,
    toolName: 'workspace.write_file',
    toolVersion: '2.0.0',
    model: {
      description: 'Create a new Workspace file or replace an observed file using its exact opaque version.',
      guidance: [
        'Use create_if_absent only for a path that must not already exist.',
        'Use replace_if_version only after workspace.read_file; stale versions are rejected.'
      ]
    },
    presentation: { kind: 'file_change', label: '写入工作区文件', resultVisibility: 'protected' },
    capabilityIds: ['workspace.write'],
    requiredWorkspaceAccess: 'write',
    sideEffect: 'write',
    approval: 'required',
    inputSchema: {
      oneOf: [{
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: 'Workspace-relative UTF-8 file path.' },
          content: { type: 'string', description: 'Complete file content.' },
          mode: { const: 'create_if_absent' }
        },
        required: ['content', 'mode', 'path']
      }, {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: 'Workspace-relative UTF-8 file path.' },
          content: { type: 'string', description: 'Complete replacement content.' },
          mode: { const: 'replace_if_version' },
          expectedVersion: {
            type: 'string',
            pattern: '^workspace-file-v1:[a-f0-9]{64}$',
            description: 'Opaque version returned by workspace.read_file.'
          }
        },
        required: ['content', 'expectedVersion', 'mode', 'path']
      }]
    },
    outputSchema: objectSchema({
      path: { type: 'string' },
      byteLength: { type: 'integer', minimum: 0 },
      diff: { type: 'string', maxLength: 70_000 },
      operation: { enum: ['created', 'replaced'] },
      version: {
        type: 'string',
        pattern: '^workspace-file-v1:[a-f0-9]{64}$'
      }
    }, ['byteLength', 'operation', 'path', 'version']),
    validate: validateWorkspaceWriteInput,
    execute: async (input, context) => {
      try {
        const workspace = requireWorkspace(roots, context, 'write');
        const relativePath = requiredStringProperty(input, 'path');
        const content = requiredStringProperty(input, 'content', true);
        const target = await resolveWritableWorkspacePath(workspace.rootPath, relativePath);
        const mode = requiredStringProperty(input, 'mode');
        const result = await workspaceFiles.writeText({
          absolutePath: target,
          content,
          expected: mode === 'create_if_absent'
            ? { kind: 'create_if_absent' }
            : {
                kind: 'replace_if_version',
                version: requiredStringProperty(input, 'expectedVersion') as
                  WorkspaceFileVersion
              },
          maxBytes: MAX_TEXT_BYTES,
          signal: context.signal
        });
        return succeeded({
          path: normalizeRelativePath(relativePath),
          byteLength: result.byteLength,
          diff: boundedUnifiedDiff(
            normalizeRelativePath(relativePath),
            result.previousContent ?? '',
            result.content
          ),
          operation: result.operation,
          version: result.version
        });
      } catch (error) {
        return failed(workspaceFileErrorCode(error, 'workspace_write_failed'), error);
      }
    }
  });
}

function applyTextEditsRegistration(
  roots: ReadonlyMap<string, WorkspaceBinding>,
  workspaceFiles: LocalWorkspaceFileService
): TrustedAgentToolRegistrationV1 {
  const positionSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      line: { type: 'integer', minimum: 1 },
      column: { type: 'integer', minimum: 1 }
    },
    required: ['column', 'line']
  };
  return registration({
    implementationModuleUrl: import.meta.url,
    toolName: 'workspace.apply_text_edits',
    toolVersion: '1.0.0',
    model: {
      description: 'Apply bounded non-overlapping text replacements to one observed Workspace file.',
      guidance: [
        'Use the exact version returned by read_file or search_text.',
        'Lines and Unicode columns are one-based and ranges are half-open.'
      ]
    },
    presentation: { kind: 'file_change', label: '编辑工作区文件', resultVisibility: 'protected' },
    capabilityIds: ['workspace.write'],
    requiredWorkspaceAccess: 'write',
    sideEffect: 'write',
    approval: 'required',
    inputSchema: objectSchema({
      path: { type: 'string', description: 'Workspace-relative UTF-8 file path.' },
      expectedVersion: {
        type: 'string',
        pattern: '^workspace-file-v1:[a-f0-9]{64}$',
        description: 'Opaque version returned by workspace.read_file.'
      },
      edits: {
        type: 'array',
        minItems: 1,
        maxItems: 128,
        description: 'Non-overlapping half-open replacements. Lines and Unicode columns are one-based.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            start: positionSchema,
            end: positionSchema,
            text: { type: 'string', description: 'Replacement text; empty text deletes the range.' }
          },
          required: ['end', 'start', 'text']
        }
      }
    }, ['edits', 'expectedVersion', 'path']),
    outputSchema: objectSchema({
      path: { type: 'string' },
      operation: { const: 'edited' },
      appliedEdits: { type: 'integer', minimum: 1 },
      byteLength: { type: 'integer', minimum: 0 },
      diff: { type: 'string', maxLength: 70_000 },
      previousVersion: { type: 'string', pattern: '^workspace-file-v1:[a-f0-9]{64}$' },
      version: { type: 'string', pattern: '^workspace-file-v1:[a-f0-9]{64}$' }
    }, ['appliedEdits', 'byteLength', 'operation', 'path', 'previousVersion', 'version']),
    validate: validateWorkspaceTextEditsInput,
    execute: async (input, context) => {
      try {
        const workspace = requireWorkspace(roots, context, 'write');
        const relativePath = requiredStringProperty(input, 'path');
        const expectedVersion = requiredStringProperty(input, 'expectedVersion') as
          WorkspaceFileVersion;
        const edits = workspaceTextEditsProperty(input);
        const target = await resolveWritableWorkspacePath(workspace.rootPath, relativePath);
        const result = await workspaceFiles.editText({
          absolutePath: target,
          edits,
          expectedVersion,
          maxBytes: MAX_TEXT_BYTES,
          signal: context.signal
        });
        return succeeded({
          path: normalizeRelativePath(relativePath),
          operation: result.operation,
          appliedEdits: result.appliedEdits,
          byteLength: result.byteLength,
          diff: boundedUnifiedDiff(
            normalizeRelativePath(relativePath),
            result.previousContent,
            result.content
          ),
          previousVersion: expectedVersion,
          version: result.version
        });
      } catch (error) {
        return failed(workspaceFileErrorCode(error, 'workspace_edit_failed'), error);
      }
    }
  });
}

function validateWorkspaceWriteInput(
  input: AgentToolJsonValue
): AgentToolInputValidationResult {
  if (!isRecord(input)) return { status: 'rejected' };
  const { path, content, mode, expectedVersion } = input;
  if (
    typeof path !== 'string'
    || path.length === 0
    || typeof content !== 'string'
    || (mode !== 'create_if_absent' && mode !== 'replace_if_version')
  ) return { status: 'rejected' };
  if (mode === 'create_if_absent') {
    return !hasUnknownKeys(input, ['path', 'content', 'mode'])
      ? { status: 'accepted', input: { path, content, mode } }
      : { status: 'rejected' };
  }
  if (
    hasUnknownKeys(input, ['path', 'content', 'mode', 'expectedVersion'])
    || typeof expectedVersion !== 'string'
    || !/^workspace-file-v1:[a-f0-9]{64}$/u.test(expectedVersion)
  ) return { status: 'rejected' };
  return {
    status: 'accepted',
    input: { path, content, mode, expectedVersion }
  };
}

function validateWorkspaceMoveInput(
  input: AgentToolJsonValue
): AgentToolInputValidationResult {
  if (
    !isRecord(input)
    || hasUnknownKeys(input, ['sourcePath', 'destinationPath', 'expectedVersion'])
    || typeof input.sourcePath !== 'string'
    || input.sourcePath.length === 0
    || typeof input.destinationPath !== 'string'
    || input.destinationPath.length === 0
    || typeof input.expectedVersion !== 'string'
    || !/^workspace-file-v1:[a-f0-9]{64}$/u.test(input.expectedVersion)
  ) return { status: 'rejected' };
  return {
    status: 'accepted',
    input: {
      sourcePath: input.sourcePath,
      destinationPath: input.destinationPath,
      expectedVersion: input.expectedVersion
    }
  };
}

function validateWorkspaceDeleteInput(
  input: AgentToolJsonValue
): AgentToolInputValidationResult {
  if (
    !isRecord(input)
    || hasUnknownKeys(input, ['path', 'expectedVersion'])
    || typeof input.path !== 'string'
    || input.path.length === 0
    || typeof input.expectedVersion !== 'string'
    || !/^workspace-file-v1:[a-f0-9]{64}$/u.test(input.expectedVersion)
  ) return { status: 'rejected' };
  return {
    status: 'accepted',
    input: { path: input.path, expectedVersion: input.expectedVersion }
  };
}

function validateWorkspaceTextEditsInput(
  input: AgentToolJsonValue
): AgentToolInputValidationResult {
  if (
    !isRecord(input)
    || hasUnknownKeys(input, ['path', 'expectedVersion', 'edits'])
    || typeof input.path !== 'string'
    || input.path.length === 0
    || typeof input.expectedVersion !== 'string'
    || !/^workspace-file-v1:[a-f0-9]{64}$/u.test(input.expectedVersion)
    || !Array.isArray(input.edits)
    || input.edits.length === 0
    || input.edits.length > 128
  ) return { status: 'rejected' };
  const edits: AgentToolJsonValue[] = [];
  for (const edit of input.edits) {
    if (
      !isRecord(edit)
      || hasUnknownKeys(edit, ['start', 'end', 'text'])
      || !isWorkspaceTextPosition(edit.start)
      || !isWorkspaceTextPosition(edit.end)
      || typeof edit.text !== 'string'
    ) return { status: 'rejected' };
    edits.push({
      start: { line: edit.start.line, column: edit.start.column },
      end: { line: edit.end.line, column: edit.end.column },
      text: edit.text
    });
  }
  return {
    status: 'accepted',
    input: {
      path: input.path,
      expectedVersion: input.expectedVersion,
      edits
    }
  };
}

function workspaceTextEditsProperty(input: AgentToolJsonValue): readonly WorkspaceTextEdit[] {
  if (!isRecord(input) || !Array.isArray(input.edits)) {
    throw new Error('workspace_text_edits_invalid');
  }
  return input.edits.map((edit) => {
    if (
      !isRecord(edit)
      || !isWorkspaceTextPosition(edit.start)
      || !isWorkspaceTextPosition(edit.end)
      || typeof edit.text !== 'string'
    ) throw new Error('workspace_text_edits_invalid');
    return {
      start: { line: edit.start.line, column: edit.start.column },
      end: { line: edit.end.line, column: edit.end.column },
      text: edit.text
    };
  });
}

function isWorkspaceTextPosition(
  value: AgentToolJsonValue | undefined
): value is Readonly<Record<'line' | 'column', number>> {
  return isRecord(value)
    && !hasUnknownKeys(value, ['line', 'column'])
    && Number.isSafeInteger(value.line)
    && Number.isSafeInteger(value.column)
    && Number(value.line) > 0
    && Number(value.column) > 0;
}

function workspaceFileErrorCode(error: unknown, fallback: string): string {
  return error instanceof LocalWorkspaceFileError ? error.code : fallback;
}

const MAX_PROTECTED_DIFF_BYTES = 64 * 1024;

function boundedUnifiedDiff(pathValue: string, before: string, after: string): string {
  const beforeLines = diffLines(before);
  const afterLines = diffLines(after);
  const lines = [
    `--- a/${pathValue}`,
    `+++ b/${pathValue}`,
    `@@ -1,${String(beforeLines.length)} +1,${String(afterLines.length)} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`)
  ];
  const selected: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const next = Buffer.byteLength(`${line}\n`, 'utf8');
    if (bytes + next > MAX_PROTECTED_DIFF_BYTES) {
      selected.push('… diff truncated');
      break;
    }
    selected.push(line);
    bytes += next;
  }
  return `${selected.join('\n')}\n`;
}

function diffLines(content: string): readonly string[] {
  if (content.length === 0) return [];
  const lines = content.split(/\r\n|\n|\r/u);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}
