import type { AgentToolJsonValue } from '@ariadne/agent-core';

import type {
  WorkspaceLspOperation,
  WorkspaceLspService
} from '../../adapters/code-intelligence/SandboxWorkspaceLspService.js';
import { LocalWorkspaceFileService } from '../../adapters/filesystem/LocalWorkspaceFileService.js';
import type {
  TrustedAgentToolRegistrationV1
} from '../../adapters/tool/TrustedAgentToolCatalogCompiler.js';
import type { AgentToolInputValidationResult } from '../../control/ports/AgentToolExecution.js';
import {
  MAX_TEXT_BYTES,
  failed,
  hasUnknownKeys,
  isRecord,
  normalizeRelativePath,
  objectSchema,
  registration,
  requiredStringProperty,
  requireWorkspace,
  resolveExistingWorkspacePath,
  succeeded,
  type WorkspaceBinding
} from './FirstPartyAgentToolSupport.js';

const OPERATIONS = new Set<WorkspaceLspOperation>([
  'definition',
  'references',
  'hover',
  'document_symbols'
]);

export function createWorkspaceLspAgentToolRegistration(
  roots: ReadonlyMap<string, WorkspaceBinding>,
  files: LocalWorkspaceFileService,
  lsp?: WorkspaceLspService
): TrustedAgentToolRegistrationV1 {
  return registration({
    implementationModuleUrl: import.meta.url,
    toolName: 'workspace.code_intelligence',
    model: {
      description: 'Query sandboxed LSP 3.18 definition, references, hover, or document symbols for TypeScript and JavaScript.',
      guidance: [
        'Provide one-based line and column except for document_symbols.',
        'Use literal search first when the symbol location is unknown.'
      ]
    },
    presentation: { kind: 'file_search', label: '查询代码语义', resultVisibility: 'protected' },
    capabilityIds: ['workspace.read'],
    requiredWorkspaceAccess: 'read',
    sideEffect: 'read',
    approval: 'never',
    inputSchema: objectSchema({
      operation: { enum: [...OPERATIONS] },
      path: { type: 'string', description: 'Workspace-relative TypeScript or JavaScript path.' },
      line: { type: 'integer', minimum: 1 },
      column: { type: 'integer', minimum: 1 }
    }, ['operation', 'path']),
    outputSchema: { type: 'object' },
    timeoutMs: 20_000,
    validate: validateLspInput,
    execute: async (input, context) => {
      try {
        if (lsp === undefined) throw new Error('workspace_lsp_sandbox_unavailable');
        const workspace = requireWorkspace(roots, context, 'read');
        const relativePath = requiredStringProperty(input, 'path');
        const absolutePath = await resolveExistingWorkspacePath(
          workspace.rootPath,
          relativePath
        );
        const read = await files.readText({
          absolutePath,
          maxBytes: MAX_TEXT_BYTES,
          signal: context.signal
        });
        const operation = requiredStringProperty(input, 'operation') as WorkspaceLspOperation;
        const result = await lsp.query(workspace.rootPath, {
          operation,
          absolutePath,
          content: read.content,
          signal: context.signal,
          ...(operation === 'document_symbols'
            ? {}
            : {
                line: Number((input as Record<string, AgentToolJsonValue>).line),
                column: Number((input as Record<string, AgentToolJsonValue>).column)
              })
        });
        return succeeded({
          path: normalizeRelativePath(relativePath),
          fileVersion: read.version,
          provider: 'typescript-language-server@6.0.0',
          result
        });
      } catch (error) {
        return failed('workspace_lsp_failed', error);
      }
    }
  });
}

function validateLspInput(input: AgentToolJsonValue): AgentToolInputValidationResult {
  if (
    !isRecord(input)
    || hasUnknownKeys(input, ['operation', 'path', 'line', 'column'])
    || typeof input.operation !== 'string'
    || !OPERATIONS.has(input.operation as WorkspaceLspOperation)
    || typeof input.path !== 'string'
    || input.path.length === 0
  ) return { status: 'rejected' };
  if (input.operation === 'document_symbols') {
    return input.line === undefined && input.column === undefined
      ? { status: 'accepted', input: { operation: input.operation, path: input.path } }
      : { status: 'rejected' };
  }
  if (
    !Number.isSafeInteger(input.line)
    || Number(input.line) < 1
    || !Number.isSafeInteger(input.column)
    || Number(input.column) < 1
  ) return { status: 'rejected' };
  return {
    status: 'accepted',
    input: {
      operation: input.operation,
      path: input.path,
      line: Number(input.line),
      column: Number(input.column)
    }
  };
}
