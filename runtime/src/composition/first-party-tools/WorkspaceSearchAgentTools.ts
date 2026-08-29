import type { AgentToolJsonValue } from '@ariadne/agent-core';

import type { LocalWorkspaceFileService } from '../../adapters/filesystem/LocalWorkspaceFileService.js';
import {
  LocalWorkspaceSearchError,
  LocalWorkspaceSearchService
} from '../../adapters/filesystem/LocalWorkspaceSearchService.js';
import type { TrustedAgentToolRegistrationV1 } from '../../adapters/tool/TrustedAgentToolCatalogCompiler.js';
import type { AgentToolInputValidationResult } from '../../control/ports/AgentToolExecution.js';
import {
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

const DEFAULT_EXCLUDES = Object.freeze([
  '**/.git/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/out/**',
  '**/coverage/**'
]);

export function createWorkspaceSearchAgentToolRegistrations(
  roots: ReadonlyMap<string, WorkspaceBinding>,
  files: LocalWorkspaceFileService
): readonly TrustedAgentToolRegistrationV1[] {
  const search = new LocalWorkspaceSearchService(files);
  return [
    globRegistration(roots, search),
    searchTextRegistration(roots, search)
  ];
}

function searchTextRegistration(
  roots: ReadonlyMap<string, WorkspaceBinding>,
  search: LocalWorkspaceSearchService
): TrustedAgentToolRegistrationV1 {
  return registration({
    implementationModuleUrl: import.meta.url,
    toolName: 'workspace.search_text',
    toolVersion: '1.0.0',
    model: {
      description: 'Find bounded literal text matches across approved Workspace files without invoking a shell.',
      guidance: [
        'The query is literal, not a regular expression.',
        'Each match includes the stable file version required for a subsequent edit.'
      ]
    },
    presentation: { kind: 'file_search', label: '搜索工作区文本', resultVisibility: 'protected' },
    capabilityIds: ['workspace.read'],
    requiredWorkspaceAccess: 'read',
    sideEffect: 'read',
    approval: 'never',
    inputSchema: objectSchema({
      query: { type: 'string', description: 'Non-empty literal text to find.' },
      directory: { type: 'string', description: 'Workspace-relative search root. Defaults to . .' },
      includeGlob: {
        type: 'string',
        description: 'Safe path glob using *, ** and ?. Defaults to **/*.'
      },
      excludeGlobs: {
        type: 'array',
        maxItems: 32,
        items: { type: 'string' },
        description: 'Safe path globs to skip. Defaults exclude VCS, dependencies and build output.'
      },
      caseSensitive: { type: 'boolean', description: 'Defaults to true.' },
      maxResults: { type: 'integer', minimum: 1, maximum: 200 }
    }, ['query']),
    outputSchema: objectSchema({
      query: { type: 'string' },
      directory: { type: 'string' },
      includeGlob: { type: 'string' },
      matches: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string' },
            line: { type: 'integer', minimum: 1 },
            column: { type: 'integer', minimum: 1 },
            preview: { type: 'string' },
            version: { type: 'string', pattern: '^workspace-file-v1:[a-f0-9]{64}$' }
          },
          required: ['column', 'line', 'path', 'preview', 'version']
        }
      },
      scannedFiles: { type: 'integer', minimum: 0 },
      scannedBytes: { type: 'integer', minimum: 0 },
      skippedFiles: { type: 'integer', minimum: 0 },
      truncated: { type: 'boolean' }
    }, [
      'directory', 'includeGlob', 'matches', 'query', 'scannedBytes',
      'scannedFiles', 'skippedFiles', 'truncated'
    ]),
    validate: validateSearchTextInput,
    execute: async (input, context) => {
      try {
        const workspace = requireWorkspace(roots, context, 'read');
        const query = requiredStringProperty(input, 'query');
        const directory = optionalString(input, 'directory') ?? '.';
        const includeGlob = optionalString(input, 'includeGlob') ?? '**/*';
        const excludeGlobs = optionalStringArray(input, 'excludeGlobs') ?? DEFAULT_EXCLUDES;
        const caseSensitive = optionalBoolean(input, 'caseSensitive') ?? true;
        const maxResults = optionalPositiveInteger(input, 'maxResults') ?? 100;
        const absoluteDirectory = await resolveExistingWorkspacePath(
          workspace.rootPath,
          directory
        );
        const result = await search.searchText({
          workspaceRoot: workspace.rootPath,
          absoluteDirectory,
          query,
          caseSensitive,
          includeGlob,
          excludeGlobs,
          bounds: {
            maxResults,
            maxFiles: 5_000,
            maxTotalBytes: 16 * 1024 * 1024,
            maxFileBytes: 256 * 1024
          },
          signal: context.signal
        });
        return succeeded({
          query,
          directory: normalizeRelativePath(directory),
          includeGlob,
          matches: result.matches.map((match) => ({ ...match })),
          scannedFiles: result.scannedFiles,
          scannedBytes: result.scannedBytes,
          skippedFiles: result.skippedFiles,
          truncated: result.truncated
        });
      } catch (error) {
        return failed(workspaceSearchErrorCode(error, 'workspace_search_failed'), error);
      }
    }
  });
}

