import type { AgentToolJsonValue } from '@ariadne/agent-core';

import type { TrustedAgentToolRegistrationV1 } from '../../adapters/tool/TrustedAgentToolCatalogCompiler.js';
import {
  failed,
  hasUnknownKeys,
  isRecord,
  objectSchema,
  registration,
  requiredStringProperty,
  succeeded,
  type WorkspaceBinding
} from '../first-party-tools/FirstPartyAgentToolSupport.js';
import {
  publicSkillDescriptor,
  validateSkillResourcePath
} from './ProductionSkillCatalogSupport.js';
import type {
  ProductionSkillDefinition,
  ProductionSkillResource
} from './ProductionSkillContracts.js';

interface ProductionSkillToolInput {
  readonly workspaces: ReadonlyMap<string, WorkspaceBinding>;
  readonly load: (
    workspaceId: string,
    name: string,
    revision: string,
    signal: AbortSignal
  ) => Promise<ProductionSkillDefinition>;
  readonly readResource: (
    workspaceId: string,
    name: string,
    revision: string,
    relativePath: string,
    signal: AbortSignal
  ) => Promise<ProductionSkillResource>;
}

export function createProductionSkillToolRegistrations(
  input: ProductionSkillToolInput
): readonly TrustedAgentToolRegistrationV1[] {
  return Object.freeze([
    createSkillLoadTool(input),
    createSkillResourceReadTool(input)
  ]);
}

function createSkillLoadTool(input: ProductionSkillToolInput): TrustedAgentToolRegistrationV1 {
  return registration({
    implementationModuleUrl: import.meta.url,
    toolName: 'skill.load',
    model: {
      description: 'Load the exact SKILL.md body and resource descriptors pinned during this Run admission.',
      guidance: ['Use only a model-invocable Skill name and revision from the admission catalog.']
    },
    presentation: { kind: 'skill', label: '加载技能说明', resultVisibility: 'protected' },
    capabilityIds: ['skills.read'],
    requiredWorkspaceAccess: 'read',
    sideEffect: 'read',
    approval: 'never',
    resourceSemantics: 'workspace_resource_id',
    inputSchema: objectSchema({
      name: { type: 'string', description: 'Exact model-invocable Skill name from the admission catalog.' },
      revision: { type: 'string', description: 'Exact package revision from the admission catalog.' }
    }, ['name', 'revision']),
    outputSchema: { type: 'object' },
    validate: validateLoadInput,
    execute: async (toolInput, context) => {
      try {
        context.signal.throwIfAborted();
        const workspaceId = requireWorkspaceScope(input.workspaces, context.scope);
        const definition = await input.load(
          workspaceId,
          requiredStringProperty(toolInput, 'name'),
          requiredStringProperty(toolInput, 'revision'),
          context.signal
        );
        context.signal.throwIfAborted();
        const descriptor = publicSkillDescriptor(definition);
        return succeeded({
          name: descriptor.name,
          description: descriptor.description,
          revision: descriptor.revision,
          layer: descriptor.layer,
          invocation: {
            modelInvocable: descriptor.invocation.modelInvocable,
            userInvocable: descriptor.invocation.userInvocable
          },
          body: definition.body,
          resources: definition.resources.map((resource): AgentToolJsonValue => ({
            relativePath: resource.relativePath,
            mediaType: resource.mediaType,
            byteLength: resource.byteLength,
            revision: resource.revision
          }))
        });
      } catch (error) {
        if (context.signal.aborted) context.signal.throwIfAborted();
        return failed('skill_load_failed', error);
      }
    }
  });
}

