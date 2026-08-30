import { createHash } from 'node:crypto';

import type {
  AgentInferenceUsageAnchorV1,
  AgentJsonValue
} from '@ariadne/agent-core';

import type {
  ExactAgentModelContextCapacity,
  ExactAgentModelInferenceMessage,
  ExactAgentModelInferenceRequestContentBlock
} from '../../control/ports/AgentModelInference.js';
import {
  compactSemanticContext,
  SEMANTIC_COMPACTION_PROTOCOL,
  type SemanticContextCompactionProjection
} from './DeterministicSemanticContextCompactor.js';

const TOOL_RESULT_SPILL_PROTOCOL = 'ariadne.tool-result-spill.v1';
const PRESSURE_RATIO = 0.8;
const RECOVERY_RATIO = 0.55;
const RETAINED_TAIL_RATIO = 0.16;
const TOKEN_BYTES = 3;

export interface V3ModelContextGroup {
  readonly kind: 'conversation' | 'tool_exchange';
  readonly messages: readonly ExactAgentModelInferenceMessage[];
}

export interface V3LongContextPlan {
  readonly modelContext: AgentJsonValue;
  readonly primaryMessages: readonly ExactAgentModelInferenceMessage[];
  readonly overflowRecoveryMessages: readonly ExactAgentModelInferenceMessage[] | null;
  readonly requestHeaderDigest: string;
  readonly primaryMeteredTokens: number;
  readonly overflowRecoveryMeteredTokens: number | null;
}

interface CompactionResult {
  readonly messages: readonly ExactAgentModelInferenceMessage[];
  readonly omittedGroups: number;
  readonly omittedMessages: number;
  readonly prunedToolResults: number;
  readonly estimatedTokens: number;
  readonly heuristicTokens: number;
  readonly semanticCompaction: SemanticContextCompactionProjection | null;
}

export interface V3LongContextUsageBaseline {
  readonly attemptId: string;
  readonly anchor: AgentInferenceUsageAnchorV1;
}

/**
 * Deterministic v3 context lifecycle. Full protected Turn input remains the
 * source of truth; only the exact Provider projection is compacted. The same
 * input and exact capacity always produce the same primary and overflow-
 * recovery requests, so both digests can cross the durable start boundary.
 */
