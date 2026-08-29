import { AgentRunInvariantError } from '../domain/errors.js';
import { assertValidAgentAvailableTool } from '../domain/tool.js';
import { assertCanonicalPublicId } from '../domain/values.js';
import type { AgentTurnInput, AgentTurnInputModelData } from './agent-engine.js';

/** Protected history may exceed one Provider request; v3 compacts it first. */
const MAX_MESSAGES = 2_047;
const MAX_TOOLS = 1_000;
/**
 * Bounded canonical JSON leaves room for snapshot metadata, the Engine's
 * protocol prompt, and worst-case JSON transport escaping under the 4 MiB
 * exact-gateway request limit.
 */
const MAX_CANONICAL_INPUT_UTF8_BYTES = 192 * 1_024;

export interface AgentTurnInputDigester {
  digest(input: AgentTurnInputModelData): Promise<string>;
}

export const sha256AgentTurnInputDigester: AgentTurnInputDigester = {
  async digest(input) {
    const canonical = canonicalizeAgentTurnInput(input);
    const subtle = globalThis.crypto?.subtle;
    if (subtle === undefined) {
      throw new AgentRunInvariantError(
        'SHA-256 Turn input identity requires the standard Web Crypto API.'
      );
    }
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(canonical));
    return `sha256:${[...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')}`;
  }
};

export function digestAgentTurnInput(input: AgentTurnInputModelData): Promise<string> {
  return sha256AgentTurnInputDigester.digest(input);
}

export function canonicalizeAgentTurnInput(input: AgentTurnInputModelData): string {
  assertBoundedAgentTurnInput(input);
  return canonicalize(input);
}

export function summarizeAgentTurnInput(
  input: AgentTurnInputModelData
): {
  readonly messageCount: number;
  readonly toolCount: number;
  readonly contentCharacterCount: number;
} {
  assertBoundedAgentTurnInput(input);
  return {
    messageCount: input.messages.length,
    toolCount: input.availableTools.length,
    contentCharacterCount: input.messages.reduce(
      (sum, message) => sum + (message.kind === 'text'
        ? message.content.length
        : message.kind === 'image'
          ? message.attachment.attachmentId.length
            + (message.attachment.name?.length ?? 0)
          : message.effectId.length
            + message.toolCallId.length
            + message.status.length
            + canonicalize(message.result).length),
      0
    )
  };
}

export function modelDataFromAgentTurnInput(
  input: AgentTurnInput
): AgentTurnInputModelData {
  return {
    messages: input.messages,
    availableTools: input.availableTools
  };
}

