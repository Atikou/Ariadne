import type { PlanDecisionDraft } from './decision.js';
import { AgentRunInvariantError } from './errors.js';
import {
  type AgentPinnedToolIdentity,
  type AgentToolJsonValue,
  assertValidAgentPinnedToolIdentity,
  cloneCanonicalAgentToolInput
} from './tool.js';
import {
  assertBoundedNonEmpty,
  assertCanonicalPublicId,
  assertCanonicalSortedPublicIds,
  assertPositiveInteger,
  assertSha256Digest,
  assertTimestamp
} from './values.js';

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_DIRECTIVE_CONTENT_LENGTH = 1_048_576;
const MAX_DIRECTIVE_COLLECTION_LENGTH = 256;

export type AgentDirectiveJsonValue = AgentToolJsonValue;

export interface AgentToolInvocationDirective {
  readonly toolCallId: string;
  readonly tool: AgentPinnedToolIdentity;
  readonly input: AgentDirectiveJsonValue;
  readonly capabilityIds: readonly string[];
  readonly scope: readonly string[];
}

export interface AgentSubagentDirective {
  readonly description: string;
  readonly prompt: string;
}

export type AgentPlanStepImpact =
  | 'read_only'
  | 'workspace_change'
  | 'command_execution'
  | 'network_access'
  | 'external_side_effect'
  | 'mixed';

export interface AgentPlanProposal {
  readonly summary: string;
  readonly impactSummary: string;
  readonly steps: readonly {
    readonly title: string;
    readonly summary: string;
    readonly impact: AgentPlanStepImpact;
  }[];
}

export type AgentDirective =
  | {
      readonly kind: 'respond';
      readonly content: string;
    }
  | {
      readonly kind: 'invoke_tools';
      readonly invocations: readonly AgentToolInvocationDirective[];
    }
  | {
      readonly kind: 'propose_plan';
      /** Engine supplies bounded content; Core owns every durable identity. */
      readonly plan: AgentPlanProposal;
    }
  | {
      readonly kind: 'delegate_subagent';
      readonly subagent: AgentSubagentDirective;
    }
  | {
      readonly kind: 'checkpoint';
      readonly reason: string;
    }
  | {
      readonly kind: 'complete';
      readonly outputRef?: string;
    }
  | {
      readonly kind: 'fail';
      readonly errorCode: string;
      readonly message: string;
    };

/**
 * Durable/public representation of a tool invocation. Raw tool input is
 * deliberately replaced by its recovery-payload digest before persistence.
 */
export interface AgentCommittedToolInvocation {
  readonly effectId: string;
  readonly toolCallId: string;
  readonly tool: AgentPinnedToolIdentity;
  readonly idempotencyKey: string;
  readonly capabilityIds: readonly string[];
  readonly scope: readonly string[];
  readonly inputDigest: string;
  readonly permissionDecisionId?: string;
}

/** A Directive safe to persist in an Attempt and publish in outbox events. */
export type AgentCommittedDirective =
  | {
      readonly kind: 'respond';
      readonly contentRef: string;
      readonly contentDigest: string;
    }
  | {
      readonly kind: 'invoke_tools';
      readonly invocations: readonly AgentCommittedToolInvocation[];
    }
  | {
      readonly kind: 'request_decision';
      readonly decision: PlanDecisionDraft;
    }
  | {
      readonly kind: 'delegate_subagent';
      readonly delegationId: string;
      readonly childRunId: string;
      readonly objectiveDigest: string;
    }
  | {
      readonly kind: 'checkpoint';
      readonly reasonRef: string;
      readonly reasonDigest: string;
    }
  | {
      readonly kind: 'complete';
      readonly outputRef?: string;
      readonly outputDigest?: string;
    }
  | {
      readonly kind: 'fail';
      readonly errorCode: string;
      readonly messageRef: string;
      readonly messageDigest: string;
    };