export function planV3LongContext(input: {
  readonly pinnedMessages: readonly ExactAgentModelInferenceMessage[];
  readonly groups: readonly V3ModelContextGroup[];
  readonly capacity: ExactAgentModelContextCapacity;
  readonly requestHeaderDigest: string;
  /** Frozen Provider request fields outside messages, such as native Tool schemas. */
  readonly fixedOverheadTokens?: number;
  readonly sourceTokenCount?: {
    readonly tokens: number;
    readonly exact: boolean;
    readonly tokenizer: string;
  };
  readonly usageBaseline?: V3LongContextUsageBaseline;
}): V3LongContextPlan {
  assertCapacity(input.capacity);
  if (!/^sha256:[a-f0-9]{64}$/u.test(input.requestHeaderDigest)) {
    throw new Error('agent_model_context_request_header_invalid');
  }
  if (input.pinnedMessages.length === 0 || input.groups.length === 0) {
    throw new Error('agent_model_context_source_invalid');
  }
  const fixedOverheadTokens = input.fixedOverheadTokens ?? 0;
  if (!Number.isSafeInteger(fixedOverheadTokens) || fixedOverheadTokens < 0) {
    throw new Error('agent_model_context_fixed_overhead_invalid');
  }
  const full = [...input.pinnedMessages, ...input.groups.flatMap((group) => group.messages)];
  const sourceDigest = digestMessages(full);
  const correctionTokens = usageCorrection(input.requestHeaderDigest, input.usageBaseline);
  const fullHeuristicTokens = estimateMessagesTokens(full) + fixedOverheadTokens;
  const fullTokens = input.sourceTokenCount === undefined
    ? meteredTokens(full, correctionTokens, fixedOverheadTokens)
    : Math.max(
        1,
        input.sourceTokenCount.tokens + (input.sourceTokenCount.exact ? 0 : correctionTokens)
      );
  const pressureLimit = Math.min(
    Math.floor(input.capacity.contextWindowTokens * PRESSURE_RATIO),
    input.capacity.contextWindowTokens - input.capacity.maxOutputTokens
  );
  const recoveryLimit = Math.min(
    Math.floor(input.capacity.contextWindowTokens * RECOVERY_RATIO),
    input.capacity.contextWindowTokens - input.capacity.maxOutputTokens
  );
  if (pressureLimit < 1 || recoveryLimit < 1) {
    throw new Error('agent_model_context_capacity_invalid');
  }

  const primary = fullTokens <= pressureLimit
    ? {
        messages: full,
        omittedGroups: 0,
        omittedMessages: 0,
        prunedToolResults: 0,
        estimatedTokens: fullTokens,
        heuristicTokens: fullHeuristicTokens,
        semanticCompaction: null
      }
    : compact(
        input.pinnedMessages,
        input.groups,
        pressureLimit,
        input.capacity,
        4_096,
        correctionTokens,
        fixedOverheadTokens
      );
  let recovery: CompactionResult | null = null;
  try {
    recovery = compact(
      input.pinnedMessages,
      input.groups,
      recoveryLimit,
      input.capacity,
      1_024,
      correctionTokens,
      fixedOverheadTokens
    );
  } catch {
    // A valid primary projection remains usable. Provider overflow will become
    // a deterministic exhausted-context result instead of an unsafe retry.
  }
  const primaryDigest = digestMessages(primary.messages);
  const recoveryDigest = recovery === null ? null : digestMessages(recovery.messages);
  const hasDistinctRecovery = recoveryDigest !== null && recoveryDigest !== primaryDigest;

  return {
    primaryMessages: primary.messages,
    overflowRecoveryMessages: hasDistinctRecovery && recovery !== null
      ? recovery.messages
      : null,
    requestHeaderDigest: input.requestHeaderDigest,
    primaryMeteredTokens: primary.heuristicTokens,
    overflowRecoveryMeteredTokens: hasDistinctRecovery && recovery !== null
      ? recovery.heuristicTokens
      : null,
    modelContext: {
      format: 'ariadne.model-context',
      schemaVersion: 1,
      lifecycle: primary.omittedMessages === 0 && primary.prunedToolResults === 0
        ? 'full'
        : 'compacted',
      sourceDigest,
      primaryRequestDigest: primaryDigest,
      overflowRecoveryRequestDigest: hasDistinctRecovery ? recoveryDigest : null,
      contextWindowTokens: input.capacity.contextWindowTokens,
      maxOutputTokens: input.capacity.maxOutputTokens,
      pressureThresholdTokens: pressureLimit,
      sourceEstimatedTokens: fullTokens,
      primaryEstimatedTokens: primary.estimatedTokens,
      fixedOverheadTokens,
      tokenMeter: input.usageBaseline === undefined
        ? {
            protocol: 'ariadne.token-meter.v1',
            baseline: input.sourceTokenCount?.exact === true ? 'local_tokenizer' : 'estimated',
            requestHeaderDigest: input.requestHeaderDigest,
            tokenizer: input.sourceTokenCount?.tokenizer ?? 'ariadne:utf8-envelope-conservative',
            tokenizerExact: input.sourceTokenCount?.exact ?? false,
            correctionTokens: 0
          }
        : {
            protocol: 'ariadne.token-meter.v1',
            baseline: 'provider_usage',
            requestHeaderDigest: input.requestHeaderDigest,
            anchorAttemptId: input.usageBaseline.attemptId,
            anchorRequestEnvelopeDigest: input.usageBaseline.anchor.requestEnvelopeDigest,
            anchorEstimatedInputTokens: input.usageBaseline.anchor.estimatedInputTokens,
            anchorProviderContextInputTokens: contextInputTokens(input.usageBaseline.anchor),
            tokenizer: input.sourceTokenCount?.tokenizer ?? 'ariadne:utf8-envelope-conservative',
            tokenizerExact: input.sourceTokenCount?.exact ?? false,
            correctionTokens
          },
      omittedGroups: primary.omittedGroups,
      omittedMessages: primary.omittedMessages,
      prunedToolResults: primary.prunedToolResults,
      semanticCompaction: primary.semanticCompaction === null
        ? null
        : {
            protocol: SEMANTIC_COMPACTION_PROTOCOL,
            sourceDigest: primary.semanticCompaction.sourceDigest,
            summaryDigest: primary.semanticCompaction.summaryDigest,
            sourceItems: primary.semanticCompaction.sourceItems,
            selectedItems: primary.semanticCompaction.selectedItems,
            omittedItems: primary.semanticCompaction.omittedItems,
            summaryCharacters: primary.semanticCompaction.summaryCharacters
          },
      overflowRecoveryPrepared: hasDistinctRecovery
    }
  };
}