function assertBoundedAgentTurnInput(input: AgentTurnInputModelData): void {
  assertPlainExactObject(input, ['messages', 'availableTools'], 'turnInput');
  if (
    !Array.isArray(input.messages)
    || input.messages.length > MAX_MESSAGES
    || !Array.isArray(input.availableTools)
    || input.availableTools.length > MAX_TOOLS
  ) {
    throw new AgentRunInvariantError('Agent Turn input exceeds its collection bounds.');
  }
  const effectIds = new Set<string>();
  const toolCallIds = new Set<string>();
  assertDenseArray(input.messages, 'turnInput.messages');
  for (const [index, rawMessage] of input.messages.entries()) {
    const path = `turnInput.messages[${String(index)}]`;
    const message = inspectDataMessage(rawMessage, path);
    if (message.kind === 'text') {
      assertPlainExactObject(message, ['kind', 'role', 'content'], path);
      if (
        message.role !== 'system'
        && message.role !== 'user'
        && message.role !== 'assistant'
      ) {
        throw new AgentRunInvariantError(
          'Agent Turn text input contains an invalid message role.'
        );
      }
      if (typeof message.content !== 'string') {
        throw new AgentRunInvariantError('Agent Turn message content must be a string.');
      }
      continue;
    }
    if (message.kind === 'image') {
      assertPlainExactObject(message, ['kind', 'role', 'owner', 'attachment'], path);
      if (message.role !== 'user') {
        throw new AgentRunInvariantError('Agent Turn image input must have user role.');
      }
      assertImageOwner(message.owner, `${path}.owner`);
      assertImageAttachment(message.attachment, `${path}.attachment`);
      continue;
    }
    if (message.kind !== 'effect_result') {
      throw new AgentRunInvariantError('Agent Turn input contains an invalid message kind.');
    }
    assertPlainExactObject(
      message,
      ['kind', 'effectId', 'toolCallId', 'status', 'result'],
      path
    );
    if (
      (
        message.status !== 'succeeded'
        && message.status !== 'failed'
        && message.status !== 'cancelled'
      )
    ) {
      throw new AgentRunInvariantError('Agent Turn Effect result identity is invalid.');
    }
    assertCanonicalPublicId(message.effectId, `${path}.effectId`);
    assertCanonicalPublicId(message.toolCallId, `${path}.toolCallId`);
    if (effectIds.has(message.effectId) || toolCallIds.has(message.toolCallId)) {
      throw new AgentRunInvariantError(
        'Agent Turn Effect results must have unique Effect and Tool-call identities.'
      );
    }
    effectIds.add(message.effectId);
    toolCallIds.add(message.toolCallId);
    assertDataOnlyJson(message.result, `${path}.result`, new Set<object>(), 0);
  }
  assertDenseArray(input.availableTools, 'turnInput.availableTools');
  const toolNames = new Set<string>();
  for (const [index, tool] of input.availableTools.entries()) {
    assertPlainExactObject(
      tool,
      ['tool', 'capabilityIds'],
      `turnInput.availableTools[${String(index)}]`
    );
    const candidate = tool as unknown as AgentTurnInputModelData['availableTools'][number];
    assertValidAgentAvailableTool(
      candidate,
      `turnInput.availableTools[${String(index)}]`
    );
    if (toolNames.has(candidate.tool.toolName)) {
      throw new AgentRunInvariantError(
        'Agent Turn tool names must be unique in the exact catalog snapshot.'
      );
    }
    toolNames.add(candidate.tool.toolName);
  }
  if (utf8Length(canonicalize(input)) > MAX_CANONICAL_INPUT_UTF8_BYTES) {
    throw new AgentRunInvariantError(
      'Agent Turn input exceeds its canonical UTF-8 byte-size bound.'
    );
  }
}

function assertImageOwner(
  owner: Extract<AgentTurnInputModelData['messages'][number], { readonly kind: 'image' }>['owner'],
  path: string
): void {
  assertPlainExactObject(owner, [
    'sessionId', 'workspaceId', 'messageId', 'messageVersion'
  ], path);
  assertCanonicalPublicId(owner.sessionId, `${path}.sessionId`);
  assertCanonicalPublicId(owner.workspaceId, `${path}.workspaceId`);
  assertCanonicalPublicId(owner.messageId, `${path}.messageId`);
  if (!Number.isSafeInteger(owner.messageVersion) || owner.messageVersion < 1) {
    throw new AgentRunInvariantError(`${path}.messageVersion is invalid.`);
  }
}

function assertImageAttachment(
  attachment: Extract<AgentTurnInputModelData['messages'][number], { readonly kind: 'image' }>['attachment'],
  path: string
): void {
  assertPlainExactObject(attachment, [
    'attachmentId', 'mediaType', 'bytes', 'width', 'height',
    ...(attachment.name === undefined ? [] : ['name']),
    ...(attachment.originalDimensions === undefined ? [] : ['originalDimensions'])
  ], path);
  if (!/^sha256:[a-f0-9]{64}$/u.test(attachment.attachmentId)) {
    throw new AgentRunInvariantError(`${path}.attachmentId is invalid.`);
  }
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(attachment.mediaType)) {
    throw new AgentRunInvariantError(`${path}.mediaType is invalid.`);
  }
  if (!Number.isSafeInteger(attachment.bytes) || attachment.bytes < 1 || attachment.bytes > 2 * 1024 * 1024) {
    throw new AgentRunInvariantError(`${path}.bytes is invalid.`);
  }
  assertDimensions(attachment.width, attachment.height, path);
  if (attachment.name !== undefined && (
    attachment.name.trim().length === 0 || attachment.name.length > 256
  )) throw new AgentRunInvariantError(`${path}.name is invalid.`);
  if (attachment.originalDimensions !== undefined) {
    assertPlainExactObject(
      attachment.originalDimensions,
      ['width', 'height'],
      `${path}.originalDimensions`
    );
    assertDimensions(
      attachment.originalDimensions.width,
      attachment.originalDimensions.height,
      `${path}.originalDimensions`
    );
  }
}