export function assertValidAgentDirective(directive: AgentDirective): void {
  if (!isPlainObject(directive)) {
    throw new AgentRunInvariantError('directive must be a plain object.');
  }
  switch (directive.kind) {
    case 'respond':
      assertExactObjectKeys(directive, ['kind', 'content'], 'directive');
      assertBoundedNonEmpty(
        directive.content,
        'directive.content',
        MAX_DIRECTIVE_CONTENT_LENGTH
      );
      return;
    case 'invoke_tools':
      assertExactObjectKeys(directive, ['kind', 'invocations'], 'directive');
      if (
        !Array.isArray(directive.invocations)
        || directive.invocations.length === 0
        || directive.invocations.length > MAX_DIRECTIVE_COLLECTION_LENGTH
      ) {
        throw new AgentRunInvariantError('directive.invocations has an invalid size.');
      }
      assertDenseDataArray(directive.invocations, 'directive.invocations');
      directive.invocations.forEach((invocation, index) => {
        if (!isPlainObject(invocation)) {
          throw new AgentRunInvariantError(
            `directive.invocations[${String(index)}] must be a plain object.`
          );
        }
        assertExactObjectKeys(
          invocation,
          ['toolCallId', 'tool', 'input', 'capabilityIds', 'scope'],
          `directive.invocations[${String(index)}]`
        );
        const candidate = invocation as unknown as Extract<
          AgentDirective,
          { readonly kind: 'invoke_tools' }
        >['invocations'][number];
        assertCanonicalPublicId(
          candidate.toolCallId,
          `directive.invocations[${String(index)}].toolCallId`
        );
        assertValidAgentPinnedToolIdentity(
          candidate.tool,
          `directive.invocations[${String(index)}].tool`
        );
        if (!Array.isArray(candidate.capabilityIds) || !Array.isArray(candidate.scope)) {
          throw new AgentRunInvariantError(
            `directive.invocations[${String(index)}] capabilityIds and scope must be arrays.`
          );
        }
        assertDenseDataArray(
          candidate.capabilityIds,
          `directive.invocations[${String(index)}].capabilityIds`
        );
        assertDenseDataArray(
          candidate.scope,
          `directive.invocations[${String(index)}].scope`
        );
        assertCanonicalSortedPublicIds(
          candidate.capabilityIds,
          `directive.invocations[${String(index)}].capabilityIds`
        );
        assertCanonicalSortedPublicIds(
          candidate.scope,
          `directive.invocations[${String(index)}].scope`
        );
        cloneCanonicalAgentToolInput(
          candidate.input,
          `directive.invocations[${String(index)}].input`
        );
      });
      return;
    case 'propose_plan':
      assertExactObjectKeys(directive, ['kind', 'plan'], 'directive');
      assertPlanProposal(directive.plan);
      return;
    case 'delegate_subagent':
      assertExactObjectKeys(directive, ['kind', 'subagent'], 'directive');
      if (!isPlainObject(directive.subagent)) {
        throw new AgentRunInvariantError('directive.subagent must be a plain object.');
      }
      assertExactObjectKeys(
        directive.subagent,
        ['description', 'prompt'],
        'directive.subagent'
      );
      assertBoundedNonEmpty(
        directive.subagent.description,
        'directive.subagent.description',
        256
      );
      assertBoundedNonEmpty(
        directive.subagent.prompt,
        'directive.subagent.prompt',
        MAX_DIRECTIVE_CONTENT_LENGTH
      );
      return;
    case 'checkpoint':
      assertExactObjectKeys(directive, ['kind', 'reason'], 'directive');
      assertBoundedNonEmpty(
        directive.reason,
        'directive.reason',
        MAX_DIRECTIVE_CONTENT_LENGTH
      );
      return;
    case 'complete':
      assertAllowedObjectKeys(directive, ['kind', 'outputRef'], 'directive');
      if (directive.outputRef !== undefined) {
        assertBoundedNonEmpty(
          directive.outputRef,
          'directive.outputRef',
          MAX_DIRECTIVE_CONTENT_LENGTH
        );
      }
      return;
    case 'fail':
      assertExactObjectKeys(directive, ['kind', 'errorCode', 'message'], 'directive');
      assertCanonicalPublicId(directive.errorCode, 'directive.errorCode');
      assertBoundedNonEmpty(
        directive.message,
        'directive.message',
        MAX_DIRECTIVE_CONTENT_LENGTH
      );
      return;
    default:
      throw new AgentRunInvariantError('directive.kind is invalid.');
  }
}

