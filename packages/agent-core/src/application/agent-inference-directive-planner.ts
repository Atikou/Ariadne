import type { AgentRun } from '../domain/agent-run.js';
import { agentRunExecutionMode } from '../domain/run-binding.js';
import {
  type AgentCommittedDirective,
  type AgentCommittedToolInvocation,
  type AgentDirective,
  type AgentToolInvocationDirective,
  assertValidAgentDirective
} from '../domain/directive.js';
import { DEFAULT_AGENT_SUBAGENT_PROVIDER_ID } from '../domain/directive.js';
import { AgentRunInvariantError } from '../domain/errors.js';
import {
  type AgentAvailableTool,
  type AgentPinnedToolIdentity,
  type AgentToolJsonValue,
  cloneAgentAvailableTool,
  cloneAgentPinnedToolIdentity,
  cloneCanonicalAgentToolInput,
  isToolIdentityInCatalog,
  sameAgentPinnedToolIdentity
} from '../domain/tool.js';
import type { AgentInferenceAttempt, AgentTurn } from '../domain/turn.js';
import type {
  AgentControlJsonValue,
  AgentPlanVersionCommit
} from '../domain/plan-budget-delegation.js';
import {
  assertCanonicalPublicId,
  assertSha256Digest,
  assertTimestamp
} from '../domain/values.js';
import type { AgentTurnInputModelData } from './agent-engine.js';
import type { AgentInferenceAttemptResult } from './commands.js';
import { digestAgentCommittedDirective } from './directive-digest.js';
import type { AgentEffectInputDigester } from './effect-input-digest.js';
import {
  assertValidAgentToolAdmissionDecision,
  type AgentToolAdmissionPolicy
} from './ports/agent-tool-admission-policy.js';
import type { AgentEffectPayloadCommit } from './recovery-persistence.js';
import type { AgentDirectivePayloadCommit } from './recovery-persistence.js';
import { sha256AgentControlData } from './control-command-digest.js';
import { deriveStableAgentId } from './stable-id.js';

export interface PlanAgentInferenceDirectiveRequest {
  /** Identity of the one result command that will persist this plan. */
  readonly resultCommandId: string;
  readonly run: AgentRun;
  readonly turn: AgentTurn;
  readonly attempt: AgentInferenceAttempt;
  readonly directive: AgentDirective;
  /** Exact catalog snapshot already bound by the Turn input digest. */
  readonly availableTools: AgentTurnInputModelData['availableTools'];
  /** Protected current model history, used only to seed an admitted child Turn. */
  readonly messages?: AgentTurnInputModelData['messages'];
  readonly occurredAt: string;
}

export interface AgentSubagentDelegationPlan {
  readonly delegationId: string;
  readonly childRunId: string;
  readonly childGrantId: string;
  readonly description: string;
  readonly prompt: string;
  readonly mode: import('../domain/directive.js').AgentSubagentMode;
  readonly providerId: string;
  readonly objective: AgentControlJsonValue;
  readonly objectiveDigest: string;
  readonly sourceMessages: AgentTurnInputModelData['messages'];
  readonly availableTools: AgentTurnInputModelData['availableTools'];
}

export interface AgentSubagentProviderSelectionPolicy {
  select(request: {
    readonly requestedProviderId: string | undefined;
    readonly mode: import('../domain/directive.js').AgentSubagentMode;
    readonly parentRun: AgentRun;
  }): string | null | Promise<string | null>;
}

const DEFAULT_SUBAGENT_PROVIDER_SELECTION: AgentSubagentProviderSelectionPolicy = {
  select: ({ requestedProviderId }) => requestedProviderId === undefined
    || requestedProviderId === DEFAULT_AGENT_SUBAGENT_PROVIDER_ID
    ? DEFAULT_AGENT_SUBAGENT_PROVIDER_ID
    : null
};

