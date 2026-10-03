import { createHash } from 'node:crypto';

import type {
  DispatchExactAgentModelInferenceRequest,
  ExactAgentModelInferenceContentBlock,
  ExactAgentModelInferenceRuntime,
  ExactAgentModelInferenceToolContract
} from '../../control/ports/AgentModelInference.js';
import type { AgentToolJsonValue } from '@ariadne/agent-core';
import type { ModelCapabilityRegistry } from './ModelCapabilityRegistry.js';
import type { ModelCapabilityQualification } from './ModelCapabilityQualification.js';

const REPEATS = 3;
const SAMPLING = Object.freeze({ temperature: 0, maxOutputTokens: 256 });

const ECHO_TOOL = tool('probe_echo', 'Echo one fixed value.', {
  type: 'object', additionalProperties: false, required: ['value'],
  properties: { value: { type: 'string', enum: ['ARIADNE_ECHO'] } }
});
const CALCULATE_TOOL = tool('probe_calculate', 'Add the two provided integers.', {
  type: 'object', additionalProperties: false, required: ['left', 'right'],
  properties: { left: { type: 'integer' }, right: { type: 'integer' } }
});
const LOOKUP_TOOL = tool('probe_lookup_fixture', 'Look up a fixed test record.', {
  type: 'object', additionalProperties: false, required: ['key'],
  properties: { key: { type: 'string', enum: ['alpha'] } }
});
const ASK_USER_CONTROL = tool('ariadne_control_ask_user', 'Ask the user one question.', {
  type: 'object', additionalProperties: false, required: ['question'],
  properties: {
    question: {
      type: 'object', additionalProperties: false, required: ['prompt'],
      properties: { prompt: { type: 'string', minLength: 1 } }
    }
  }
});
const PLAN_CONTROL = tool('ariadne_control_propose_plan', 'Submit a structured plan.', {
  type: 'object', additionalProperties: false, required: ['plan'],
  properties: {
    plan: {
      type: 'object', additionalProperties: false,
      required: ['summary', 'impactSummary', 'steps'],
      properties: {
        summary: { type: 'string', minLength: 1 },
        impactSummary: { type: 'string', minLength: 1 },
        steps: {
          type: 'array', minItems: 1,
          items: {
            type: 'object', additionalProperties: false,
            required: ['title', 'summary', 'impact'],
            properties: {
              title: { type: 'string', minLength: 1 },
              summary: { type: 'string', minLength: 1 },
              impact: { type: 'string', enum: ['read_only'] }
            }
          }
        }
      }
    }
  }
});
const PROBE_TOOLS = Object.freeze([ECHO_TOOL, CALCULATE_TOOL, LOOKUP_TOOL]);

/** Full isolated qualification. It owns only fixed synthetic prompts and fake Tool results. */
export class ModelCapabilityProbeHarness {
  public constructor(
    private readonly models: ExactAgentModelInferenceRuntime,
    private readonly registry: ModelCapabilityRegistry
  ) {}