function assertDimensions(width: number, height: number, path: string): void {
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width < 1
    || height < 1
    || width > 8_192
    || height > 8_192
    || width * height > 64_000_000
  ) throw new AgentRunInvariantError(`${path} dimensions are invalid.`);
}

function inspectDataMessage(
  value: AgentTurnInputModelData['messages'][number],
  path: string
): AgentTurnInputModelData['messages'][number] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AgentRunInvariantError(`${path} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AgentRunInvariantError(`${path} must be a plain object.`);
  }
  const kind = Object.getOwnPropertyDescriptor(value, 'kind');
  if (kind === undefined || !kind.enumerable || !('value' in kind)) {
    throw new AgentRunInvariantError(`${path}.kind must be an enumerable data field.`);
  }
  return value;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertDataOnlyJson(
  value: unknown,
  path: string,
  ancestors: Set<object>,
  depth: number
): void {
  if (depth > 64) {
    throw new AgentRunInvariantError(`${path} exceeds the maximum JSON depth.`);
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw new AgentRunInvariantError(`${path} must contain finite JSON numbers.`);
  }
  if (typeof value !== 'object' || value === undefined || ancestors.has(value)) {
    throw new AgentRunInvariantError(`${path} must be an acyclic data-only JSON value.`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      assertDenseArray(value, path);
      value.forEach((entry, index) => {
        assertDataOnlyJson(entry, `${path}[${String(index)}]`, ancestors, depth + 1);
      });
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new AgentRunInvariantError(`${path} must be a plain JSON object.`);
    }
    const record = value as Record<string, unknown>;
    for (const key of Reflect.ownKeys(record)) {
      if (typeof key !== 'string') {
        throw new AgentRunInvariantError(`${path} must not contain symbol fields.`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new AgentRunInvariantError(`${path}.${key} must be an enumerable data field.`);
      }
      assertDataOnlyJson(record[key], `${path}.${key}`, ancestors, depth + 1);
    }
  } finally {
    ancestors.delete(value);
  }
}

function assertPlainExactObject(
  value: unknown,
  keys: readonly string[],
  path: string
): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AgentRunInvariantError(`${path} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AgentRunInvariantError(`${path} must be a plain object.`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === 'symbol')) {
    throw new AgentRunInvariantError(`${path} must not contain symbol fields.`);
  }
  const actual = ownKeys as string[];
  const allowed = new Set(keys);
  const unexpected = actual.find((key) => !allowed.has(key));
  const missing = keys.find((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (unexpected !== undefined || missing !== undefined) {
    throw new AgentRunInvariantError(`${path} must have its exact bounded fields.`);
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !('value' in descriptor)
    ) {
      throw new AgentRunInvariantError(`${path}.${key} must be an enumerable data field.`);
    }
  }
}

function assertDenseArray(value: readonly unknown[], path: string): void {
  const ownKeys = Reflect.ownKeys(value);
  const expected = new Set<string>(['length']);
  for (let index = 0; index < value.length; index += 1) expected.add(String(index));
  if (
    ownKeys.length !== expected.size
    || ownKeys.some((key) => typeof key === 'symbol' || !expected.has(key))
  ) {
    throw new AgentRunInvariantError(`${path} must be a dense data-only array.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !('value' in descriptor)
    ) {
      throw new AgentRunInvariantError(`${path} must be a dense data-only array.`);
    }
  }
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalize(record[key])}`
  ).join(',')}}`;
}