export interface AgentInferenceDirectivePlan {
  readonly result: Extract<
    AgentInferenceAttemptResult,
    { readonly status: 'succeeded' | 'failed' }
  >;
  readonly effectPayloads: readonly AgentEffectPayloadCommit[];
  readonly directivePayloads: readonly AgentDirectivePayloadCommit[];
  readonly planVersions: readonly AgentPlanVersionCommit[];
  readonly subagent?: AgentSubagentDelegationPlan;
}

/** Deterministic planning boundary; it performs no persistence or Tool I/O. */
export interface AgentInferenceDirectivePlanner {
  plan(
    request: PlanAgentInferenceDirectiveRequest
  ): Promise<AgentInferenceDirectivePlan>;
}

interface AdmittedInvocation {
  readonly toolCallId: string;
  readonly tool: AgentPinnedToolIdentity;
  readonly capabilityIds: readonly string[];
  readonly scope: readonly string[];
  readonly disposition: 'allow' | 'wait';
  readonly normalizedInput: AgentToolJsonValue;
}

interface AuthoritativeToolCatalog {
  readonly availableTools: readonly AgentAvailableTool[];
  readonly byName: ReadonlyMap<string, AgentAvailableTool>;
}

export class DefaultAgentInferenceDirectivePlanner
implements AgentInferenceDirectivePlanner {
  public constructor(
    private readonly effectInputDigester: AgentEffectInputDigester,
    private readonly toolAdmissionPolicy: AgentToolAdmissionPolicy,
    private readonly subagentProviders: AgentSubagentProviderSelectionPolicy =
      DEFAULT_SUBAGENT_PROVIDER_SELECTION
  ) {}

  public async plan(
    request: PlanAgentInferenceDirectiveRequest
  ): Promise<AgentInferenceDirectivePlan> {
    assertPlanRequest(request);
    try {
      assertValidAgentDirective(request.directive);
    } catch {
      return deterministicFailure(
        'AGENT_DIRECTIVE_INVALID',
        'Engine returned a directive outside the bounded Agent contract.'
      );
    }

    if (
      agentRunExecutionMode(request.run.binding) === 'plan'
      && request.directive.kind !== 'invoke_tools'
      && request.directive.kind !== 'propose_plan'
      && request.directive.kind !== 'ask_user'
      && request.directive.kind !== 'checkpoint'
      && request.directive.kind !== 'fail'
    ) {
      return deterministicFailure(
        'AGENT_PLAN_DIRECTIVE_INVALID',
        'Plan execution may inspect, checkpoint, fail, or propose one immutable plan.'
      );
    }

    if (request.directive.kind !== 'invoke_tools') {
      if (request.directive.kind === 'delegate_subagent') {
        return this.planSubagentDelegation(request);
      }
      const planned = await this.commitNonToolDirective(request);
      const result = await succeededPlan(planned.directive, planned.payloads);
      return { ...result, planVersions: planned.planVersions };
    }

    const catalog = authoritativeToolCatalog(request);
    const toolCallIds = new Set<string>();
    for (const invocation of request.directive.invocations) {
      const available = catalog.byName.get(invocation.tool.toolName);
      if (
        toolCallIds.has(invocation.toolCallId)
        || available === undefined
        || !sameAgentPinnedToolIdentity(invocation.tool, available.tool)
        || !sameStringSet(invocation.capabilityIds, available.capabilityIds)
      ) {
        return deterministicFailure(
          'AGENT_DIRECTIVE_CATALOG_MISMATCH',
          'Engine tool invocation does not match the authoritative pinned Tool Catalog.'
        );
      }
      toolCallIds.add(invocation.toolCallId);
    }

    const admissions: AdmittedInvocation[] = [];
    let denied = false;
    for (let index = 0; index < request.directive.invocations.length; index += 1) {
      const invocation = request.directive.invocations[index];
      if (invocation === undefined) {
        throw new AgentRunInvariantError('A validated invocation cannot be missing.');
      }
      const policyInvocation: AgentToolInvocationDirective = {
        toolCallId: invocation.toolCallId,
        tool: cloneAgentPinnedToolIdentity(
          invocation.tool,
          `directive.invocations[${String(index)}].tool`
        ),
        input: cloneCanonicalAgentToolInput(
          invocation.input,
          `directive.invocations[${String(index)}].input`
        ),
        capabilityIds: [...invocation.capabilityIds],
        scope: [...invocation.scope]
      };
      // Infrastructure exceptions and malformed decisions deliberately escape
      // this planner. The dispatcher owns the uncertain-outcome transition.
      const decision = await this.toolAdmissionPolicy.admit({
        run: request.run,
        turn: request.turn,
        attempt: request.attempt,
        availableTools: catalog.availableTools,
        invocation: policyInvocation
      });
      assertValidAgentToolAdmissionDecision(
        decision,
        `toolAdmissionDecisions[${String(index)}]`
      );
      if (decision.status === 'deny') {
        denied = true;
        continue;
      }
      const available = catalog.byName.get(invocation.tool.toolName);
      if (
        available === undefined
        || !sameAgentPinnedToolIdentity(decision.tool, invocation.tool)
        || !sameAgentPinnedToolIdentity(decision.tool, available.tool)
        || !sameStringSet(decision.capabilityIds, invocation.capabilityIds)
        || !sameStringSet(decision.capabilityIds, available.capabilityIds)
        || !isStringSubset(decision.scope, invocation.scope)
      ) {
        throw new AgentRunInvariantError(
          'Tool admission policy returned identity, capability, or scope outside the requested pin.'
        );
      }
      admissions.push({
        toolCallId: invocation.toolCallId,
        tool: cloneAgentPinnedToolIdentity(decision.tool),
        capabilityIds: [...decision.capabilityIds],
        scope: [...decision.scope],
        disposition:
          decision.status === 'wait'
          || request.run.binding.policy.permissionMode === 'ask'
            ? 'wait'
            : 'allow',
        normalizedInput: cloneCanonicalAgentToolInput(
          decision.normalizedInput,
          `toolAdmissionDecisions[${String(index)}].normalizedInput`
        )
      });
    }

    if (denied) {
      return deterministicFailure(
        'AGENT_DIRECTIVE_TOOL_ADMISSION_DENIED',
        'Tool admission policy denied the requested invocation batch.'
      );
    }
    if (admissions.length !== request.directive.invocations.length) {
      throw new AgentRunInvariantError(
        'Every validated tool invocation must have one admission decision.'
      );
    }
    if (
      admissions.length > 1
      && admissions.some((admission) => admission.disposition === 'wait')
    ) {
      return deterministicFailure(
        'AGENT_DIRECTIVE_MULTI_PERMISSION_UNSUPPORTED',
        'A multi-tool batch cannot contain a waiting admission decision.'
      );
    }

    const invocations: AgentCommittedToolInvocation[] = [];
    const effectPayloads: AgentEffectPayloadCommit[] = [];
    for (let index = 0; index < admissions.length; index += 1) {
      const admission = admissions[index];
      if (admission === undefined) {
        throw new AgentRunInvariantError('An admitted invocation cannot be missing.');
      }
      const identity = [
        request.resultCommandId,
        request.run.runId,
        request.turn.turnId,
        request.attempt.attemptId,
        admission.toolCallId,
        String(index + 1)
      ] as const;
      const effectId = await deriveStableAgentId('effect', ...identity);
      const idempotencyKey = await deriveStableAgentId(
        'effect-idempotency',
        ...identity
      );
      const inputDigest = this.effectInputDigester.digest(
        admission.normalizedInput,
        { runId: request.run.runId, effectId }
      );
      assertSha256Digest(inputDigest, 'plannedEffect.inputDigest');
      const permissionDecisionId = admission.disposition === 'wait'
        ? await deriveStableAgentId('permission-decision', ...identity)
        : undefined;
      invocations.push({
        effectId,
        toolCallId: admission.toolCallId,
        tool: admission.tool,
        idempotencyKey,
        capabilityIds: [...admission.capabilityIds],
        scope: [...admission.scope],
        inputDigest,
        ...(permissionDecisionId === undefined ? {} : { permissionDecisionId })
      });
      effectPayloads.push({
        kind: 'record_input',
        effectId,
        inputDigest,
        input: admission.normalizedInput,
        recordedAt: request.occurredAt
      });
    }
    const directive: AgentCommittedDirective = {
      kind: 'invoke_tools',
      invocations
    };
    return {
      result: {
        status: 'succeeded',
        directive,
        directiveDigest: await digestAgentCommittedDirective(directive)
      },
      effectPayloads,
      directivePayloads: [],
      planVersions: []
    };
  }

  private async planSubagentDelegation(
    request: PlanAgentInferenceDirectiveRequest
  ): Promise<AgentInferenceDirectivePlan> {
    const source = request.directive;
    if (source.kind !== 'delegate_subagent') {
      throw new AgentRunInvariantError('SubAgent planning requires a delegation Directive.');
    }
    if (request.messages === undefined) {
      return deterministicFailure(
        'AGENT_SUBAGENT_CONTEXT_UNAVAILABLE',
        'SubAgent delegation requires the exact protected parent Turn input.'
      );
    }
    const identity = [
      request.resultCommandId,
      request.run.runId,
      request.turn.turnId,
      request.attempt.attemptId
    ] as const;
    const delegationId = await deriveStableAgentId('delegation', ...identity);
    const childRunId = await deriveStableAgentId('delegated-run', ...identity);
    const childGrantId = await deriveStableAgentId('delegated-budget', ...identity);
    const providerId = await this.subagentProviders.select({
      requestedProviderId: source.subagent.providerId,
      mode: source.subagent.mode,
      parentRun: request.run
    });
    if (providerId === null) {
      return deterministicFailure(
        'AGENT_SUBAGENT_PROVIDER_UNAVAILABLE',
        'The requested SubAgent provider does not support this delegation mode.'
      );
    }
    assertCanonicalPublicId(providerId, 'subagent.providerId');
    const objective: AgentControlJsonValue = {
      format: 'ariadne.subagent-objective',
      schemaVersion: 3,
      description: source.subagent.description,
      prompt: source.subagent.prompt,
      mode: source.subagent.mode,
      providerId
    };
    const objectiveDigest = await sha256AgentControlData(objective);
    const directive: AgentCommittedDirective = {
      kind: 'delegate_subagent',
      delegationId,
      childRunId,
      objectiveDigest,
      mode: source.subagent.mode,
      providerId
    };
    return {
      result: {
        status: 'succeeded',
        directive,
        directiveDigest: await digestAgentCommittedDirective(directive)
      },
      effectPayloads: [],
      directivePayloads: [],
      planVersions: [],
      subagent: {
        delegationId,
        childRunId,
        childGrantId,
        description: source.subagent.description,
        prompt: source.subagent.prompt,
        mode: source.subagent.mode,
        providerId,
        objective,
        objectiveDigest,
        sourceMessages: request.messages.map((message) => message.kind === 'text'
          ? { ...message }
          : message.kind === 'image'
            ? {
                ...message,
                owner: { ...message.owner },
                attachment: {
                  ...message.attachment,
                  ...(message.attachment.originalDimensions === undefined
                    ? {}
                    : { originalDimensions: { ...message.attachment.originalDimensions } })
                }
              }
            : {
                ...message,
                result: cloneCanonicalAgentToolInput(message.result)
              }),
        availableTools: request.availableTools.map((tool, index) => (
          cloneAgentAvailableTool(tool, `subagent.availableTools[${String(index)}]`)
        ))
      }
    };
  }

  private async commitNonToolDirective(
    request: PlanAgentInferenceDirectiveRequest
  ): Promise<{
    readonly directive: AgentCommittedDirective;
    readonly payloads: readonly Omit<AgentDirectivePayloadCommit, 'directiveDigest'>[];
    readonly planVersions: readonly AgentPlanVersionCommit[];
  }> {
    const source = request.directive;
    switch (source.kind) {
      case 'respond': {
        const artifactId = await directiveArtifactId(request, 'response-content');
        const contentDigest = await sha256AgentControlData(source.content);
        return {
          directive: { kind: 'respond', contentRef: artifactId, contentDigest },
          payloads: [{
            artifactId,
            kind: 'response_content',
            contentDigest,
            payload: source.content,
            recordedAt: request.occurredAt
          }],
          planVersions: []
        };
      }
      case 'propose_plan': {
        const planId = await deriveStableAgentId(
          'plan',
          request.resultCommandId,
          request.run.runId,
          request.turn.turnId,
          request.attempt.attemptId
        );
        const planVersion = 1;
        const payload: AgentControlJsonValue = {
          publicPresentation: {
            contractVersion: '1.0',
            summary: source.plan.summary,
            impactSummary: source.plan.impactSummary,
            steps: source.plan.steps.map((step) => ({ ...step }))
          }
        };
        const planHash = await sha256AgentControlData(payload);
        const decisionId = await deriveStableAgentId(
          'plan-decision',
          request.resultCommandId,
          request.run.runId,
          request.turn.turnId,
          request.attempt.attemptId,
          planId,
          String(planVersion)
        );
        return {
          directive: {
            kind: 'request_decision',
            decision: {
              kind: 'plan',
              planId,
              planVersion,
              planHash,
              decisionId,
              requestedAt: request.occurredAt
            }
          },
          payloads: [],
          planVersions: [{
            ref: { planId, version: planVersion, contentHash: planHash },
            runId: request.run.runId,
            payload,
            createdAt: request.occurredAt
          }]
        };
      }
      case 'ask_user': {
        const artifactId = await directiveArtifactId(request, 'user-question');
        const decisionId = await deriveStableAgentId(
          'user-question-decision',
          request.resultCommandId,
          request.run.runId,
          request.turn.turnId,
          request.attempt.attemptId
        );
        const payload: AgentControlJsonValue = {
          format: 'ariadne.user-question',
          schemaVersion: 1,
          prompt: source.question.prompt,
          ...(source.question.options === undefined
            ? {}
            : {
                options: source.question.options.map((option) => ({
                  optionId: option.optionId,
                  label: option.label,
                  ...(option.description === undefined
                    ? {}
                    : { description: option.description })
                }))
              })
        };
        const questionDigest = await sha256AgentControlData(payload);
        return {
          directive: {
            kind: 'ask_user',
            decisionId,
            questionRef: artifactId,
            questionDigest
          },
          payloads: [{
            artifactId,
            kind: 'user_question',
            contentDigest: questionDigest,
            payload,
            recordedAt: request.occurredAt
          }],
          planVersions: []
        };
      }
      case 'delegate_subagent':
        throw new AgentRunInvariantError(
          'SubAgent Directives must use the delegation planning branch.'
        );
      case 'checkpoint': {
        const artifactId = await directiveArtifactId(request, 'checkpoint-reason');
        const contentDigest = await sha256AgentControlData(source.reason);
        return {
          directive: {
            kind: 'checkpoint',
            reasonRef: artifactId,
            reasonDigest: contentDigest
          },
          payloads: [{
            artifactId,
            kind: 'checkpoint_reason',
            contentDigest,
            payload: source.reason,
            recordedAt: request.occurredAt
          }],
          planVersions: []
        };
      }
      case 'complete': {
        if (source.outputRef === undefined) {
          return { directive: { kind: 'complete' }, payloads: [], planVersions: [] };
        }
        const artifactId = await directiveArtifactId(request, 'completion-output');
        const contentDigest = await sha256AgentControlData(source.outputRef);
        return {
          directive: {
            kind: 'complete',
            outputRef: artifactId,
            outputDigest: contentDigest
          },
          payloads: [{
            artifactId,
            kind: 'completion_output',
            contentDigest,
            payload: source.outputRef,
            recordedAt: request.occurredAt
          }],
          planVersions: []
        };
      }
      case 'fail': {
        const artifactId = await directiveArtifactId(request, 'failure-message');
        const contentDigest = await sha256AgentControlData(source.message);
        return {
          directive: {
            kind: 'fail',
            errorCode: source.errorCode,
            messageRef: artifactId,
            messageDigest: contentDigest
          },
          payloads: [{
            artifactId,
            kind: 'failure_message',
            contentDigest,
            payload: source.message,
            recordedAt: request.occurredAt
          }],
          planVersions: []
        };
      }
      case 'invoke_tools':
        throw new AgentRunInvariantError(
          'Tool Directives must use the tool planning branch.'
        );
    }
  }
}