export function assertValidCommittedAgentDirective(
  directive: AgentCommittedDirective
): void {
  if (!isPlainObject(directive)) {
    throw new AgentRunInvariantError('committedDirective must be a plain object.');
  }
  if (directive.kind !== 'invoke_tools') {
    if (directive.kind === 'request_decision') {
      assertExactObjectKeys(directive, ['kind', 'decision'], 'committedDirective');
      assertCommittedPlanDecision(directive.decision);
    } else if (directive.kind === 'delegate_subagent') {
      assertExactObjectKeys(
        directive,
        ['kind', 'delegationId', 'childRunId', 'objectiveDigest'],
        'committedDirective'
      );
      assertCanonicalPublicId(
        directive.delegationId,
        'committedDirective.delegationId'
      );
      assertCanonicalPublicId(
        directive.childRunId,
        'committedDirective.childRunId'
      );
      assertSha256Digest(
        directive.objectiveDigest,
        'committedDirective.objectiveDigest'
      );
    } else if (directive.kind === 'respond') {
      assertExactObjectKeys(
        directive,
        ['kind', 'contentRef', 'contentDigest'],
        'committedDirective'
      );
      assertCanonicalPublicId(directive.contentRef, 'committedDirective.contentRef');
      assertSha256Digest(directive.contentDigest, 'committedDirective.contentDigest');
    } else if (directive.kind === 'checkpoint') {
      assertExactObjectKeys(
        directive,
        ['kind', 'reasonRef', 'reasonDigest'],
        'committedDirective'
      );
      assertCanonicalPublicId(directive.reasonRef, 'committedDirective.reasonRef');
      assertSha256Digest(directive.reasonDigest, 'committedDirective.reasonDigest');
    } else if (directive.kind === 'complete') {
      assertAllowedObjectKeys(
        directive,
        ['kind', 'outputRef', 'outputDigest'],
        'committedDirective'
      );
      if ((directive.outputRef === undefined) !== (directive.outputDigest === undefined)) {
        throw new AgentRunInvariantError(
          'A committed completion output requires both exact ref and digest.'
        );
      }
      if (directive.outputRef !== undefined && directive.outputDigest !== undefined) {
        assertCanonicalPublicId(directive.outputRef, 'committedDirective.outputRef');
        assertSha256Digest(directive.outputDigest, 'committedDirective.outputDigest');
      }
    } else {
      assertExactObjectKeys(
        directive,
        ['kind', 'errorCode', 'messageRef', 'messageDigest'],
        'committedDirective'
      );
      assertCanonicalPublicId(directive.errorCode, 'committedDirective.errorCode');
      assertCanonicalPublicId(directive.messageRef, 'committedDirective.messageRef');
      assertSha256Digest(directive.messageDigest, 'committedDirective.messageDigest');
    }
    return;
  }

  assertExactObjectKeys(directive, ['kind', 'invocations'], 'committedDirective');
  if (
    !Array.isArray(directive.invocations)
    || directive.invocations.length === 0
    || directive.invocations.length > MAX_DIRECTIVE_COLLECTION_LENGTH
  ) {
    throw new AgentRunInvariantError(
      'committedDirective.invocations has an invalid size.'
    );
  }
  assertDenseDataArray(
    directive.invocations,
    'committedDirective.invocations'
  );
  const effectIds = new Set<string>();
  const toolCallIds = new Set<string>();
  const idempotencyKeys = new Set<string>();
  directive.invocations.forEach((invocation, index) => {
    if (!isPlainObject(invocation)) {
      throw new AgentRunInvariantError(
        `committedDirective.invocations[${String(index)}] must be a plain object.`
      );
    }
    const path = `committedDirective.invocations[${String(index)}]`;
    assertAllowedObjectKeys(
      invocation,
      [
        'effectId',
        'toolCallId',
        'tool',
        'idempotencyKey',
        'capabilityIds',
        'scope',
        'inputDigest',
        'permissionDecisionId'
      ],
      path
    );
    for (const required of [
      'effectId',
      'toolCallId',
      'tool',
      'idempotencyKey',
      'capabilityIds',
      'scope',
      'inputDigest'
    ]) {
      if (!Object.prototype.hasOwnProperty.call(invocation, required)) {
        throw new AgentRunInvariantError(`${path} is missing required field "${required}".`);
      }
    }
    const candidate = invocation as unknown as AgentCommittedToolInvocation;
    assertCanonicalPublicId(candidate.effectId, `${path}.effectId`);
    assertCanonicalPublicId(candidate.toolCallId, `${path}.toolCallId`);
    assertValidAgentPinnedToolIdentity(candidate.tool, `${path}.tool`);
    assertCanonicalPublicId(candidate.idempotencyKey, `${path}.idempotencyKey`);
    if (!Array.isArray(candidate.capabilityIds) || !Array.isArray(candidate.scope)) {
      throw new AgentRunInvariantError(
        `${path} capabilityIds and scope must be arrays.`
      );
    }
    assertDenseDataArray(candidate.capabilityIds, `${path}.capabilityIds`);
    assertDenseDataArray(candidate.scope, `${path}.scope`);
    assertCanonicalSortedPublicIds(candidate.capabilityIds, `${path}.capabilityIds`);
    assertCanonicalSortedPublicIds(candidate.scope, `${path}.scope`);
    assertSha256Digest(candidate.inputDigest, `${path}.inputDigest`);
    if (candidate.permissionDecisionId !== undefined) {
      assertCanonicalPublicId(
        candidate.permissionDecisionId,
        `${path}.permissionDecisionId`
      );
    }
    assertUniqueValue(effectIds, candidate.effectId, 'effectId');
    assertUniqueValue(toolCallIds, candidate.toolCallId, 'toolCallId');
    assertUniqueValue(idempotencyKeys, candidate.idempotencyKey, 'idempotencyKey');
  });
}

