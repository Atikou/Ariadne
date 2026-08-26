import type { AgentRun } from '../../domain/agent-run.js';
import type { AgentToolInvocationDirective } from '../../domain/directive.js';
import { AgentRunInvariantError } from '../../domain/errors.js';
import {
  assertValidAgentPinnedToolIdentity,
  cloneCanonicalAgentToolInput,
  type AgentAvailableTool,
  type AgentPinnedToolIdentity,
  type AgentToolJsonValue
} from '../../domain/tool.js';
import type { AgentInferenceAttempt, AgentTurn } from '../../domain/turn.js';
import { assertCanonicalSortedPublicIds } from '../../domain/values.js';

export type AgentToolAdmissionDenialReason =
  | 'catalog_mismatch'
  | 'tool_not_available'
  | 'tool_identity_mismatch'
  | 'capability_mismatch'
  | 'scope_denied'
  | 'workspace_access_denied'
  | 'input_invalid'
  | 'policy_denied';

export interface AgentToolAdmissionRequest {
  readonly run: AgentRun;
  readonly turn: AgentTurn;
  readonly attempt: AgentInferenceAttempt;
  readonly availableTools: readonly AgentAvailableTool[];
  readonly invocation: AgentToolInvocationDirective;
}

export type AgentToolAdmissionDecision =
  | {
      readonly status: 'allow';
      readonly tool: AgentPinnedToolIdentity;
      readonly capabilityIds: readonly string[];
      readonly scope: readonly string[];
      readonly normalizedInput: AgentToolJsonValue;
    }
  | {
      readonly status: 'wait';
      readonly tool: AgentPinnedToolIdentity;
      readonly capabilityIds: readonly string[];
      readonly scope: readonly string[];
      readonly normalizedInput: AgentToolJsonValue;
    }
  | {
      readonly status: 'deny';
      readonly reason: AgentToolAdmissionDenialReason;
    };

/**
 * Pure policy boundary invoked once for every model-requested Tool call.
 * Implementations may validate contracts and workspace policy, but may not
 * execute the Tool or persist Agent state.
 */
export interface AgentToolAdmissionPolicy {
  admit(request: AgentToolAdmissionRequest): Promise<AgentToolAdmissionDecision>;
}

/**
 * A malformed policy decision is infrastructure failure, not a policy denial.
 * Callers must let this exception reach the inference dispatcher.
 */
export function assertValidAgentToolAdmissionDecision(
  decision: AgentToolAdmissionDecision,
  field = 'toolAdmissionDecision'
): void {
  if (typeof decision !== 'object' || decision === null || Array.isArray(decision)) {
    throw new AgentRunInvariantError(`${field} must be a plain data object.`);
  }
  const prototype = Object.getPrototypeOf(decision);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AgentRunInvariantError(`${field} must be a plain data object.`);
  }
  const ownKeys = Reflect.ownKeys(decision);
  if (ownKeys.some((key) => typeof key === 'symbol')) {
    throw new AgentRunInvariantError(`${field} must not contain symbol fields.`);
  }
  const statusDescriptor = Object.getOwnPropertyDescriptor(decision, 'status');
  if (
    statusDescriptor === undefined
    || !statusDescriptor.enumerable
    || !('value' in statusDescriptor)
  ) {
    throw new AgentRunInvariantError(`${field}.status must be an enumerable data field.`);
  }
  const status = statusDescriptor.value;
  if (status === 'allow' || status === 'wait') {
    assertExactEnumerableDataKeys(
      decision,
      ['status', 'tool', 'capabilityIds', 'scope', 'normalizedInput'],
      field
    );
    const toolDescriptor = Object.getOwnPropertyDescriptor(decision, 'tool');
    const capabilitiesDescriptor = Object.getOwnPropertyDescriptor(
      decision,
      'capabilityIds'
    );
    const scopeDescriptor = Object.getOwnPropertyDescriptor(decision, 'scope');
    const inputDescriptor = Object.getOwnPropertyDescriptor(decision, 'normalizedInput');
    if (
      toolDescriptor === undefined
      || !('value' in toolDescriptor)
      || capabilitiesDescriptor === undefined
      || !('value' in capabilitiesDescriptor)
      || scopeDescriptor === undefined
      || !('value' in scopeDescriptor)
      || inputDescriptor === undefined
      || !('value' in inputDescriptor)
    ) {
      throw new AgentRunInvariantError(
        `${field} admitted fields must be enumerable data fields.`
      );
    }
    assertValidAgentPinnedToolIdentity(
      toolDescriptor.value as AgentPinnedToolIdentity,
      `${field}.tool`
    );
    assertCanonicalIdArray(
      capabilitiesDescriptor.value,
      `${field}.capabilityIds`
    );
    assertCanonicalIdArray(scopeDescriptor.value, `${field}.scope`);
    cloneCanonicalAgentToolInput(inputDescriptor.value, `${field}.normalizedInput`);
    return;
  }
  if (status === 'deny') {
    assertExactEnumerableDataKeys(decision, ['status', 'reason'], field);
    const reasonDescriptor = Object.getOwnPropertyDescriptor(decision, 'reason');
    const reason = reasonDescriptor !== undefined && 'value' in reasonDescriptor
      ? reasonDescriptor.value
      : undefined;
    if (!DENIAL_REASONS.has(reason as AgentToolAdmissionDenialReason)) {
      throw new AgentRunInvariantError(`${field}.reason is invalid.`);
    }
    return;
  }
  throw new AgentRunInvariantError(`${field}.status is invalid.`);
}

function assertCanonicalIdArray(value: unknown, field: string): void {
  if (!Array.isArray(value)) {
    throw new AgentRunInvariantError(`${field} must be an array.`);
  }
  const ownKeys = Reflect.ownKeys(value);
  const expected = new Set<string>(['length']);
  for (let index = 0; index < value.length; index += 1) expected.add(String(index));
  if (
    ownKeys.length !== expected.size
    || ownKeys.some((key) => typeof key === 'symbol' || !expected.has(key))
  ) {
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
  assertCanonicalSortedPublicIds(value, field);
}

const DENIAL_REASONS = new Set<AgentToolAdmissionDenialReason>([
  'catalog_mismatch',
  'tool_not_available',
  'tool_identity_mismatch',
  'capability_mismatch',
  'scope_denied',
  'workspace_access_denied',
  'input_invalid',
  'policy_denied'
]);

function assertExactEnumerableDataKeys(
  value: object,
  keys: readonly string[],
  field: string
): void {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length) {
    throw new AgentRunInvariantError(`${field} must have its exact data fields.`);
  }
  for (const key of ownKeys) {
    if (typeof key === 'symbol' || !keys.includes(key)) {
      throw new AgentRunInvariantError(`${field} must have its exact data fields.`);
    }
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
