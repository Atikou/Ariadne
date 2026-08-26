import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import type { AgentToolJsonValue } from '@ariadne/agent-core';

import type {
  TrustedAgentToolRegistrationV1
} from '../../adapters/tool/TrustedAgentToolCatalogCompiler.js';
import type {
  AgentToolContractDocumentV1,
  AgentToolExecutableImplementationV1,
  AgentToolExecutionContext
} from '../../control/ports/AgentToolExecution.js';
import type { AgentProcessSandbox } from '../../control/ports/AgentProcessSandbox.js';

export const MAX_TEXT_BYTES = 256 * 1024;
export const MAX_DIRECTORY_ENTRIES = 2_000;
export const MAX_PROCESS_OUTPUT_BYTES = 128 * 1024;
export const MAX_BROWSER_ARTIFACT_BYTES = 25 * 1024 * 1024;

export interface WorkspaceBinding {
  readonly rootPath: string;
  readonly access: 'read' | 'write';
}

export type FirstPartyProcessSandboxFactory = (
  workspaceRoot: string
) => AgentProcessSandbox;

interface RegistrationDefinition {
  readonly toolName: string;
  readonly capabilityIds: readonly string[];
  readonly requiredWorkspaceAccess: 'read' | 'write';
  readonly sideEffect: 'read' | 'write' | 'external';
  readonly approval: 'never' | 'required';
  readonly timeoutMs?: number;
  readonly resourceSemantics?: AgentToolContractDocumentV1['resourceSemantics'];
  readonly lifecycleSemantics?: AgentToolContractDocumentV1['lifecycleSemantics'];
  readonly inputSchema: AgentToolJsonValue;
  readonly outputSchema: AgentToolJsonValue;
  readonly validate: AgentToolExecutableImplementationV1['normalizeAndValidate'];
  readonly execute: AgentToolExecutableImplementationV1['execute'];
}

export function registration(
  definition: RegistrationDefinition
): TrustedAgentToolRegistrationV1 {
  const artifacts = {
    provider: artifactBytes(`${definition.toolName}:provider:v1`),
    normalizer: artifactBytes(`${definition.toolName}:normalizer:v1`),
    preparedValidator: artifactBytes(`${definition.toolName}:prepared-validator:v1`),
    execute: artifactBytes(`${definition.toolName}:execute:v1`)
  };
  const document: AgentToolContractDocumentV1 = {
    documentVersion: 1,
    toolName: definition.toolName,
    toolVersion: '1.0.0',
    providerId: 'ariadne.runtime',
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    capabilityIds: definition.capabilityIds,
    requiredWorkspaceAccess: definition.requiredWorkspaceAccess,
    permission: { authority: 'run_grant', approval: definition.approval },
    scopeSemantics: 'all_requested_workspace_scopes_must_be_granted',
    resourceSemantics: definition.resourceSemantics ?? 'workspace_relative_path',
    lifecycleSemantics: definition.lifecycleSemantics ?? 'bounded_invocation',
    sideEffect: definition.sideEffect,
    idempotency: definition.sideEffect === 'read'
      ? 'not_idempotent'
      : 'idempotency_key_required',
    recovery: definition.sideEffect === 'read'
      ? 'none'
      : 'reconcile_before_retry',
    timeoutMs: definition.timeoutMs ?? (definition.toolName.startsWith('browser.')
      ? 35_000
      : definition.toolName === 'workspace.run_command'
        ? 30_000
        : 10_000),
    implementationArtifacts: {
      providerDigest: digestArtifact(artifacts.provider),
      normalizerDigest: digestArtifact(artifacts.normalizer),
      preparedValidatorDigest: digestArtifact(artifacts.preparedValidator),
      executeDigest: digestArtifact(artifacts.execute)
    }
  };
  const validate = definition.validate;
  return {
    document,
    executable: {
      artifacts,
      normalizeAndValidate: validate,
      validatePrepared: validate,
      execute: definition.execute
    }
  };
}

export function objectSchema(
  properties: Readonly<Record<string, AgentToolJsonValue>>,
  required: readonly string[]
): AgentToolJsonValue {
  return { type: 'object', additionalProperties: false, properties, required: [...required] };
}

export function emptyObject(input: AgentToolJsonValue) {
  return isRecord(input) && Object.keys(input).length === 0
    ? { status: 'accepted' as const, input: {} }
    : { status: 'rejected' as const };
}

export function optionalStringObject(input: AgentToolJsonValue, key: string) {
  if (!isRecord(input) || hasUnknownKeys(input, [key])) {
    return { status: 'rejected' as const };
  }
  const value = input[key];
  if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
    return { status: 'rejected' as const };
  }
  return {
    status: 'accepted' as const,
    input: { ...(value === undefined ? {} : { [key]: value }) }
  };
}

