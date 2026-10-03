import { createHash } from 'node:crypto';
import {
  cloneCanonicalAgentToolInput,
  sameAgentPinnedToolIdentity,
  type AgentCommittedDirective,
  type AgentEffectExecutionInputReader,
  type AgentInferenceAttempt,
  type AgentJsonValue,
  type AgentTurn,
  type AgentTurnInput
} from '@ariadne/agent-core';
import type { ExactAgentModelInferenceMessage, ExactAgentModelInferenceRequestContentBlock } from '../../control/ports/AgentModelInference.js';
import { type V3ModelContextGroup } from './V3LongContextLifecycle.js';
import type { ConversationAttachmentReader, OwnedConversationImageAttachment } from '../../control/ports/ConversationAttachmentStore.js';
import {
  INTERNAL_DIRECTIVE_PROTOCOL,
  MODEL_BINDING_ERROR,
  type PreparedToolContract,
  SUBAGENT_RESULTS_FORMAT,
  canonicalJson,
  deterministicFailure,
  invalidBoundModelHistory
} from './AgentModelProtocol.js';

type BoundModelHistoryEntry =
  | {
      readonly kind: 'message';
      readonly message: ExactAgentModelInferenceMessage;
    }
  | {
      readonly kind: 'effect_exchange';
      readonly directive: Extract<AgentCommittedDirective, { readonly kind: 'invoke_tools' }>;
      readonly results: readonly {
        readonly effectId: string;
        readonly toolCallId: string;
        readonly status: 'succeeded' | 'failed' | 'cancelled';
        readonly result: AgentJsonValue;
      }[];
    }
  | {
      readonly kind: 'image';
      readonly image: OwnedConversationImageAttachment;
    };

export function groupModelHistory(messages: readonly ExactAgentModelInferenceMessage[]): {
  readonly pinned: readonly ExactAgentModelInferenceMessage[];
  readonly groups: readonly V3ModelContextGroup[];
} {
  const pinned = messages.filter((message) => message.role === 'system');
  const causal = messages.filter((message) => message.role !== 'system');
  const groups: V3ModelContextGroup[] = [];
  for (let index = 0; index < causal.length; index += 1) {
    const current = causal[index]!;
    const next = causal[index + 1];
    if (
      current.role === 'assistant'
      && current.content.length > 0
      && current.content.every((block) => block.type === 'tool_call')
      && next?.role === 'user'
      && next.content.length > 0
      && next.content.every((block) => block.type === 'tool_result')
      && exactToolExchangeIdsMatch(current, next)
    ) {
      groups.push({ kind: 'tool_exchange', messages: [current, next] });
      index += 1;
      continue;
    }
    if (
      current.role === 'user'
      && next?.role === 'assistant'
      && next.content.every((block) => block.type !== 'tool_call')
    ) {
      groups.push({ kind: 'conversation', messages: [current, next] });
      index += 1;
      continue;
    }
    groups.push({ kind: 'conversation', messages: [current] });
  }
  if (groups.length === 0) throw invalidBoundModelHistory();
  return { pinned, groups };
}

function exactToolExchangeIdsMatch(
  assistant: ExactAgentModelInferenceMessage,
  result: ExactAgentModelInferenceMessage
): boolean {
  const callIds = assistant.content.map((block) => (
    block.type === 'tool_call' ? block.toolCallId : null
  ));
  const resultIds = result.content.map((block) => (
    block.type === 'tool_result' ? block.toolCallId : null
  ));
  return callIds.length === resultIds.length
    && callIds.every((id, index) => id !== null && id === resultIds[index]);
}

export function textMessage(
  role: ExactAgentModelInferenceMessage['role'],
  text: string
): ExactAgentModelInferenceMessage {
  return Object.freeze({
    role,
    content: Object.freeze([{ type: 'text' as const, text }])
  });
}