function createSkillResourceReadTool(
  input: ProductionSkillToolInput
): TrustedAgentToolRegistrationV1 {
  return registration({
    implementationModuleUrl: import.meta.url,
    toolName: 'skill.resource.read',
    model: {
      description: 'Read one bounded resource from an exact Skill package revision pinned during admission.',
      guidance: ['Read only a relative resource path returned by skill.load; scripts remain data and are not executed.']
    },
    presentation: { kind: 'skill', label: '读取技能资源', resultVisibility: 'protected' },
    capabilityIds: ['skills.read'],
    requiredWorkspaceAccess: 'read',
    sideEffect: 'read',
    approval: 'never',
    resourceSemantics: 'workspace_resource_id',
    inputSchema: objectSchema({
      name: { type: 'string', description: 'Exact model-invocable Skill name from the admission catalog.' },
      revision: { type: 'string', description: 'Exact package revision from the admission catalog.' },
      relativePath: {
        type: 'string',
        description: 'Exact POSIX-style relative resource path returned by skill.load.'
      }
    }, ['name', 'revision', 'relativePath']),
    outputSchema: { type: 'object' },
    validate: validateResourceInput,
    execute: async (toolInput, context) => {
      try {
        context.signal.throwIfAborted();
        const workspaceId = requireWorkspaceScope(input.workspaces, context.scope);
        const resource = await input.readResource(
          workspaceId,
          requiredStringProperty(toolInput, 'name'),
          requiredStringProperty(toolInput, 'revision'),
          requiredStringProperty(toolInput, 'relativePath'),
          context.signal
        );
        context.signal.throwIfAborted();
        const text = decodeTextResource(resource);
        return succeeded({
          relativePath: resource.relativePath,
          mediaType: resource.mediaType,
          byteLength: resource.byteLength,
          revision: resource.revision,
          encoding: text === undefined ? 'base64' : 'utf8',
          content: text ?? Buffer.from(resource.bytes).toString('base64')
        });
      } catch (error) {
        if (context.signal.aborted) context.signal.throwIfAborted();
        return failed('skill_resource_read_failed', error);
      }
    }
  });
}

function validateLoadInput(input: AgentToolJsonValue) {
  if (!isRecord(input) || hasUnknownKeys(input, ['name', 'revision'])) {
    return { status: 'rejected' as const };
  }
  const { name, revision } = input;
  if (
    typeof name !== 'string'
    || !/^[a-z][a-z0-9_-]*$/u.test(name)
    || typeof revision !== 'string'
    || !/^sha256:[a-f0-9]{64}$/u.test(revision)
  ) return { status: 'rejected' as const };
  return { status: 'accepted' as const, input: { name, revision } };
}

function validateResourceInput(input: AgentToolJsonValue) {
  if (!isRecord(input) || hasUnknownKeys(input, ['name', 'revision', 'relativePath'])) {
    return { status: 'rejected' as const };
  }
  const { name, revision, relativePath } = input;
  if (
    typeof name !== 'string'
    || !/^[a-z][a-z0-9_-]*$/u.test(name)
    || typeof revision !== 'string'
    || !/^sha256:[a-f0-9]{64}$/u.test(revision)
    || typeof relativePath !== 'string'
  ) {
    return { status: 'rejected' as const };
  }
  try {
    validateSkillResourcePath(relativePath);
  } catch {
    return { status: 'rejected' as const };
  }
  return {
    status: 'accepted' as const,
    input: { name, revision, relativePath }
  };
}

function requireWorkspaceScope(
  workspaces: ReadonlyMap<string, WorkspaceBinding>,
  scope: readonly string[]
): string {
  if (scope.length !== 1 || !workspaces.has(scope[0]!)) {
    throw new Error('skill_workspace_scope_invalid');
  }
  return scope[0]!;
}

function decodeTextResource(resource: ProductionSkillResource): string | undefined {
  if (!isTextMediaType(resource.mediaType)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(resource.bytes);
  } catch {
    throw new Error('skill_resource_invalid_utf8');
  }
}

function isTextMediaType(mediaType: string): boolean {
  return mediaType.startsWith('text/')
    || mediaType === 'application/json'
    || mediaType === 'application/yaml'
    || mediaType === 'image/svg+xml';
}
