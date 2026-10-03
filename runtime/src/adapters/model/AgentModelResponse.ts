import {
  assertValidAgentDirective,
  cloneAgentPinnedToolIdentity,
  cloneCanonicalAgentToolInput,
  type AgentDirective,
  type AgentPlanStepImpact
} from '@ariadne/agent-core';
import type { ExactAgentModelInferenceContentBlock, ExactAgentModelInferenceReplayEnvelopeV1 } from '../../control/ports/AgentModelInference.js';
import {
  CONTROL_KINDS_BY_PROVIDER_NAME,
  type PreparedToolContract,
  StrictDirectiveProtocolError,
  isPlainObject
} from './AgentModelProtocol.js';
import { controlKindsForMode } from './AgentModelToolContracts.js';

export function parseNativeAgentResponse(
  finishReason: ExactAgentModelInferenceReplayEnvelopeV1['finishReason'],
  content: string,
  nativeToolCalls: readonly Extract<
    ExactAgentModelInferenceContentBlock,
    { readonly type: 'tool_call' }
  >[],
  tools: readonly PreparedToolContract[],
  executionMode: 'chat' | 'agent' | 'plan'
): AgentDirective {
  if (finishReason === 'tool_calls') {
    return parseNativeCalls(content, nativeToolCalls, tools, executionMode);
  }
  if (executionMode === 'plan') {
    throw new StrictDirectiveProtocolError();
  }
  return parsePlainTextResponse(finishReason, content, nativeToolCalls);
}

export function parsePlainTextResponse(
  finishReason: ExactAgentModelInferenceReplayEnvelopeV1['finishReason'],
  content: string,
  nativeToolCalls: readonly Extract<
    ExactAgentModelInferenceContentBlock,
    { readonly type: 'tool_call' }
  >[]
): AgentDirective {
  if (
    finishReason !== 'stop'
    || nativeToolCalls.length !== 0
    || content.trim().length === 0
  ) {
    throw new StrictDirectiveProtocolError();
  }
  const directive: AgentDirective = { kind: 'respond', content };
  try {
    assertValidAgentDirective(directive);
  } catch {
    throw new StrictDirectiveProtocolError();
  }
  return directive;
}

function parseNativeCalls(
  textContent: string,
  calls: readonly Extract<
    ExactAgentModelInferenceContentBlock,
    { readonly type: 'tool_call' }
  >[],
  tools: readonly PreparedToolContract[],
  executionMode: 'chat' | 'agent' | 'plan'
): AgentDirective {
  if (textContent.trim().length !== 0 || calls.length === 0) {
    throw new StrictDirectiveProtocolError();
  }
  const controlCalls = calls.filter((call) => CONTROL_KINDS_BY_PROVIDER_NAME.has(
    call.providerToolName
  ));
  if (controlCalls.length === 0) return parseNativeToolCalls(textContent, calls, tools);
  if (calls.length !== 1) throw new StrictDirectiveProtocolError();
  const call = controlCalls[0]!;
  const kind = CONTROL_KINDS_BY_PROVIDER_NAME.get(call.providerToolName)!;
  if (!controlKindsForMode(executionMode).includes(kind)) {
    throw new StrictDirectiveProtocolError();
  }
  const input = plainObject(call.input);
  const directive = parseControlDirective({ kind, ...input });
  try {
    assertValidAgentDirective(directive);
  } catch {
    throw new StrictDirectiveProtocolError();
  }
  return directive;
}

function parseNativeToolCalls(
  textContent: string,
  calls: readonly Extract<
    ExactAgentModelInferenceContentBlock,
    { readonly type: 'tool_call' }
  >[],
  tools: readonly PreparedToolContract[]
): AgentDirective {
  if (textContent.trim().length !== 0 || calls.length === 0) {
    throw new StrictDirectiveProtocolError();
  }
  const toolsByProviderName = new Map(
    tools.map((tool) => [tool.providerToolName, tool] as const)
  );
  const toolCallIds = new Set<string>();
  const invocations = calls.map((call) => {
    const tool = toolsByProviderName.get(call.providerToolName);
    if (tool === undefined || toolCallIds.has(call.toolCallId)) {
      throw new StrictDirectiveProtocolError();
    }
    toolCallIds.add(call.toolCallId);
    const envelope = exactObject(call.input, ['input', 'scope']);
    const scope = stringArray(envelope.scope);
    if (
      tool.scopeSemantics === 'none'
        ? scope.length !== 0
        : scope.some((scopeId) => !tool.allowedScopes.includes(scopeId))
    ) throw new StrictDirectiveProtocolError();
    return {
      toolCallId: call.toolCallId,
      tool: cloneAgentPinnedToolIdentity(tool.tool),
      input: cloneCanonicalAgentToolInput(envelope.input, 'nativeToolCall.input'),
      capabilityIds: [...tool.capabilityIds],
      scope
    };
  });
  const directive: AgentDirective = { kind: 'invoke_tools', invocations };
  try {
    assertValidAgentDirective(directive);
  } catch {
    throw new StrictDirectiveProtocolError();
  }
  return directive;
}