function compact(
  pinned: readonly ExactAgentModelInferenceMessage[],
  groups: readonly V3ModelContextGroup[],
  limit: number,
  capacity: ExactAgentModelContextCapacity,
  initialSummaryCharacters: 1_024 | 4_096,
  correctionTokens: number,
  fixedOverheadTokens: number
): CompactionResult {
  const pinnedTokens = meteredTokens(pinned, correctionTokens, fixedOverheadTokens);
  if (pinnedTokens >= limit) throw new Error('agent_model_pinned_context_exceeds_capacity');
  const tailTarget = Math.max(1, Math.floor(capacity.contextWindowTokens * RETAINED_TAIL_RATIO));
  const retained: V3ModelContextGroup[] = [];
  let retainedTokens = 0;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index]!;
    const tokens = estimateMessagesTokens(group.messages);
    if (retained.length > 0 && retainedTokens + tokens > tailTarget) break;
    retained.unshift(group);
    retainedTokens += tokens;
  }
  if (retained.length === 0) retained.push(groups.at(-1)!);

  let retainedStart = groups.length - retained.length;
  let prunedToolResults = 0;
  let retainedMessages: readonly ExactAgentModelInferenceMessage[] = retained.flatMap(
    (group) => group.messages
  );
  while (
    meteredTokens(
      [...pinned, ...retainedMessages],
      correctionTokens,
      fixedOverheadTokens
    ) >= limit
    && retained.length > 1
  ) {
    retained.shift();
    retainedStart += 1;
    retainedMessages = retained.flatMap((group) => group.messages);
  }
  if (meteredTokens(
    [...pinned, ...retainedMessages],
    correctionTokens,
    fixedOverheadTokens
  ) >= limit) {
    const latest = retained[0]!;
    if (latest.kind !== 'tool_exchange') {
      throw new Error('agent_model_current_objective_exceeds_context_capacity');
    }
    const pruned = pruneToolExchange(latest, Math.max(256, limit - pinnedTokens));
    retainedMessages = pruned.messages;
    prunedToolResults = pruned.prunedToolResults;
  }

  const omitted = groups.slice(0, retainedStart);
  let summaryCharacters: number = initialSummaryCharacters;
  let semanticCompaction = omitted.length === 0
    ? null
    : compactSemanticContext(omitted, summaryCharacters);
  let messages = [
    ...pinned,
    ...(semanticCompaction === null ? [] : [semanticCompaction.message]),
    ...retainedMessages
  ];
  while (
    meteredTokens(messages, correctionTokens, fixedOverheadTokens) > limit
    && semanticCompaction !== null
    && summaryCharacters > 640
  ) {
    summaryCharacters = nextSemanticSummaryBudget(summaryCharacters);
    semanticCompaction = compactSemanticContext(omitted, summaryCharacters);
    messages = [...pinned, semanticCompaction.message, ...retainedMessages];
  }
  if (meteredTokens(messages, correctionTokens, fixedOverheadTokens) > limit) {
    throw new Error('agent_model_compacted_context_exceeds_capacity');
  }
  return {
    messages,
    omittedGroups: omitted.length,
    omittedMessages: omitted.reduce((count, group) => count + group.messages.length, 0),
    prunedToolResults,
    estimatedTokens: meteredTokens(messages, correctionTokens, fixedOverheadTokens),
    heuristicTokens: estimateMessagesTokens(messages) + fixedOverheadTokens,
    semanticCompaction
  };
}

/**
 * Re-admits the two concrete Provider projections with the same route-bound
 * tokenizer used for the source request. Planning remains deterministic and
 * synchronous; this boundary prevents a heuristic compacted request from
 * crossing the exact configured input capacity.
 */
