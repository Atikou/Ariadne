import type { AgentToolJsonValue } from '@ariadne/agent-core';

import type {
  TrustedAgentToolRegistrationV1
} from '../../adapters/tool/TrustedAgentToolCatalogCompiler.js';
import {
  failed,
  hasUnknownKeys,
  isRecord,
  objectSchema,
  registration,
  requiredStringProperty,
  requireWorkspace,
  succeeded,
  type WorkspaceBinding
} from './FirstPartyAgentToolSupport.js';

const MAX_RESULT_READ_BYTES = 64 * 1024;
const DEFAULT_RESULT_READ_BYTES = 16 * 1024;

export function createProtectedResultAgentToolRegistrations(
  roots: ReadonlyMap<string, WorkspaceBinding>
): readonly TrustedAgentToolRegistrationV1[] {
  return [registration({
    implementationModuleUrl: import.meta.url,
    toolName: 'workspace.effect_result_read',
    model: {
      description: 'Read another bounded UTF-8 segment of a protected Tool result owned by the current Run.',
      guidance: ['Use the exact effectId and nextCursor from semantic compaction or a previous segment.']
    },
    presentation: { kind: 'generic', label: '读取受保护工具结果', resultVisibility: 'protected' },
    capabilityIds: ['workspace.read'],
    requiredWorkspaceAccess: 'read',
    sideEffect: 'read',
    approval: 'never',
    resourceSemantics: 'workspace_resource_id',
    lifecycleSemantics: 'resource_observe',
    inputSchema: objectSchema({
      effectId: {
        type: 'string',
        description: 'Effect id from an ariadne.tool-result-spill.v1 locator.'
      },
      cursor: {
        type: 'integer',
        minimum: 0,
        description: 'UTF-8 byte cursor. Defaults to zero.'
      },
      maxBytes: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_RESULT_READ_BYTES,
        description: 'Maximum returned bytes.'
      }
    }, ['effectId']),
    outputSchema: { type: 'object' },
    validate: validateEffectResultRead,
    execute: async (input, context) => {
      try {
        requireWorkspace(roots, context, 'read');
        context.signal.throwIfAborted();
        const reader = context.protectedEffectResults;
        if (reader === undefined) throw new Error('protected_effect_result_reader_unavailable');
        const result = await reader.read({
          runId: context.runId,
          workspaceId: context.scope[0]!,
          effectId: requiredStringProperty(input, 'effectId'),
          cursor: integerProperty(input, 'cursor') ?? 0,
          maxBytes: integerProperty(input, 'maxBytes') ?? DEFAULT_RESULT_READ_BYTES
        });
        context.signal.throwIfAborted();
        return succeeded({ ...result });
      } catch (error) {
        return failed('workspace_effect_result_read_failed', error);
      }
    }
  })];
}

function validateEffectResultRead(input: AgentToolJsonValue) {
  if (!isRecord(input) || hasUnknownKeys(input, ['effectId', 'cursor', 'maxBytes'])) {
    return { status: 'rejected' as const };
  }
  if (
    typeof input.effectId !== 'string'
    || input.effectId.length === 0
    || !optionalInteger(input.cursor, 0, Number.MAX_SAFE_INTEGER)
    || !optionalInteger(input.maxBytes, 1, MAX_RESULT_READ_BYTES)
  ) return { status: 'rejected' as const };
  return { status: 'accepted' as const, input };
}

function optionalInteger(
  value: AgentToolJsonValue | undefined,
  minimum: number,
  maximum: number
): boolean {
  return value === undefined
    || (typeof value === 'number'
      && Number.isSafeInteger(value)
      && value >= minimum
      && value <= maximum);
}

function integerProperty(input: AgentToolJsonValue, key: string): number | undefined {
  if (!isRecord(input)) throw new Error('tool_input_invalid');
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number') throw new Error('tool_input_invalid');
  return value;
}