  public async run(input: {
    readonly binding: DispatchExactAgentModelInferenceRequest['binding'];
    readonly fingerprint: string;
    readonly signal: AbortSignal;
    readonly probeVision?: boolean;
  }): Promise<ModelCapabilityQualification> {
    const identity = {
      providerId: input.binding.providerId,
      modelId: input.binding.modelId,
      fingerprint: input.fingerprint
    };
    const testing: ModelCapabilityQualification = {
      ...this.registry.read(identity.providerId, identity.modelId, identity.fingerprint),
      textResponse: 'testing',
      streamingText: 'testing',
      nativeToolCalls: 'testing',
      validToolArguments: 'testing',
      toolSelection: 'testing',
      toolResultContinuation: 'testing',
      directTextInAgent: 'testing',
      ariadneControlCalls: 'testing',
      planControlCalls: 'testing',
      visionInput: input.probeVision === true ? 'testing' : existingVisionState(
        this.registry.read(identity.providerId, identity.modelId, identity.fingerprint).visionInput
      )
    };
    this.registry.write(testing);
    let stage: 'text' | 'agent' | 'plan' | 'vision' = 'text';
    let streamed = true;
    try {
      for (let attempt = 0; attempt < REPEATS; attempt += 1) {
        const observed: string[] = [];
        const text = await this.infer(input, [message('user', 'Reply with the single word READY.')], [], {
          observe: (chunk) => {
            if (chunk.channel === 'token') observed.push(chunk.text);
          }
        });
        assertText(text);
        streamed = streamed && observed.length > 0;
      }

      stage = 'agent';
      for (let attempt = 0; attempt < REPEATS; attempt += 1) {
        const toolDecision = await this.infer(input, [
          message('system', 'Use exactly one native function. Do not print function JSON.'),
          message('user', 'Calculate 2 plus 3 using the calculation function.')
        ], PROBE_TOOLS);
        const call = exactSingleToolCall(toolDecision, 'probe_calculate');
        if (!isExactCalculation(call.input)) throw new Error('model_probe_tool_arguments_invalid');

        const continuation = await this.infer(input, [
          message('user', 'Calculate 2 plus 3 using the calculation function.'),
          {
            role: 'assistant',
            content: [{
              type: 'tool_call',
              toolCallId: call.toolCallId,
              providerToolName: call.providerToolName,
              input: call.input
            }]
          },
          {
            role: 'user',
            content: [{
              type: 'tool_result',
              effectId: `probe-effect-${String(attempt)}`,
              toolCallId: call.toolCallId,
              status: 'succeeded',
              output: { result: 5 }
            }]
          }
        ], PROBE_TOOLS);
        const continuationText = assertText(
          continuation,
          'model_probe_tool_continuation_invalid'
        );
        if (!continuationText.includes('5')) throw new Error('model_probe_tool_continuation_invalid');

        assertText(
          await this.infer(input, [
            message('system', 'Answer directly. Do not use a function.'),
            message('user', 'Reply with READY.')
          ], PROBE_TOOLS),
          'model_probe_direct_text_invalid'
        );

        exactSingleToolCall(await this.infer(input, [
          message('system', 'Use the Ariadne control function; do not print JSON.'),
          message('user', 'Ask me which color I prefer.')
        ], [ASK_USER_CONTROL]), ASK_USER_CONTROL.providerToolName);
      }

      stage = 'plan';
      for (let attempt = 0; attempt < REPEATS; attempt += 1) {
        const planCall = exactSingleToolCall(await this.infer(input, [
          message('system', 'Use the plan control function. Every step is read_only.'),
          message('user', 'Create a one-step plan to inspect a document.')
        ], [PLAN_CONTROL]), PLAN_CONTROL.providerToolName);
        if (!isValidPlanInput(planCall.input)) throw new Error('model_probe_plan_control_invalid');
      }

      if (input.probeVision === true) {
        stage = 'vision';
        for (let attempt = 0; attempt < REPEATS; attempt += 1) {
          const vision = assertText(await this.infer(input, [{
            role: 'user',
            content: [
              { type: 'text', text: 'Reply with IMAGE_OK after inspecting this image.' },
              {
                type: 'image',
                attachmentId: 'sha256:431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460',
                mediaType: 'image/png',
                dataBase64: ONE_PIXEL_PNG_BASE64,
                bytes: 68,
                width: 1,
                height: 1
              }
            ]
          }], []));
          if (!vision.includes('IMAGE_OK')) throw new Error('model_probe_vision_invalid');
        }
      }

      const report: ModelCapabilityQualification = {
        ...testing,
        textResponse: 'qualified',
        streamingText: streamed ? 'qualified' : 'rejected',
        nativeToolCalls: 'qualified',
        validToolArguments: 'qualified',
        toolSelection: 'qualified',
        toolResultContinuation: 'qualified',
        directTextInAgent: 'qualified',
        ariadneControlCalls: 'qualified',
        planControlCalls: 'qualified',
        visionInput: input.probeVision === true ? 'qualified' : testing.visionInput,
        testedAt: new Date().toISOString(),
        evidenceDigest: evidenceDigest({ repeats: REPEATS, streamed })
      };
      this.registry.write(report);
      return report;
    } catch (error) {
      const failureCode = probeFailureCode(error);
      const report: ModelCapabilityQualification = {
        ...testing,
        textResponse: stage === 'text' ? 'rejected' : 'qualified',
        streamingText: stage === 'text' ? 'rejected' : streamed ? 'qualified' : 'rejected',
        nativeToolCalls: stage === 'text' ? 'unknown' : stage === 'agent' ? 'rejected' : 'qualified',
        validToolArguments: stage === 'text' ? 'unknown' : stage === 'agent' ? 'rejected' : 'qualified',
        toolSelection: stage === 'text' ? 'unknown' : stage === 'agent' ? 'rejected' : 'qualified',
        toolResultContinuation: stage === 'text' ? 'unknown' : stage === 'agent' ? 'rejected' : 'qualified',
        directTextInAgent: stage === 'text' ? 'unknown' : stage === 'agent' ? 'rejected' : 'qualified',
        ariadneControlCalls: stage === 'text' ? 'unknown' : stage === 'agent' ? 'rejected' : 'qualified',
        planControlCalls: stage === 'text'
          ? 'unknown'
          : stage === 'agent'
            ? 'rejected'
            : stage === 'plan'
              ? 'rejected'
              : 'qualified',
        visionInput: stage === 'vision' ? 'rejected' : testing.visionInput,
        testedAt: new Date().toISOString(),
        evidenceDigest: evidenceDigest({ failureCode, stage, streamed }),
        failureCode
      };
      this.registry.write(report);
      return report;
    }
  }