export function prepareBoundModelHistory(
  input: AgentTurnInput
): readonly BoundModelHistoryEntry[] {
  const current = requireCurrentSchedulableAttempt(input);
  const turns = input.run.turns.slice(0, current.turnIndex + 1);
  const appendedCount = turns.slice(1).reduce((count, turn) => {
    const cause = turn.intention.cause;
    return count + (cause.kind === 'effect_results'
      ? cause.effectIds.length + (cause.inboxInputIds?.length ?? 0)
      : cause.kind === 'inbox_inputs'
        ? 1 + cause.inputIds.length
        : cause.kind === 'interrupted_inference'
          ? 1 + cause.inputIds.length
        : cause.kind === 'child_results'
          ? 2
        : Number.POSITIVE_INFINITY);
  }, 0);
  const baseCount = input.messages.length - appendedCount;
  if (!Number.isSafeInteger(baseCount) || baseCount < 1) throw invalidBoundModelHistory();
  const history: BoundModelHistoryEntry[] = [];
  for (let index = 0; index < baseCount; index += 1) {
    const message = input.messages[index];
    if (message?.kind === 'text') {
      history.push({ kind: 'message', message: textMessage(message.role, message.content) });
      continue;
    }
    if (message?.kind === 'image') {
      history.push({
        kind: 'image',
        image: {
          owner: { ...message.owner },
          ref: {
            ...message.attachment,
            ...(message.attachment.originalDimensions === undefined
              ? {}
              : { originalDimensions: { ...message.attachment.originalDimensions } })
          }
        }
      });
      continue;
    }
    throw invalidBoundModelHistory();
  }

  let messageIndex = baseCount;
  for (const turn of turns.slice(1)) {
    const cause = turn.intention.cause;
    if (cause.kind === 'inbox_inputs') {
      const batch = input.messages.slice(
        messageIndex,
        messageIndex + 1 + cause.inputIds.length
      );
      if (
        batch.length !== 1 + cause.inputIds.length
        || batch.some((message) => message.kind !== 'text')
        || batch[0]?.kind !== 'text'
        || batch[0].role !== 'assistant'
        || batch.slice(1).some((message) => message.kind !== 'text' || message.role !== 'user')
      ) throw invalidBoundModelHistory();
      for (const message of batch) {
        if (message.kind !== 'text') throw invalidBoundModelHistory();
        history.push({
          kind: 'message',
          message: textMessage(message.role, message.content)
        });
      }
      messageIndex += batch.length;
      continue;
    }
    if (cause.kind === 'interrupted_inference') {
      const batch = input.messages.slice(
        messageIndex,
        messageIndex + 1 + cause.inputIds.length
      );
      const sourceTurn = input.run.turns.find(
        (candidate) => candidate.turnId === cause.sourceTurnId
      );
      const sourceAttempt = sourceTurn?.attempts.find(
        (candidate) => candidate.attemptId === cause.sourceAttemptId
      );
      if (
        batch.length !== 1 + cause.inputIds.length
        || batch[0]?.kind !== 'text'
        || batch[0].role !== 'system'
        || sourceAttempt?.state.status !== 'uncertain'
        || sourceAttempt.state.recovery.decisionId !== cause.recoveryDecisionId
        || batch.slice(1).some((message) => (
          message.kind !== 'text'
          || (message.role !== 'user' && message.role !== 'system')
        ))
      ) throw invalidBoundModelHistory();
      for (const message of batch) {
        if (message.kind !== 'text') throw invalidBoundModelHistory();
        history.push({ kind: 'message', message: textMessage(message.role, message.content) });
      }
      messageIndex += batch.length;
      continue;
    }
    if (cause.kind === 'child_results') {
      const batch = input.messages.slice(messageIndex, messageIndex + 2);
      if (
        batch.length !== 2
        || batch[0]?.kind !== 'text'
        || batch[0].role !== 'assistant'
        || batch[1]?.kind !== 'text'
        || batch[1].role !== 'user'
      ) throw invalidBoundModelHistory();
      verifyChildResultTextBatch(input, turn, batch[0].content, batch[1].content);
      history.push(
        { kind: 'message', message: textMessage('assistant', batch[0].content) },
        { kind: 'message', message: textMessage('user', batch[1].content) }
      );
      messageIndex += 2;
      continue;
    }
    if (cause.kind !== 'effect_results') throw invalidBoundModelHistory();
    const batchSize = cause.effectIds.length;
    const batch = input.messages.slice(messageIndex, messageIndex + batchSize);
    if (
      batch.length !== batchSize
      || batch.some((message) => message.kind !== 'effect_result')
    ) {
      throw invalidBoundModelHistory();
    }
    const verified = verifyEffectResultBatch(
      input,
      turn,
      batch as readonly Extract<
        AgentTurnInput['messages'][number],
        { readonly kind: 'effect_result' }
      >[]
    );
    history.push({
      kind: 'effect_exchange',
      directive: verified.directive,
      results: verified.results
    });
    messageIndex += batchSize;
    const inboxInputCount = cause.inboxInputIds?.length ?? 0;
    const inboxMessages = input.messages.slice(
      messageIndex,
      messageIndex + inboxInputCount
    );
    if (
      inboxMessages.length !== inboxInputCount
      || inboxMessages.some((message) => message.kind !== 'text' || message.role !== 'user')
    ) {
      throw invalidBoundModelHistory();
    }
    for (const message of inboxMessages) {
      if (message.kind !== 'text') throw invalidBoundModelHistory();
      history.push({ kind: 'message', message: textMessage('user', message.content) });
    }
    messageIndex += inboxInputCount;
  }
  if (messageIndex !== input.messages.length) throw invalidBoundModelHistory();
  return history;
}