async function succeededPlan(
  directive: AgentCommittedDirective,
  payloads: readonly Omit<AgentDirectivePayloadCommit, 'directiveDigest'>[] = []
): Promise<AgentInferenceDirectivePlan> {
  const directiveDigest = await digestAgentCommittedDirective(directive);
  return {
    result: {
      status: 'succeeded',
      directive,
      directiveDigest
    },
    effectPayloads: [],
    directivePayloads: payloads.map((payload) => ({
      ...payload,
      directiveDigest
    })),
    planVersions: []
  };
}

function deterministicFailure(
  errorCode: string,
  message: string
): AgentInferenceDirectivePlan {
  return {
    result: { status: 'failed', errorCode, message },
    effectPayloads: [],
    directivePayloads: [],
    planVersions: []
  };
}

function directiveArtifactId(
  request: PlanAgentInferenceDirectiveRequest,
  kind: string
): Promise<string> {
  return deriveStableAgentId(
    'directive-artifact',
    request.resultCommandId,
    request.run.runId,
    request.turn.turnId,
    request.attempt.attemptId,
    kind
  );
}

function assertPlanRequest(request: PlanAgentInferenceDirectiveRequest): void {
  assertCanonicalPublicId(request.resultCommandId, 'directivePlan.resultCommandId');
  assertTimestamp(request.occurredAt, 'directivePlan.occurredAt');
  if (
    request.turn.runId !== request.run.runId
    || request.attempt.runId !== request.run.runId
    || request.attempt.turnId !== request.turn.turnId
    || (
      request.attempt.state.status !== 'started'
      && request.attempt.state.status !== 'uncertain'
    )
  ) {
    throw new AgentRunInvariantError(
      'Directive planning requires the exact started or recovering Run, Turn, and Attempt.'
    );
  }
}