function assertPlanProposal(
  plan: AgentPlanProposal
): void {
  if (!isPlainObject(plan)) {
    throw new AgentRunInvariantError('directive.plan must be a plain object.');
  }
  assertExactObjectKeys(
    plan,
    ['summary', 'impactSummary', 'steps'],
    'directive.plan'
  );
  assertBoundedNonEmpty(plan.summary, 'directive.plan.summary', 4_096);
  assertBoundedNonEmpty(plan.impactSummary, 'directive.plan.impactSummary', 4_096);
  if (!Array.isArray(plan.steps) || plan.steps.length === 0 || plan.steps.length > 32) {
    throw new AgentRunInvariantError('directive.plan.steps has an invalid size.');
  }
  assertDenseDataArray(plan.steps, 'directive.plan.steps');
  plan.steps.forEach((step, index) => {
    const path = `directive.plan.steps[${String(index)}]`;
    if (!isPlainObject(step)) {
      throw new AgentRunInvariantError(`${path} must be a plain object.`);
    }
    assertExactObjectKeys(step, ['title', 'summary', 'impact'], path);
    const candidate = step as unknown as AgentPlanProposal['steps'][number];
    assertBoundedNonEmpty(candidate.title, `${path}.title`, 256);
    assertBoundedNonEmpty(candidate.summary, `${path}.summary`, 1_024);
    if (![
      'read_only',
      'workspace_change',
      'command_execution',
      'network_access',
      'external_side_effect',
      'mixed'
    ].includes(candidate.impact)) {
      throw new AgentRunInvariantError(`${path}.impact is invalid.`);
    }
  });
}

function assertCommittedPlanDecision(decision: PlanDecisionDraft): void {
  if (!isPlainObject(decision)) {
    throw new AgentRunInvariantError(
      'committedDirective.decision must be a plain object.'
    );
  }
  assertExactObjectKeys(
    decision,
    [
      'kind',
      'decisionId',
      'requestedAt',
      'planId',
      'planVersion',
      'planHash'
    ],
    'committedDirective.decision'
  );
  if (decision.kind !== 'plan') {
    throw new AgentRunInvariantError(
      'committedDirective.decision.kind must be plan.'
    );
  }
  assertCanonicalPublicId(
    decision.decisionId,
    'committedDirective.decision.decisionId'
  );
  assertTimestamp(decision.requestedAt, 'committedDirective.decision.requestedAt');
  assertCanonicalPublicId(decision.planId, 'committedDirective.decision.planId');
  assertPositiveInteger(
    decision.planVersion,
    'committedDirective.decision.planVersion'
  );
  assertBoundedNonEmpty(
    decision.planHash,
    'committedDirective.decision.planHash',
    MAX_IDENTIFIER_LENGTH
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertAllowedObjectKeys(
  value: object,
  allowedKeys: readonly string[],
  field: string
): void {
  const allowed = new Set(allowedKeys);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === 'symbol')) {
    throw new AgentRunInvariantError(`${field} must not contain symbol fields.`);
  }
  const keys = ownKeys as string[];
  const unexpected = keys.find((key) => !allowed.has(key));
  if (unexpected !== undefined) {
    throw new AgentRunInvariantError(
      `${field} contains unsupported field "${unexpected}".`
    );
  }
  for (const key of keys) {
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
}

function assertExactObjectKeys(
  value: object,
  keys: readonly string[],
  field: string
): void {
  assertAllowedObjectKeys(value, keys, field);
  const missing = keys.find((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing !== undefined) {
    throw new AgentRunInvariantError(`${field} is missing required field "${missing}".`);
  }
}

function assertUniqueValue(
  values: Set<string>,
  value: string,
  field: string
): void {
  if (values.has(value)) {
    throw new AgentRunInvariantError(
      `committedDirective invocations must have unique ${field} values.`
    );
  }
  values.add(value);
}