export function admitV3TokenizedProjections(input: {
  readonly plan: V3LongContextPlan;
  readonly capacity: ExactAgentModelContextCapacity;
  readonly primary: {
    readonly tokens: number;
    readonly exact: boolean;
    readonly tokenizer: string;
  };
  readonly recovery: {
    readonly tokens: number;
    readonly exact: boolean;
    readonly tokenizer: string;
  } | null;
}): V3LongContextPlan {
  assertCapacity(input.capacity);
  assertTokenCount(input.primary);
  if (input.recovery !== null) assertTokenCount(input.recovery);
  if (
    input.recovery !== null
    && (
      input.recovery.exact !== input.primary.exact
      || input.recovery.tokenizer !== input.primary.tokenizer
    )
  ) throw new Error('agent_model_projection_tokenizer_mismatch');

  const hardInputLimit = input.capacity.contextWindowTokens - input.capacity.maxOutputTokens;
  if (hardInputLimit < 1) throw new Error('agent_model_context_capacity_invalid');
  const primaryFits = input.primary.tokens <= hardInputLimit;
  const recoveryFits = input.recovery !== null
    && input.plan.overflowRecoveryMessages !== null
    && input.recovery.tokens <= hardInputLimit;
  if (!primaryFits && !recoveryFits) {
    throw new Error('agent_model_tokenized_projection_exceeds_capacity');
  }

  const promoteRecovery = !primaryFits;
  const retainRecovery = !promoteRecovery && recoveryFits;
  const selectedMessages = promoteRecovery
    ? input.plan.overflowRecoveryMessages!
    : input.plan.primaryMessages;
  const selectedCount = promoteRecovery ? input.recovery! : input.primary;
  const context = input.plan.modelContext as Readonly<Record<string, AgentJsonValue>>;
  const tokenMeter = context.tokenMeter as Readonly<Record<string, AgentJsonValue>>;
  const selectedDigest = digestMessages(selectedMessages);

  return {
    ...input.plan,
    primaryMessages: selectedMessages,
    overflowRecoveryMessages: retainRecovery
      ? input.plan.overflowRecoveryMessages
      : null,
    primaryMeteredTokens: selectedCount.tokens,
    overflowRecoveryMeteredTokens: retainRecovery ? input.recovery!.tokens : null,
    modelContext: {
      ...context,
      primaryRequestDigest: selectedDigest,
      overflowRecoveryRequestDigest: retainRecovery
        ? digestMessages(input.plan.overflowRecoveryMessages!)
        : null,
      primaryEstimatedTokens: selectedCount.tokens,
      overflowRecoveryEstimatedTokens: retainRecovery ? input.recovery!.tokens : null,
      overflowRecoveryPrepared: retainRecovery,
      projectionAdmission: promoteRecovery ? 'recovery_promoted' : 'primary_admitted',
      tokenMeter: {
        ...tokenMeter,
        projectionTokenizer: selectedCount.tokenizer,
        projectionTokenizerExact: selectedCount.exact,
        primaryTokens: selectedCount.tokens,
        overflowRecoveryTokens: retainRecovery ? input.recovery!.tokens : null,
        hardInputLimitTokens: hardInputLimit
      }
    }
  };
}

function assertTokenCount(value: {
  readonly tokens: number;
  readonly exact: boolean;
  readonly tokenizer: string;
}): void {
  if (!Number.isSafeInteger(value.tokens) || value.tokens < 1 || value.tokenizer.length === 0) {
    throw new Error('agent_model_token_count_invalid');
  }
}

function nextSemanticSummaryBudget(current: number): number {
  if (current > 2_048) return 2_048;
  if (current > 1_024) return 1_024;
  if (current > 768) return 768;
  return 640;
}

function usageCorrection(
  requestHeaderDigest: string,
  baseline: V3LongContextUsageBaseline | undefined
): number {
  if (baseline === undefined) return 0;
  if (baseline.anchor.requestHeaderDigest !== requestHeaderDigest) {
    throw new Error('agent_model_context_usage_anchor_header_mismatch');
  }
  return Math.max(0, contextInputTokens(baseline.anchor) - baseline.anchor.estimatedInputTokens);
}

function contextInputTokens(anchor: AgentInferenceUsageAnchorV1): number {
  return anchor.inputTokens
    + (anchor.cacheReadInputTokens ?? 0)
    + (anchor.cacheWriteInputTokens ?? 0);
}

