import { createHash } from 'node:crypto';
import {
  assertValidAgentRun,
  canonicalizeAgentTurnInput,
  type AgentRunBinding,
  type AgentSubagentProviderBinding,
  type AgentTurnInput
} from '@ariadne/agent-core';
import type { ExactAgentModelInferenceMessage, ExactAgentModelInferenceToolContract } from '../../control/ports/AgentModelInference.js';
import { type V3LongContextUsageBaseline } from './V3LongContextLifecycle.js';
import {
  MAX_MODEL_REQUEST_BYTES,
  MAX_MODEL_REQUEST_MESSAGES,
  MAX_PROTOCOL_PROMPT_BYTES,
  MODEL_BINDING_ERROR,
  TOOL_CONTRACT_ERROR,
  canonicalJson,
  deterministicFailure,
  invalidBoundModelHistory
} from './AgentModelProtocol.js';

export function splitPublicUtf8Text(value: string): readonly string[] {
  if (value.length === 0) return [];
  const parts: string[] = [];
  let start = 0;
  while (start < value.length) {
    let end = Math.min(value.length, start + 32 * 1_024);
    while (
      end > start
      && Buffer.byteLength(value.slice(start, end), 'utf8') > 32 * 1_024
    ) end -= 1;
    if (end === start) throw new Error('agent_public_stream_chunk_unrepresentable');
    parts.push(value.slice(start, end));
    start = end;
  }
  return parts;
}

export function openInferenceIdentity(input: AgentTurnInput): {
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly attemptId: string;
} {
  const intended = input.run.turns.flatMap((turn) => turn.attempts
    .filter((attempt) => attempt.state.status === 'intended')
    .map((attempt) => ({ turnId: turn.turnId, attemptId: attempt.attemptId })));
  if (intended.length !== 1) {
    throw deterministicFailure(
      MODEL_BINDING_ERROR,
      'AgentEngine requires one exact intended inference attempt identity.'
    );
  }
  return {
    sessionId: input.run.binding.sessionId,
    runId: input.run.runId,
    ...intended[0]!
  };
}

export function assertPreparedModelRequest(
  modelId: string,
  messages: readonly ExactAgentModelInferenceMessage[],
  tools: readonly ExactAgentModelInferenceToolContract[]
): void {
  // This deliberately double-counts System content, so it is an upper bound
  // for both exact OpenAI-compatible and Anthropic text transports.
  const conservativeEnvelope = JSON.stringify({
    model: modelId,
    max_tokens: 4_096,
    system: messages
      .filter((message) => message.role === 'system')
      .flatMap((message) => message.content)
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n\n'),
    messages,
    tools,
    stream: false
  });
  if (new TextEncoder().encode(conservativeEnvelope).byteLength > MAX_MODEL_REQUEST_BYTES) {
    throw invalidBoundModelHistory();
  }
  if (messages.length > MAX_MODEL_REQUEST_MESSAGES) throw invalidBoundModelHistory();
}

export function digestTokenMeterHeader(
  binding: AgentRunBinding['model'],
  pinnedMessages: readonly ExactAgentModelInferenceMessage[],
  tools: readonly ExactAgentModelInferenceToolContract[]
): string {
  const encoded = canonicalJson({
    protocol: 'ariadne.token-meter-header.v1',
    providerId: binding.providerId,
    modelId: binding.modelId,
    settingsRevision: binding.settingsRevision,
    inference: binding.inference === undefined
      ? null
      : {
          reasoningMode: binding.inference.reasoningMode ?? null,
          reasoningEffort: binding.inference.reasoningEffort ?? null
        },
    pinnedMessages: pinnedMessages.map((message) => ({
      role: message.role,
      content: message.content
    })),
    tools: tools.map((tool) => ({
      providerToolName: tool.providerToolName,
      description: tool.description,
      inputSchema: tool.inputSchema
    }))
  });
  return `sha256:${createHash('sha256').update(encoded).digest('hex')}`;
}

export function findUsageBaseline(
  input: AgentTurnInput,
  requestHeaderDigest: string
): V3LongContextUsageBaseline | undefined {
  for (let turnIndex = input.run.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const attempts = input.run.turns[turnIndex]!.attempts;
    for (let attemptIndex = attempts.length - 1; attemptIndex >= 0; attemptIndex -= 1) {
      const attempt = attempts[attemptIndex]!;
      if (attempt.state.status !== 'succeeded') continue;
      const anchor = attempt.state.usageAnchor;
      if (
        anchor === undefined
        || anchor.providerId !== input.run.binding.model.providerId
        || anchor.modelId !== input.run.binding.model.modelId
        || anchor.settingsRevision !== input.run.binding.model.settingsRevision
        || anchor.requestHeaderDigest !== requestHeaderDigest
      ) continue;
      return {
        attemptId: attempt.attemptId,
        anchor: { ...anchor }
      };
    }
  }
  return undefined;
}

export function validateBoundInput(input: AgentTurnInput): void {
  try {
    assertValidAgentRun(input.run);
    canonicalizeAgentTurnInput({
      messages: input.messages,
      availableTools: input.availableTools
    });
  } catch {
    throw deterministicFailure(
      MODEL_BINDING_ERROR,
      'AgentEngine received an invalid or unbound Run input.'
    );
  }
}

export function renderNativeAgentPrompt(
  executionMode: 'chat' | 'agent' | 'plan',
  subagentProviders: readonly AgentSubagentProviderBinding[]
): string {
  const prompt = [
    `Ariadne execution mode: ${executionMode}.`,
    'Return ordinary natural-language text when the task is complete or when no function is needed.',
    'Use only the advertised native functions for tools and Ariadne control actions.',
    'Never print a function call, arguments, command, or control action as JSON or prose.',
    'Do not combine ordinary response text with a function call in the same decision.',
    ...(executionMode === 'plan'
      ? ['Plan mode must finish by calling ariadne_control_propose_plan; it must not perform workspace changes.']
      : []),
    ...(executionMode === 'agent' && subagentProviders.length > 0
      ? [`Available SubAgent providers: ${subagentProviders.map((provider) => provider.providerId).join(', ')}.`]
      : [])
  ].join('\n');
  if (new TextEncoder().encode(prompt).byteLength > MAX_PROTOCOL_PROMPT_BYTES) {
    throw deterministicFailure(
      TOOL_CONTRACT_ERROR,
      'The exact model-visible Tool contract prompt exceeds its bounded size.'
    );
  }
  return prompt;
}