export async function materializeBoundModelHistory(
  runId: string,
  entries: readonly BoundModelHistoryEntry[],
  tools: readonly PreparedToolContract[],
  effectInputs: AgentEffectExecutionInputReader | undefined,
  attachments: ConversationAttachmentReader | undefined,
  signal: AbortSignal
): Promise<readonly ExactAgentModelInferenceMessage[]> {
  const history: ExactAgentModelInferenceMessage[] = [];
  const requestToolCallIds = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === 'message') {
      history.push(entry.message);
      continue;
    }
    if (entry.kind === 'image') {
      if (attachments === undefined) {
        throw deterministicFailure(
          MODEL_BINDING_ERROR,
          'Durable Conversation attachments are unavailable for exact model history.'
        );
      }
      let stored;
      try {
        stored = await attachments.readOwnedImage(entry.image, signal);
      } catch {
        signal.throwIfAborted();
        throw deterministicFailure(
          MODEL_BINDING_ERROR,
          'A durable Conversation attachment could not be verified.'
        );
      }
      history.push(Object.freeze({
        role: 'user',
        content: Object.freeze([{
          type: 'image' as const,
          attachmentId: stored.ref.attachmentId,
          mediaType: stored.ref.mediaType,
          dataBase64: Buffer.from(stored.data).toString('base64'),
          bytes: stored.ref.bytes,
          width: stored.ref.width,
          height: stored.ref.height
        }])
      }));
      continue;
    }
    if (effectInputs === undefined) {
      throw deterministicFailure(
        MODEL_BINDING_ERROR,
        'Protected Tool inputs are unavailable for exact model history.'
      );
    }
    const calls: ExactAgentModelInferenceRequestContentBlock[] = [];
    const results: ExactAgentModelInferenceRequestContentBlock[] = [];
    for (let index = 0; index < entry.directive.invocations.length; index += 1) {
      signal.throwIfAborted();
      const invocation = entry.directive.invocations[index]!;
      const result = entry.results[index];
      const tool = tools.find((candidate) => (
        sameAgentPinnedToolIdentity(candidate.tool, invocation.tool)
      ));
      if (
        result === undefined
        || result.effectId !== invocation.effectId
        || result.toolCallId !== invocation.toolCallId
        || tool === undefined
        || !sameStringSequence(invocation.capabilityIds, tool.capabilityIds)
        || (
          tool.scopeSemantics === 'none'
            ? invocation.scope.length !== 0
            : invocation.scope.some((scopeId) => !tool.allowedScopes.includes(scopeId))
        )
      ) throw invalidBoundModelHistory();

      let protectedInput: Awaited<ReturnType<
        AgentEffectExecutionInputReader['loadEffectExecutionInput']
      >>;
      try {
        protectedInput = await effectInputs.loadEffectExecutionInput(
          runId,
          invocation.effectId
        );
      } catch {
        signal.throwIfAborted();
        throw deterministicFailure(
          MODEL_BINDING_ERROR,
          'Protected Tool input could not be resolved for exact model history.'
        );
      }
      signal.throwIfAborted();
      if (
        protectedInput.runId !== runId
        || protectedInput.effectId !== invocation.effectId
        || protectedInput.inputDigest !== invocation.inputDigest
      ) {
        throw deterministicFailure(
          MODEL_BINDING_ERROR,
          'Protected Tool input does not match the committed invocation.'
        );
      }
      const toolCallId = historicalProviderToolCallId(
        runId,
        invocation.effectId,
        invocation.toolCallId
      );
      if (requestToolCallIds.has(toolCallId)) throw invalidBoundModelHistory();
      requestToolCallIds.add(toolCallId);
      calls.push(Object.freeze({
        type: 'tool_call',
        toolCallId,
        providerToolName: tool.providerToolName,
        input: cloneCanonicalAgentToolInput({
          input: protectedInput.input,
          scope: [...invocation.scope]
        }, `modelHistory.toolCalls[${String(index)}].input`)
      }));
      results.push(Object.freeze({
        type: 'tool_result',
        effectId: result.effectId,
        toolCallId,
        status: result.status,
        output: cloneCanonicalAgentToolInput(
          result.result,
          `modelHistory.toolResults[${String(index)}].output`
        )
      }));
    }
    history.push(Object.freeze({ role: 'assistant', content: Object.freeze(calls) }));
    history.push(Object.freeze({ role: 'user', content: Object.freeze(results) }));
  }
  return Object.freeze(history);
}

