import { createHash } from 'node:crypto';

import type { AgentJsonValue } from '@ariadne/agent-core';

import type {
  ExactAgentModelContextCapacity,
  ExactAgentModelInferenceMessage
} from '../../control/ports/AgentModelInference.js';

const COMPACTION_PROTOCOL = 'ariadne.context-compaction.v1';
const TOOL_RESULT_PRUNING_PROTOCOL = 'ariadne.tool-result-pruning.v1';
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
}

interface CompactionResult {
  readonly messages: readonly ExactAgentModelInferenceMessage[];
  readonly omittedGroups: number;
  readonly omittedMessages: number;
  readonly prunedToolResults: number;
  readonly estimatedTokens: number;
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
}): V3LongContextPlan {
  assertCapacity(input.capacity);
  if (input.pinnedMessages.length === 0 || input.groups.length === 0) {
    throw new Error('agent_model_context_source_invalid');
  }
  const full = [...input.pinnedMessages, ...input.groups.flatMap((group) => group.messages)];
  const sourceDigest = digestMessages(full);
  const fullTokens = estimateMessagesTokens(full);
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
        estimatedTokens: fullTokens
      }
    : compact(input.pinnedMessages, input.groups, pressureLimit, input.capacity, 384);
  let recovery: CompactionResult | null = null;
  try {
    recovery = compact(
      input.pinnedMessages,
      input.groups,
      recoveryLimit,
      input.capacity,
      0
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
      omittedGroups: primary.omittedGroups,
      omittedMessages: primary.omittedMessages,
      prunedToolResults: primary.prunedToolResults,
      overflowRecoveryPrepared: hasDistinctRecovery
    }
  };
}

function compact(
  pinned: readonly ExactAgentModelInferenceMessage[],
  groups: readonly V3ModelContextGroup[],
  limit: number,
  capacity: ExactAgentModelContextCapacity,
  initialExcerptCharacters: 0 | 384
): CompactionResult {
  const pinnedTokens = estimateMessagesTokens(pinned);
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
    estimateMessagesTokens([...pinned, ...retainedMessages]) >= limit
    && retained.length > 1
  ) {
    retained.shift();
    retainedStart += 1;
    retainedMessages = retained.flatMap((group) => group.messages);
  }
  if (estimateMessagesTokens([...pinned, ...retainedMessages]) >= limit) {
    const latest = retained[0]!;
    if (latest.kind !== 'tool_exchange') {
      throw new Error('agent_model_current_objective_exceeds_context_capacity');
    }
    const pruned = pruneToolExchange(latest, Math.max(256, limit - pinnedTokens));
    retainedMessages = pruned.messages;
    prunedToolResults = pruned.prunedToolResults;
  }

  const omitted = groups.slice(0, retainedStart);
  let excerptCharacters: number = initialExcerptCharacters;
  let manifest = renderCompactionManifest(omitted, excerptCharacters);
  let messages = [...pinned, manifest, ...retainedMessages];
  while (estimateMessagesTokens(messages) > limit && excerptCharacters > 0) {
    excerptCharacters = excerptCharacters === 384 ? 128 : 0;
    manifest = renderCompactionManifest(omitted, excerptCharacters);
    messages = [...pinned, manifest, ...retainedMessages];
  }
  if (estimateMessagesTokens(messages) > limit) {
    throw new Error('agent_model_compacted_context_exceeds_capacity');
  }
  return {
    messages,
    omittedGroups: omitted.length,
    omittedMessages: omitted.reduce((count, group) => count + group.messages.length, 0),
    prunedToolResults,
    estimatedTokens: estimateMessagesTokens(messages)
  };
}

function renderCompactionManifest(
  omitted: readonly V3ModelContextGroup[],
  excerptCharacters: number
): ExactAgentModelInferenceMessage {
  const allEntries = omitted.flatMap((group, groupIndex) => group.messages.map((message) => ({
    group: groupIndex,
    groupKind: group.kind,
    role: message.role,
    characters: message.content.length,
    digest: digestText(message.content),
    ...(excerptCharacters === 0
      ? {}
      : { excerpt: boundedExcerpt(message.content, excerptCharacters) })
  })));
  const entries = allEntries.length <= 64
    ? allEntries
    : [...allEntries.slice(0, 16), ...allEntries.slice(-48)];
  return {
    role: 'system',
    content: JSON.stringify({
      protocol: COMPACTION_PROTOCOL,
      statement: 'Earlier causal context was compacted deterministically. Digests identify the protected source messages; retained messages follow in original order.',
      omittedGroups: omitted.length,
      omittedMessages: allEntries.length,
      omittedCharacters: allEntries.reduce((sum, entry) => sum + entry.characters, 0),
      omittedDigest: digestText(JSON.stringify(allEntries.map((entry) => ({
        group: entry.group,
        groupKind: entry.groupKind,
        role: entry.role,
        characters: entry.characters,
        digest: entry.digest
      })))),
      sampledMessages: entries.length,
      entries
    })
  };
}

function pruneToolExchange(
  group: V3ModelContextGroup,
  budgetTokens: number
): { readonly messages: readonly ExactAgentModelInferenceMessage[]; readonly prunedToolResults: number } {
  const messages = group.messages.map((message, index) => {
    if (index === 0 || message.role !== 'user') return message;
    return {
      role: message.role,
      content: JSON.stringify({
        protocol: TOOL_RESULT_PRUNING_PROTOCOL,
        role: message.role,
        characters: message.content.length,
        digest: digestText(message.content),
        excerpt: boundedExcerpt(message.content, Math.max(64, Math.floor(budgetTokens * TOKEN_BYTES / 4)))
      })
    };
  });
  return {
    messages,
    prunedToolResults: Math.max(0, messages.length - 1)
  };
}

export function estimateMessagesTokens(
  messages: readonly ExactAgentModelInferenceMessage[]
): number {
  const bytes = new TextEncoder().encode(JSON.stringify(messages)).byteLength;
  return Math.max(1, Math.ceil(bytes / TOKEN_BYTES) + messages.length * 8);
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