function authoritativeToolCatalog(
  request: PlanAgentInferenceDirectiveRequest
): AuthoritativeToolCatalog {
  const availableTools: AgentAvailableTool[] = [];
  const byName = new Map<string, AgentAvailableTool>();
  for (let index = 0; index < request.availableTools.length; index += 1) {
    const source = request.availableTools[index];
    if (source === undefined) {
      throw new AgentRunInvariantError('The authoritative Tool Catalog must be dense.');
    }
    const tool = cloneAgentAvailableTool(
      source,
      `availableTools[${String(index)}]`
    );
    if (!isToolIdentityInCatalog(tool.tool, request.run.binding.toolCatalog)) {
      throw new AgentRunInvariantError(
        'The authoritative Turn Tool Catalog does not match the immutable Run binding.'
      );
    }
    if (!request.run.binding.toolCatalog.allowedToolNames.includes(tool.tool.toolName)) {
      throw new AgentRunInvariantError(
        'The authoritative Turn Tool Catalog exceeds the Run allowed-Tool grant.'
      );
    }
    if (byName.has(tool.tool.toolName)) {
      throw new AgentRunInvariantError(
        'The authoritative Turn Tool Catalog contains duplicate tool names.'
      );
    }
    availableTools.push(tool);
    byName.set(tool.tool.toolName, tool);
  }
  return { availableTools, byName };
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return left.length === right.length
    && left.every((value) => right.includes(value));
}

function isStringSubset(
  subset: readonly string[],
  superset: readonly string[]
): boolean {
  return subset.every((value) => superset.includes(value));
}