function parseControlDirective(value: unknown): AgentDirective {
  const candidate = plainObject(value);
  switch (candidate.kind) {
    case 'propose_plan': {
      const exact = exactObject(candidate, ['kind', 'plan']);
      const plan = exactObject(exact.plan, ['summary', 'impactSummary', 'steps']);
      if (!Array.isArray(plan.steps)) throw new StrictDirectiveProtocolError();
      return {
        kind: 'propose_plan',
        plan: {
          summary: stringValue(plan.summary),
          impactSummary: stringValue(plan.impactSummary),
          steps: plan.steps.map((candidateStep) => {
            const step = exactObject(
              candidateStep,
              ['title', 'summary', 'impact']
            );
            return {
              title: stringValue(step.title),
              summary: stringValue(step.summary),
              impact: planImpactValue(step.impact)
            };
          })
        }
      };
    }
    case 'delegate_subagent': {
      const exact = exactObject(candidate, ['kind', 'subagent']);
      const subagent = exactObjectWithOptional(
        exact.subagent,
        ['description', 'prompt', 'mode'],
        ['providerId']
      );
      return {
        kind: 'delegate_subagent',
        subagent: {
          description: stringValue(subagent.description),
          prompt: stringValue(subagent.prompt),
          mode: subagentModeValue(subagent.mode),
          ...(subagent.providerId === undefined
            ? {}
            : { providerId: stringValue(subagent.providerId) })
        }
      };
    }
    case 'delegate_subagents': {
      const exact = exactObject(candidate, ['kind', 'subagents']);
      if (!Array.isArray(exact.subagents)) throw new StrictDirectiveProtocolError();
      return {
        kind: 'delegate_subagents',
        subagents: exact.subagents.map((candidateSubagent) => {
          const subagent = exactObjectWithOptional(
            candidateSubagent,
            ['description', 'prompt', 'mode'],
            ['providerId']
          );
          return {
            description: stringValue(subagent.description),
            prompt: stringValue(subagent.prompt),
            mode: subagentModeValue(subagent.mode),
            ...(subagent.providerId === undefined
              ? {}
              : { providerId: stringValue(subagent.providerId) })
          };
        })
      };
    }
    case 'ask_user': {
      const exact = exactObject(candidate, ['kind', 'question']);
      const question = exactObjectWithOptional(exact.question, ['prompt'], ['options']);
      const options = question.options;
      if (options !== undefined && !Array.isArray(options)) {
        throw new StrictDirectiveProtocolError();
      }
      return {
        kind: 'ask_user',
        question: {
          prompt: stringValue(question.prompt),
          ...(options === undefined
            ? {}
            : {
                options: options.map((candidateOption) => {
                  const option = exactObjectWithOptional(
                    candidateOption,
                    ['optionId', 'label'],
                    ['description']
                  );
                  return {
                    optionId: stringValue(option.optionId),
                    label: stringValue(option.label),
                    ...(option.description === undefined
                      ? {}
                      : { description: stringValue(option.description) })
                  };
                })
              })
        }
      };
    }
    case 'checkpoint': {
      const exact = exactObject(candidate, ['kind', 'reason']);
      return { kind: 'checkpoint', reason: stringValue(exact.reason) };
    }
    case 'complete': {
      const exact = exactObjectWithOptional(candidate, ['kind'], ['outputRef']);
      return exact.outputRef === undefined
        ? { kind: 'complete' }
        : { kind: 'complete', outputRef: stringValue(exact.outputRef) };
    }
    case 'fail': {
      const exact = exactObject(candidate, ['kind', 'errorCode', 'message']);
      return {
        kind: 'fail',
        errorCode: stringValue(exact.errorCode),
        message: stringValue(exact.message)
      };
    }
    default:
      throw new StrictDirectiveProtocolError();
  }
}

function exactObject(
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> {
  const object = plainObject(value);
  const actual = Object.keys(object);
  if (
    actual.length !== keys.length
    || actual.some((key) => !keys.includes(key))
    || keys.some((key) => !Object.prototype.hasOwnProperty.call(object, key))
  ) {
    throw new StrictDirectiveProtocolError();
  }
  return object;
}

function exactObjectWithOptional(
  value: unknown,
  required: readonly string[],
  optional: readonly string[]
): Record<string, unknown> {
  const object = plainObject(value);
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(object);
  if (
    actual.some((key) => !allowed.has(key))
    || required.some((key) => !Object.prototype.hasOwnProperty.call(object, key))
  ) {
    throw new StrictDirectiveProtocolError();
  }
  return object;
}

function plainObject(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) throw new StrictDirectiveProtocolError();
  return value;
}

function stringValue(value: unknown): string {
  if (typeof value !== 'string') throw new StrictDirectiveProtocolError();
  return value;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new StrictDirectiveProtocolError();
  }
  return [...value] as string[];
}

function planImpactValue(value: unknown): AgentPlanStepImpact {
  if (
    value !== 'read_only'
    && value !== 'workspace_change'
    && value !== 'command_execution'
    && value !== 'network_access'
    && value !== 'external_side_effect'
    && value !== 'mixed'
  ) throw new StrictDirectiveProtocolError();
  return value;
}

function subagentModeValue(value: unknown): 'one_shot' | 'continuable' {
  if (value !== 'one_shot' && value !== 'continuable') {
    throw new StrictDirectiveProtocolError();
  }
  return value;
}