function meteredTokens(
  messages: readonly ExactAgentModelInferenceMessage[],
  correctionTokens: number,
  fixedOverheadTokens = 0
): number {
  return Math.max(
    1,
    estimateMessagesTokens(messages) + correctionTokens + fixedOverheadTokens
  );
}

function pruneToolExchange(
  group: V3ModelContextGroup,
  budgetTokens: number
): { readonly messages: readonly ExactAgentModelInferenceMessage[]; readonly prunedToolResults: number } {
  let prunedToolResults = 0;
  const messages = group.messages.map((message, index) => {
    if (index === 0 || message.role !== 'user') return message;
    if (message.content.some((block) => block.type !== 'tool_result')) {
      throw new Error('agent_model_tool_exchange_invalid');
    }
    const resultBlocks = message.content as readonly Extract<
      ExactAgentModelInferenceRequestContentBlock,
      { readonly type: 'tool_result' }
    >[];
    const perResultBudget = Math.max(64, Math.floor(budgetTokens / resultBlocks.length));
    const content = resultBlocks.map((block) => Object.freeze({
      ...block,
      output: renderToolResultSpill(block, perResultBudget)
    }));
    prunedToolResults += resultBlocks.length;
    return {
      role: message.role,
      content: Object.freeze(content)
    };
  });
  return {
    messages,
    prunedToolResults
  };
}

function renderToolResultSpill(
  block: Extract<
    ExactAgentModelInferenceRequestContentBlock,
    { readonly type: 'tool_result' }
  >,
  budgetTokens: number
): AgentJsonValue {
  const serializedOutput = JSON.stringify(block.output);
  const excerptCharacters = Math.max(
    32,
    Math.min(256, Math.floor(budgetTokens * TOKEN_BYTES / 4))
  );
  const evidence = {
    protocol: TOOL_RESULT_SPILL_PROTOCOL,
    schemaVersion: 1,
    statement: 'Full protected Tool result remains durable. Retrieve UTF-8 JSON ranges with workspace.effect_result_read using the exact effectId and cursor.',
    effectId: block.effectId,
    status: block.status,
    digest: digestText(serializedOutput),
    totalBytes: Buffer.byteLength(serializedOutput, 'utf8'),
    excerpt: boundedExcerpt(serializedOutput, excerptCharacters)
  };
  return block.status === 'cancelled'
    ? { ...evidence, retrievable: false }
    : {
        ...evidence,
        retrievable: true,
        locator: {
          toolName: 'workspace.effect_result_read',
          input: { effectId: block.effectId, cursor: 0 }
        }
      };
}

export function estimateMessagesTokens(
  messages: readonly ExactAgentModelInferenceMessage[]
): number {
  let imageTokens = 0;
  const metered = messages.map((message) => ({
    role: message.role,
    content: message.content.map((block) => {
      if (block.type !== 'image') return block;
      imageTokens += 85
        + Math.ceil(block.width / 512) * Math.ceil(block.height / 512) * 170;
      return {
        type: block.type,
        attachmentId: block.attachmentId,
        mediaType: block.mediaType,
        bytes: block.bytes,
        width: block.width,
        height: block.height
      };
    })
  }));
  const bytes = new TextEncoder().encode(JSON.stringify(metered)).byteLength;
  return Math.max(
    1,
    Math.ceil(bytes / TOKEN_BYTES) + messages.length * 8 + imageTokens
  );
}

function boundedExcerpt(content: string, characters: number): string {
  if (content.length <= characters) return content;
  const left = Math.ceil(characters / 2);
  const right = Math.floor(characters / 2);
  return `${content.slice(0, left)}…${content.slice(content.length - right)}`;
}

function digestMessages(messages: readonly ExactAgentModelInferenceMessage[]): string {
  return digestText(JSON.stringify(messages));
}

function digestText(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function assertCapacity(capacity: ExactAgentModelContextCapacity): void {
  if (
    !Number.isSafeInteger(capacity.contextWindowTokens)
    || !Number.isSafeInteger(capacity.maxOutputTokens)
    || capacity.contextWindowTokens < 8_192
    || capacity.maxOutputTokens < 256
    || capacity.maxOutputTokens >= capacity.contextWindowTokens
  ) throw new Error('agent_model_context_capacity_invalid');
}