function globRegistration(
  roots: ReadonlyMap<string, WorkspaceBinding>,
  search: LocalWorkspaceSearchService
): TrustedAgentToolRegistrationV1 {
  return registration({
    implementationModuleUrl: import.meta.url,
    toolName: 'workspace.glob',
    toolVersion: '1.0.0',
    model: {
      description: 'Discover bounded Workspace paths using safe *, **, and ? glob syntax without invoking a shell.',
      guidance: ['Use forward-slash relative patterns; traversal and absolute paths are rejected.']
    },
    presentation: { kind: 'file_search', label: '匹配工作区路径', resultVisibility: 'protected' },
    capabilityIds: ['workspace.read'],
    requiredWorkspaceAccess: 'read',
    sideEffect: 'read',
    approval: 'never',
    inputSchema: objectSchema({
      pattern: { type: 'string', description: 'Safe path glob using *, ** and ?.' },
      directory: { type: 'string', description: 'Workspace-relative search root. Defaults to . .' },
      excludeGlobs: {
        type: 'array',
        maxItems: 32,
        items: { type: 'string' },
        description: 'Safe path globs to skip. Defaults exclude VCS, dependencies and build output.'
      },
      maxResults: { type: 'integer', minimum: 1, maximum: 1_000 }
    }, ['pattern']),
    outputSchema: objectSchema({
      pattern: { type: 'string' },
      directory: { type: 'string' },
      matches: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string' },
            kind: { enum: ['directory', 'file'] }
          },
          required: ['kind', 'path']
        }
      },
      scannedEntries: { type: 'integer', minimum: 0 },
      truncated: { type: 'boolean' }
    }, ['directory', 'matches', 'pattern', 'scannedEntries', 'truncated']),
    validate: validateGlobInput,
    execute: async (input, context) => {
      try {
        const workspace = requireWorkspace(roots, context, 'read');
        const pattern = requiredStringProperty(input, 'pattern');
        const directory = optionalString(input, 'directory') ?? '.';
        const excludeGlobs = optionalStringArray(input, 'excludeGlobs') ?? DEFAULT_EXCLUDES;
        const maxResults = optionalPositiveInteger(input, 'maxResults') ?? 500;
        const absoluteDirectory = await resolveExistingWorkspacePath(
          workspace.rootPath,
          directory
        );
        const result = await search.glob({
          workspaceRoot: workspace.rootPath,
          absoluteDirectory,
          pattern,
          excludeGlobs,
          maxResults,
          maxEntries: 10_000,
          signal: context.signal
        });
        return succeeded({
          pattern,
          directory: normalizeRelativePath(directory),
          matches: result.matches.map((match) => ({ ...match })),
          scannedEntries: result.scannedEntries,
          truncated: result.truncated
        });
      } catch (error) {
        return failed(workspaceSearchErrorCode(error, 'workspace_glob_failed'), error);
      }
    }
  });
}