export function coalesceUserContentMessages(
  messages: readonly ExactAgentModelInferenceMessage[]
): readonly ExactAgentModelInferenceMessage[] {
  const result: ExactAgentModelInferenceMessage[] = [];
  for (const message of messages) {
    const previous = result.at(-1);
    const mergeable = message.role === 'user'
      && message.content.every((block) => block.type === 'text' || block.type === 'image')
      && previous?.role === 'user'
      && previous.content.every((block) => block.type === 'text' || block.type === 'image');
    if (mergeable && previous !== undefined) {
      result[result.length - 1] = Object.freeze({
        role: 'user',
        content: Object.freeze([...previous.content, ...message.content])
      });
    } else {
      result.push(message);
    }
  }
  return Object.freeze(result);
}

function historicalProviderToolCallId(
  runId: string,
  effectId: string,
  toolCallId: string
): string {
  return `history_${createHash('sha256')
    .update(canonicalJson({ runId, effectId, toolCallId }))
    .digest('hex')
    .slice(0, 40)}`;
}

function sameStringSequence(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function verifyChildResultTextBatch(
  input: AgentTurnInput,
  turn: AgentTurn,
  assistantContent: string,
  resultContent: string
): void {
  const cause = turn.intention.cause;
  if (cause.kind !== 'child_results') throw invalidBoundModelHistory();
  const sourceTurn = input.run.turns.find(
    (candidate) => candidate.turnId === cause.sourceTurnId
  );
  const sourceAttempt = sourceTurn?.attempts.find(
    (candidate) => candidate.attemptId === cause.sourceAttemptId
  );
  const committed = sourceAttempt?.state.status === 'succeeded'
    ? sourceAttempt.state.directive.kind === 'delegate_subagent'
      ? [sourceAttempt.state.directive]
      : sourceAttempt.state.directive.kind === 'delegate_subagents'
        ? sourceAttempt.state.directive.delegations
        : []
    : [];
  if (
    sourceAttempt?.state.status !== 'succeeded'
    || sourceAttempt.state.directiveDigest !== cause.sourceDirectiveDigest
    || cause.delegationIds.length !== committed.length
    || cause.childRunIds.length !== committed.length
    || committed.some((item, index) => (
      item.delegationId !== cause.delegationIds[index]
      || item.childRunId !== cause.childRunIds[index]
    ))
  ) throw invalidBoundModelHistory();
  const assistant = parseExactObject(assistantContent);
  const result = parseExactObject(resultContent);
  const delegated = typeof assistant.directive === 'object'
    && assistant.directive !== null
    && !Array.isArray(assistant.directive)
    ? assistant.directive as Record<string, unknown>
    : null;
  const assistantDelegations = delegated?.kind === 'delegate_subagent'
    ? [delegated]
    : delegated?.kind === 'delegate_subagents' && Array.isArray(delegated.delegations)
      ? delegated.delegations
      : [];
  if (
    assistant.protocol !== INTERNAL_DIRECTIVE_PROTOCOL
    || assistantDelegations.length !== committed.length
    || assistantDelegations.some((candidate, index) => {
      const expected = committed[index];
      return typeof candidate !== 'object'
        || candidate === null
        || Array.isArray(candidate)
        || expected === undefined
        || candidate.delegationId !== expected.delegationId
        || candidate.childRunId !== expected.childRunId
        || candidate.objectiveDigest !== expected.objectiveDigest
        || candidate.mode !== expected.mode;
    })
    || result.format !== SUBAGENT_RESULTS_FORMAT
    || result.schemaVersion !== 1
    || !Array.isArray(result.results)
    || result.results.length !== committed.length
  ) throw invalidBoundModelHistory();
  if (result.results.some((child, index) => (
    typeof child !== 'object'
    || child === null
    || Array.isArray(child)
    || child.delegationId !== cause.delegationIds[index]
    || child.childRunId !== cause.childRunIds[index]
    || !Number.isSafeInteger(child.childRunVersion)
    || !['completed', 'failed', 'cancelled'].includes(String(child.status))
    || typeof child.content !== 'string'
    || child.content.length === 0
  ))) throw invalidBoundModelHistory();
}

function parseExactObject(content: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(content);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw invalidBoundModelHistory();
    }
    return value as Record<string, unknown>;
  } catch {
    throw invalidBoundModelHistory();
  }
}