export function requiredStringObject(input: AgentToolJsonValue, key: string) {
  if (!isRecord(input) || hasUnknownKeys(input, [key])) {
    return { status: 'rejected' as const };
  }
  const value = input[key];
  return typeof value === 'string' && value.length > 0
    ? { status: 'accepted' as const, input: { [key]: value } }
    : { status: 'rejected' as const };
}

export function requiredBoundedStringObject(
  input: AgentToolJsonValue,
  key: string,
  maxLength: number
) {
  const result = requiredStringObject(input, key);
  if (result.status === 'rejected') return result;
  const value = result.input[key];
  return typeof value === 'string' && value.length <= maxLength
    ? result
    : { status: 'rejected' as const };
}

export function requiredStringPairObject(
  input: AgentToolJsonValue,
  first: string,
  second: string
) {
  if (!isRecord(input) || hasUnknownKeys(input, [first, second])) {
    return { status: 'rejected' as const };
  }
  const left = input[first];
  const right = input[second];
  return typeof left === 'string' && left.length > 0 && typeof right === 'string'
    ? { status: 'accepted' as const, input: { [first]: left, [second]: right } }
    : { status: 'rejected' as const };
}

export function requireWorkspace(
  roots: ReadonlyMap<string, WorkspaceBinding>,
  context: AgentToolExecutionContext,
  access: 'read' | 'write'
): WorkspaceBinding {
  if (context.scope.length !== 1) throw new Error('workspace_scope_required');
  const workspace = roots.get(context.scope[0]!);
  if (workspace === undefined) throw new Error('workspace_scope_unknown');
  if (access === 'write' && workspace.access !== 'write') {
    throw new Error('workspace_is_read_only');
  }
  return workspace;
}

export async function resolveExistingWorkspacePath(
  rootPath: string,
  requested: string
): Promise<string> {
  const target = resolveContainedPath(rootPath, requested);
  const [rootReal, targetReal] = await Promise.all([realpath(rootPath), realpath(target)]);
  assertContained(rootReal, targetReal);
  return targetReal;
}

export async function resolveWritableWorkspacePath(
  rootPath: string,
  requested: string
): Promise<string> {
  const target = resolveContainedPath(rootPath, requested);
  let cursor = path.dirname(target);
  while (cursor !== rootPath) {
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error('workspace_symlink_rejected');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error('workspace_path_invalid');
      cursor = parent;
    }
  }
  const [rootReal, parentReal] = await Promise.all([realpath(rootPath), realpath(cursor)]);
  assertContained(rootReal, parentReal);
  return target;
}

export function succeeded(result: AgentToolJsonValue) {
  return { status: 'succeeded' as const, result };
}

export function failed(errorCode: string, error: unknown) {
  const message = error instanceof Error ? error.message : 'tool_execution_failed';
  return {
    status: 'failed' as const,
    errorCode,
    message: message.slice(0, 1_024),
    result: { error: message.slice(0, 1_024) }
  };
}

export function isRecord(
  value: unknown
): value is Record<string, AgentToolJsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasUnknownKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[]
): boolean {
  return Object.keys(value).some((key) => !allowed.includes(key));
}

export function requiredStringProperty(
  input: AgentToolJsonValue,
  key: string,
  allowEmpty = false
): string {
  if (!isRecord(input) || typeof input[key] !== 'string') {
    throw new Error('tool_input_invalid');
  }
  const value = input[key] as string;
  if (!allowEmpty && value.length === 0) throw new Error('tool_input_invalid');
  return value;
}

export function stringProperty(
  input: AgentToolJsonValue,
  key: string
): string | undefined {
  if (!isRecord(input)) throw new Error('tool_input_invalid');
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('tool_input_invalid');
  return value;
}

export function stringArrayProperty(
  input: AgentToolJsonValue,
  key: string
): string[] {
  if (!isRecord(input) || !Array.isArray(input[key])) {
    throw new Error('tool_input_invalid');
  }
  return [...input[key] as string[]];
}

export function normalizeRelativePath(value: string): string {
  return value.replaceAll('\\', '/');
}

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function resolveContainedPath(rootPath: string, requested: string): string {
  if (path.isAbsolute(requested) || requested.includes('\0')) {
    throw new Error('workspace_relative_path_required');
  }
  const target = path.resolve(rootPath, requested);
  assertContained(rootPath, target);
  return target;
}

function assertContained(rootPath: string, targetPath: string): void {
  const relative = path.relative(rootPath, targetPath);
  if (
    relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error('workspace_path_outside_root');
  }
}

function artifactBytes(value: string): Uint8Array {
  return new TextEncoder().encode(`ariadne-first-party-tool-artifact\0${value}`);
}

function digestArtifact(value: Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