function validateSearchTextInput(input: AgentToolJsonValue): AgentToolInputValidationResult {
  if (
    !isRecord(input)
    || hasUnknownKeys(input, [
      'query', 'directory', 'includeGlob', 'excludeGlobs', 'caseSensitive', 'maxResults'
    ])
    || typeof input.query !== 'string'
    || input.query.length === 0
    || input.query.length > 1_024
    || !validOptionalString(input.directory, 4_096)
    || !validOptionalString(input.includeGlob, 256)
    || !validOptionalStringArray(input.excludeGlobs)
    || (input.caseSensitive !== undefined && typeof input.caseSensitive !== 'boolean')
    || !validOptionalPositiveInteger(input.maxResults, 200)
  ) return { status: 'rejected' };
  const excludeGlobs = optionalStringArray(input, 'excludeGlobs');
  return {
    status: 'accepted',
    input: {
      query: input.query,
      ...(input.directory === undefined ? {} : { directory: input.directory }),
      ...(input.includeGlob === undefined ? {} : { includeGlob: input.includeGlob }),
      ...(excludeGlobs === undefined ? {} : { excludeGlobs: [...excludeGlobs] }),
      ...(input.caseSensitive === undefined ? {} : { caseSensitive: input.caseSensitive }),
      ...(input.maxResults === undefined ? {} : { maxResults: input.maxResults })
    }
  };
}

function validateGlobInput(input: AgentToolJsonValue): AgentToolInputValidationResult {
  if (
    !isRecord(input)
    || hasUnknownKeys(input, ['pattern', 'directory', 'excludeGlobs', 'maxResults'])
    || typeof input.pattern !== 'string'
    || input.pattern.length === 0
    || input.pattern.length > 256
    || !validOptionalString(input.directory, 4_096)
    || !validOptionalStringArray(input.excludeGlobs)
    || !validOptionalPositiveInteger(input.maxResults, 1_000)
  ) return { status: 'rejected' };
  const excludeGlobs = optionalStringArray(input, 'excludeGlobs');
  return {
    status: 'accepted',
    input: {
      pattern: input.pattern,
      ...(input.directory === undefined ? {} : { directory: input.directory }),
      ...(excludeGlobs === undefined ? {} : { excludeGlobs: [...excludeGlobs] }),
      ...(input.maxResults === undefined ? {} : { maxResults: input.maxResults })
    }
  };
}

function optionalString(input: AgentToolJsonValue, key: string): string | undefined {
  if (!isRecord(input)) return undefined;
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}

function optionalStringArray(input: AgentToolJsonValue, key: string): readonly string[] | undefined {
  if (!isRecord(input)) return undefined;
  const value = input[key];
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value as readonly string[]
    : undefined;
}

function optionalBoolean(input: AgentToolJsonValue, key: string): boolean | undefined {
  if (!isRecord(input)) return undefined;
  const value = input[key];
  return typeof value === 'boolean' ? value : undefined;
}

function optionalPositiveInteger(input: AgentToolJsonValue, key: string): number | undefined {
  if (!isRecord(input)) return undefined;
  const value = input[key];
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function validOptionalString(value: AgentToolJsonValue | undefined, maximum: number): boolean {
  return value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= maximum);
}

function validOptionalStringArray(value: AgentToolJsonValue | undefined): boolean {
  return value === undefined || (
    Array.isArray(value)
    && value.length <= 32
    && value.every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 256)
  );
}

function validOptionalPositiveInteger(value: AgentToolJsonValue | undefined, maximum: number): boolean {
  return value === undefined
    || (Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= maximum);
}

function workspaceSearchErrorCode(error: unknown, fallback: string): string {
  return error instanceof LocalWorkspaceSearchError ? error.code : fallback;
}