function requireCurrentSchedulableAttempt(input: AgentTurnInput): {
  readonly turn: AgentTurn;
  readonly attempt: AgentInferenceAttempt;
  readonly turnIndex: number;
} {
  const candidates: Array<{
    readonly turn: AgentTurn;
    readonly attempt: AgentInferenceAttempt;
    readonly turnIndex: number;
    readonly attemptIndex: number;
  }> = [];
  input.run.turns.forEach((turn, turnIndex) => {
    turn.attempts.forEach((attempt, attemptIndex) => {
      if (attempt.state.status === 'intended' || attempt.state.status === 'started') {
        candidates.push({ turn, attempt, turnIndex, attemptIndex });
      }
    });
  });
  const current = candidates[0];
  if (
    candidates.length !== 1
    || current === undefined
    || current.turnIndex !== input.run.turns.length - 1
    || current.attemptIndex !== current.turn.attempts.length - 1
  ) {
    throw invalidBoundModelHistory();
  }
  return current;
}

function verifyEffectResultBatch(
  input: AgentTurnInput,
  turn: AgentTurn,
  messages: readonly Extract<
    AgentTurnInput['messages'][number],
    { readonly kind: 'effect_result' }
  >[]
): {
  readonly directive: Extract<AgentCommittedDirective, { readonly kind: 'invoke_tools' }>;
  readonly results: readonly {
    readonly effectId: string;
    readonly toolCallId: string;
    readonly status: 'succeeded' | 'failed' | 'cancelled';
    readonly result: AgentJsonValue;
  }[];
} {
  const cause = turn.intention.cause;
  if (cause.kind !== 'effect_results') throw invalidBoundModelHistory();
  const sourceTurnIndex = input.run.turns.findIndex(
    (candidate) => candidate.turnId === cause.sourceTurnId
  );
  const continuationTurnIndex = input.run.turns.findIndex(
    (candidate) => candidate.turnId === turn.turnId
  );
  const sourceTurn = input.run.turns[sourceTurnIndex];
  const sourceAttempt = sourceTurn?.attempts.find(
    (candidate) => candidate.attemptId === cause.sourceAttemptId
  );
  if (
    sourceTurn === undefined
    || sourceTurnIndex < 0
    || sourceTurnIndex >= continuationTurnIndex
    || sourceAttempt?.state.status !== 'succeeded'
    || sourceAttempt.state.directive.kind !== 'invoke_tools'
    || sourceAttempt.state.directiveDigest !== cause.sourceDirectiveDigest
    || sourceAttempt.state.directive.invocations.length !== cause.effectIds.length
    || messages.length !== cause.effectIds.length
  ) {
    throw invalidBoundModelHistory();
  }

  const results = messages.map((message, index) => {
    const invocation = sourceAttempt.state.status === 'succeeded'
      && sourceAttempt.state.directive.kind === 'invoke_tools'
      ? sourceAttempt.state.directive.invocations[index]
      : undefined;
    const effect = input.run.effects.find(
      (candidate) => candidate.effectId === cause.effectIds[index]
    );
    if (
      invocation === undefined
      || effect === undefined
      || invocation.effectId !== cause.effectIds[index]
      || invocation.toolCallId !== cause.toolCallIds[index]
      || message.effectId !== invocation.effectId
      || message.toolCallId !== invocation.toolCallId
      || effect.toolCallId !== invocation.toolCallId
      || effect.origin?.turnId !== cause.sourceTurnId
      || effect.origin.attemptId !== cause.sourceAttemptId
      || effect.origin.directiveDigest !== cause.sourceDirectiveDigest
      || (
        effect.state.status !== 'succeeded'
        && effect.state.status !== 'failed'
        && effect.state.status !== 'cancelled'
      )
      || message.status !== effect.state.status
    ) {
      throw invalidBoundModelHistory();
    }
    return {
      effectId: message.effectId,
      toolCallId: message.toolCallId,
      status: message.status,
      result: cloneCanonicalAgentToolInput(
        message.result,
        `engineInput.effectResults[${String(index)}].result`
      )
    };
  });
  return {
    directive: sourceAttempt.state.directive,
    results
  };
}