  private infer(
    input: {
      readonly binding: DispatchExactAgentModelInferenceRequest['binding'];
      readonly signal: AbortSignal;
    },
    messages: DispatchExactAgentModelInferenceRequest['messages'],
    tools: readonly ExactAgentModelInferenceToolContract[],
    observer?: { observe: NonNullable<DispatchExactAgentModelInferenceRequest['chunkObserver']>['observe'] }
  ) {
    return this.models.inferExact({
      binding: input.binding,
      messages,
      tools,
      signal: input.signal,
      sampling: SAMPLING,
      ...(observer === undefined ? {} : { chunkObserver: observer })
    }).then((result) => {
      if (result.status !== 'completed') throw new Error(`model_probe_${result.status}`);
      return result;
    });
  }
}

const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function existingVisionState(
  state: ModelCapabilityQualification['visionInput']
): ModelCapabilityQualification['visionInput'] {
  return state === 'testing' ? 'unknown' : state;
}

function message(role: 'system' | 'user', text: string) {
  return { role, content: [{ type: 'text' as const, text }] } as const;
}

function assertText(result: {
  readonly replay: { readonly finishReason: string };
  readonly contentBlocks: readonly ExactAgentModelInferenceContentBlock[];
}, failureCode = 'model_probe_text_invalid'): string {
  const calls = result.contentBlocks.filter((block) => block.type === 'tool_call');
  const text = result.contentBlocks
    .filter((block): block is Extract<ExactAgentModelInferenceContentBlock, { type: 'text' }> => (
      block.type === 'text'
    ))
    .map((block) => block.text)
    .join('');
  if (result.replay.finishReason !== 'stop' || calls.length !== 0 || text.trim().length === 0) {
    throw new Error(failureCode);
  }
  return text;
}

function exactSingleToolCall(result: {
  readonly replay: { readonly finishReason: string };
  readonly contentBlocks: readonly ExactAgentModelInferenceContentBlock[];
}, expectedName: string): Extract<ExactAgentModelInferenceContentBlock, { type: 'tool_call' }> {
  const calls = result.contentBlocks.filter((block): block is Extract<
    ExactAgentModelInferenceContentBlock,
    { type: 'tool_call' }
  > => block.type === 'tool_call');
  const text = result.contentBlocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  if (
    result.replay.finishReason !== 'tool_calls'
    || calls.length !== 1
    || calls[0]!.providerToolName !== expectedName
    || text.trim().length !== 0
  ) throw new Error('model_probe_native_tool_invalid');
  return calls[0]!;
}

function tool(
  providerToolName: string,
  description: string,
  inputSchema: AgentToolJsonValue
): ExactAgentModelInferenceToolContract {
  return Object.freeze({ providerToolName, description, inputSchema });
}

function isExactCalculation(value: AgentToolJsonValue): boolean {
  return isJsonObject(value)
    && Object.keys(value).length === 2
    && value.left === 2
    && value.right === 3;
}

function isValidPlanInput(value: AgentToolJsonValue): boolean {
  if (!isJsonObject(value)) return false;
  const plan = value.plan;
  if (plan === undefined || !isJsonObject(plan)) return false;
  return typeof plan.summary === 'string'
    && plan.summary.trim().length > 0
    && typeof plan.impactSummary === 'string'
    && plan.impactSummary.trim().length > 0
    && Array.isArray(plan.steps)
    && plan.steps.length > 0
    && plan.steps.every((step: AgentToolJsonValue) => (
      isJsonObject(step)
      && step.impact === 'read_only'
    ));
}

function isJsonObject(
  value: AgentToolJsonValue
): value is { readonly [key: string]: AgentToolJsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function evidenceDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function probeFailureCode(error: unknown): string {
  if (error instanceof Error && /^[a-z0-9_]{1,128}$/u.test(error.message)) return error.message;
  return 'model_capability_probe_failed';
}
