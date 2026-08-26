import { AgentRunInvariantError } from './errors.js';
import {
  assertCanonicalPublicId,
  assertCanonicalSortedPublicIds,
  assertPositiveInteger,
  assertSha256Digest
} from './values.js';

const MAX_TOOL_INPUT_DEPTH = 32;
const MAX_TOOL_INPUT_NODES = 100_000;
const MAX_TOOL_INPUT_STRING_CHARACTERS = 1_048_576;

export type AgentToolJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly AgentToolJsonValue[]
  | { readonly [key: string]: AgentToolJsonValue };

/**
 * Immutable identity of one Tool contract inside the exact catalog snapshot
 * bound to an Agent Run. No adapter may resolve this identity by name again.
 */
export interface AgentPinnedToolIdentity {
  readonly catalogId: string;
  readonly revision: number;
  readonly digest: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly providerId: string;
  readonly contractDigest: string;
}

export interface AgentAvailableTool {
  readonly tool: AgentPinnedToolIdentity;
  readonly capabilityIds: readonly string[];
}

export function assertValidAgentPinnedToolIdentity(
  tool: AgentPinnedToolIdentity,
  field = 'tool'
): void {
  assertPlainDataObjectWithExactKeys(
    tool,
    [
      'catalogId',
      'revision',
      'digest',
      'toolName',
      'toolVersion',
      'providerId',
      'contractDigest'
    ],
    field
  );
  assertCanonicalPublicId(tool.catalogId, `${field}.catalogId`);
  assertPositiveInteger(tool.revision, `${field}.revision`);
  assertSha256Digest(tool.digest, `${field}.digest`);
  assertCanonicalPublicId(tool.toolName, `${field}.toolName`);
  assertCanonicalPublicId(tool.toolVersion, `${field}.toolVersion`);
  assertCanonicalPublicId(tool.providerId, `${field}.providerId`);
  assertSha256Digest(tool.contractDigest, `${field}.contractDigest`);
}

export function assertValidAgentAvailableTool(
  availableTool: AgentAvailableTool,
  field = 'availableTool'
): void {
  assertPlainDataObjectWithExactKeys(
    availableTool,
    ['tool', 'capabilityIds'],
    field
  );
  assertValidAgentPinnedToolIdentity(availableTool.tool, `${field}.tool`);
  if (!Array.isArray(availableTool.capabilityIds)) {
    throw new AgentRunInvariantError(`${field}.capabilityIds must be an array.`);
  }
  assertDenseDataArray(availableTool.capabilityIds, `${field}.capabilityIds`);
  assertCanonicalSortedPublicIds(
    availableTool.capabilityIds,
    `${field}.capabilityIds`
  );
}

export function cloneAgentPinnedToolIdentity(
  tool: AgentPinnedToolIdentity,
  field = 'tool'
): AgentPinnedToolIdentity {
  assertValidAgentPinnedToolIdentity(tool, field);
  return {
    catalogId: tool.catalogId,
    revision: tool.revision,
    digest: tool.digest,
    toolName: tool.toolName,
    toolVersion: tool.toolVersion,
    providerId: tool.providerId,
    contractDigest: tool.contractDigest
  };
}

export function cloneAgentAvailableTool(
  availableTool: AgentAvailableTool,
  field = 'availableTool'
): AgentAvailableTool {
  assertValidAgentAvailableTool(availableTool, field);
  return {
    tool: cloneAgentPinnedToolIdentity(availableTool.tool, `${field}.tool`),
    capabilityIds: [...availableTool.capabilityIds]
  };
}

export function sameAgentPinnedToolIdentity(
  left: AgentPinnedToolIdentity,
  right: AgentPinnedToolIdentity
): boolean {
  return left.catalogId === right.catalogId
    && left.revision === right.revision
    && left.digest === right.digest
    && left.toolName === right.toolName
    && left.toolVersion === right.toolVersion
    && left.providerId === right.providerId
    && left.contractDigest === right.contractDigest;
}

export function isToolIdentityInCatalog(
  tool: AgentPinnedToolIdentity,
  catalog: {
    readonly catalogId: string;
    readonly revision: number;
    readonly digest: string;
  }
): boolean {
  return tool.catalogId === catalog.catalogId
    && tool.revision === catalog.revision
    && tool.digest === catalog.digest;
}

/**
 * Validates and owns a canonical JSON clone without invoking accessors or
 * applying JSON.stringify coercions. Objects are cloned with sorted keys,
 * arrays must be dense and data-only, -0 is normalized to 0, and values with
 * prototypes, symbols, accessors, hidden fields, cycles, or non-finite numbers
 * are rejected.
 */
export function cloneCanonicalAgentToolInput(
  value: unknown,
  field = 'toolInput'
): AgentToolJsonValue {
  const state = { nodes: 0, stringCharacters: 0 };
  return cloneJsonValue(value, field, 0, state, new Set<object>());
}

function cloneJsonValue(
  value: unknown,
  path: string,
  depth: number,
  state: { nodes: number; stringCharacters: number },
  ancestors: Set<object>
): AgentToolJsonValue {
  state.nodes += 1;
  if (state.nodes > MAX_TOOL_INPUT_NODES || depth > MAX_TOOL_INPUT_DEPTH) {
    throw new AgentRunInvariantError(`${path} exceeds the bounded JSON shape.`);
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    addStringCharacters(state, value.length, path);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new AgentRunInvariantError(`${path} contains a non-finite number.`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') {
    throw new AgentRunInvariantError(`${path} must contain only plain JSON data.`);
  }
  if (ancestors.has(value)) {
    throw new AgentRunInvariantError(`${path} must not contain a cyclic reference.`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      assertDenseDataArray(value, path);
      if (value.length > MAX_TOOL_INPUT_NODES) {
        throw new AgentRunInvariantError(`${path} exceeds the bounded JSON array size.`);
      }
      const clone: AgentToolJsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !('value' in descriptor)) {
          throw new AgentRunInvariantError(`${path} must be a dense data-only array.`);
        }
        clone.push(cloneJsonValue(
          descriptor.value,
          `${path}[${String(index)}]`,
          depth + 1,
          state,
          ancestors
        ));
      }
      return clone;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new AgentRunInvariantError(`${path} must contain only plain JSON data.`);
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key === 'symbol')) {
      throw new AgentRunInvariantError(`${path} must not contain symbol fields.`);
    }
    const keys = (ownKeys as string[]).sort();
    const clone: Record<string, AgentToolJsonValue> = Object.create(null) as Record<
      string,
      AgentToolJsonValue
    >;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined
        || !descriptor.enumerable
        || !('value' in descriptor)
      ) {
        throw new AgentRunInvariantError(`${path}.${key} must be an enumerable data field.`);
      }
      addStringCharacters(state, key.length, path);
      clone[key] = cloneJsonValue(
        descriptor.value,
        `${path}.${key}`,
        depth + 1,
        state,
        ancestors
      );
    }
    return clone;
  } finally {
    ancestors.delete(value);
  }
}

function addStringCharacters(
  state: { stringCharacters: number },
  count: number,
  path: string
): void {
  state.stringCharacters += count;
  if (state.stringCharacters > MAX_TOOL_INPUT_STRING_CHARACTERS) {
    throw new AgentRunInvariantError(`${path} exceeds the bounded JSON string size.`);
  }
}

function assertPlainDataObjectWithExactKeys(
  value: unknown,
  keys: readonly string[],
  field: string
): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AgentRunInvariantError(`${field} must be a plain data object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AgentRunInvariantError(`${field} must be a plain data object.`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === 'symbol')) {
    throw new AgentRunInvariantError(`${field} must not contain symbol fields.`);
  }
  const actual = ownKeys as string[];
  const allowed = new Set(keys);
  const unexpected = actual.find((key) => !allowed.has(key));
  const missing = keys.find((key) => !actual.includes(key));
  if (unexpected !== undefined) {
    throw new AgentRunInvariantError(
      `${field} contains unsupported field "${unexpected}".`
    );
  }
  if (missing !== undefined) {
    throw new AgentRunInvariantError(`${field} is missing required field "${missing}".`);
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !('value' in descriptor)
    ) {
      throw new AgentRunInvariantError(`${field}.${key} must be an enumerable data field.`);
    }
  }
}

function assertDenseDataArray(value: readonly unknown[], field: string): void {
  const ownKeys = Reflect.ownKeys(value);
  const expected = new Set<string>(['length']);
  for (let index = 0; index < value.length; index += 1) {
    expected.add(String(index));
  }
  for (const key of ownKeys) {
    if (typeof key === 'symbol' || !expected.has(key)) {
      throw new AgentRunInvariantError(`${field} must be a dense data-only array.`);
    }
  }
  if (ownKeys.length !== expected.size) {
    throw new AgentRunInvariantError(`${field} must be a dense data-only array.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !('value' in descriptor)
    ) {
      throw new AgentRunInvariantError(`${field} must be a dense data-only array.`);
    }
  }
}
