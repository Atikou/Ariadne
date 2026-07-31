import { CompanionMemoryService } from "./CompanionMemoryService.js";
import { CompanionOutputModeInputSchema } from "./CompanionMemoryContracts.js";
import { evaluateCompanionMemoryPolicy } from "./CompanionMemoryPolicy.js";
import {
  CompanionSummaryStatusSchema,
  type CompanionSummaryStatus,
} from "./CompanionSessionContracts.js";
import { CompanionStorageManager } from "./CompanionStorageManager.js";
import {
  CompanionVectorIndex,
  type CompanionVectorSearchMatch,
} from "./CompanionVectorIndex.js";
import {
  CompanionVectorStatusSchema,
  type CompanionVectorStatus,
} from "./CompanionVectorContracts.js";
import type {
  CompanionMemory,
  CompanionMessage,
  CompanionOutputMode,
  CompanionOutputModeInput,
  CompanionSummary,
} from "./types.js";

type CompanionStorageHandle = ReturnType<CompanionStorageManager["get"]>;

interface CompanionKnowledgeSearchBase {
  memories: CompanionMemory[];
  summaries: CompanionSummary[];
  matches: CompanionVectorSearchMatch[];
  status: CompanionVectorStatus;
}

export type CompanionKnowledgeSearchResult =
  | CompanionKnowledgeSearchBase & {
      outputMode: "bounded";
      vectors: { primary: CompanionVectorStatus };
    }
  | CompanionKnowledgeSearchBase & {
      outputMode: "unrestricted";
      vectors: {
        primary: CompanionVectorStatus;
        unrestrictedMemory: CompanionVectorStatus;
      };
    };

/** Owns mode-isolated memory, retrieval and summary lifecycle for Companion use cases. */
export class CompanionKnowledgeService {
  constructor(private readonly storageManager: CompanionStorageManager) {}

  storageForOutputMode(
    storageRoot: string | undefined,
    outputMode: CompanionOutputMode,
  ): CompanionStorageHandle {
    return outputMode === "unrestricted"
      ? this.storageManager.getUnrestrictedMemory(storageRoot)
      : this.storageManager.get(storageRoot);
  }

  findMemoryStorage(storageRoot: string | undefined, memoryId: string) {
    const storage = this.storageManager.get(storageRoot);
    const memory = storage.getMemory(memoryId);
    const candidate = storage.getMemoryCandidate(memoryId);
    if (memory?.outputMode === "unrestricted" && memory.status === "deleted") {
      const targetId = storage.getMemoryMigrationAlias(memoryId, "memory");
      if (targetId) {
        const unrestrictedStorage = this.storageManager.getUnrestrictedMemory(storageRoot);
        const migrated = unrestrictedStorage.getMemory(targetId);
        if (migrated) {
          return { storage: unrestrictedStorage, memory: migrated, candidate: null };
        }
      }
    }
    if (
      candidate?.outputMode === "unrestricted"
      && (candidate.status === "rejected" || candidate.status === "deleted")
    ) {
      const targetId = storage.getMemoryMigrationAlias(memoryId, "candidate");
      if (targetId) {
        const unrestrictedStorage = this.storageManager.getUnrestrictedMemory(storageRoot);
        const migrated = unrestrictedStorage.getMemoryCandidate(targetId);
        if (migrated) {
          return { storage: unrestrictedStorage, memory: null, candidate: migrated };
        }
      }
    }
    if (memory || candidate) return { storage, memory, candidate };
    const unrestrictedStorage = this.storageManager.getUnrestrictedMemory(storageRoot);
    return {
      storage: unrestrictedStorage,
      memory: unrestrictedStorage.getMemory(memoryId),
      candidate: unrestrictedStorage.getMemoryCandidate(memoryId),
    };
  }

  migrateLegacyUnrestrictedMemories(storageRoot?: string): void {
    const storage = this.storageManager.get(storageRoot);
    const unrestrictedStorage = this.storageManager.getUnrestrictedMemory(storageRoot);
    const existingCandidates = new Map(
      unrestrictedStorage.listMemoryCandidates({
        outputMode: "unrestricted",
        limit: 5_000,
      })
        .filter((candidate) => candidate.status !== "rejected" && candidate.status !== "deleted")
        .map((candidate) => [memoryIdentity(candidate), candidate]),
    );
    for (const candidate of storage.listMemoryCandidates({ outputMode: "unrestricted", limit: 5_000 })) {
      if (candidate.status === "rejected" || candidate.status === "deleted") continue;
      const identity = memoryIdentity(candidate);
      let target = existingCandidates.get(identity);
      if (!target) {
        target = unrestrictedStorage.createMemoryCandidate({
          id: candidate.id,
          sessionId: candidate.sessionId,
          sourceMessageId: candidate.sourceMessageId,
          kind: candidate.kind,
          key: candidate.key,
          value: candidate.value,
          summary: candidate.summary,
          status: candidate.status,
          outputMode: "unrestricted",
          reason: candidate.reason,
          sensitivity: candidate.sensitivity,
        });
        existingCandidates.set(identity, target);
      }
      storage.upsertMemoryMigrationAlias({
        legacyId: candidate.id,
        recordType: "candidate",
        targetId: target.id,
      });
      storage.updateMemoryCandidate(candidate.id, { status: "rejected" });
    }

    const existingMemories = new Map(
      unrestrictedStorage.listMemories({
        outputMode: "unrestricted",
        includeUnrestrictedForUnrestricted: true,
        limit: 5_000,
      })
        .filter((memory) => memory.status === "confirmed")
        .map((memory) => [memoryIdentity(memory), memory]),
    );
    for (const memory of storage.listMemories({ outputMode: "unrestricted", limit: 5_000 })) {
      if (memory.status === "deleted") continue;
      const identity = memoryIdentity(memory);
      let target = existingMemories.get(identity);
      if (!target) {
        const migratedCandidateId = memory.candidateId
          ? storage.getMemoryMigrationAlias(memory.candidateId, "candidate") ?? memory.candidateId
          : undefined;
        const availableCandidateId = migratedCandidateId
          && unrestrictedStorage.getMemoryCandidate(migratedCandidateId)
          && !unrestrictedStorage.getMemoryByCandidateId(migratedCandidateId)
            ? migratedCandidateId
            : undefined;
        target = unrestrictedStorage.createMemory({
          id: memory.id,
          candidateId: availableCandidateId,
          sessionId: memory.sessionId,
          kind: memory.kind,
          key: memory.key,
          value: memory.value,
          summary: memory.summary,
          status: memory.status,
          outputMode: "unrestricted",
          importance: memory.importance,
          confidence: memory.confidence,
        });
        existingMemories.set(identity, target);
      }
      storage.upsertMemoryMigrationAlias({
        legacyId: memory.id,
        recordType: "memory",
        targetId: target.id,
      });
      storage.updateMemory(memory.id, { status: "deleted" });
    }
  }

  async searchMemoryVectors(
    storageRoot: string | undefined,
    input: {
      query: string;
      outputMode: CompanionOutputMode;
      topK?: number;
    },
  ): Promise<CompanionKnowledgeSearchResult> {
    const storage = this.storageManager.get(storageRoot);
    const vector = new CompanionVectorIndex(storage);
    if (input.outputMode !== "unrestricted") {
      const result = await vector.search(input);
      return {
        ...result,
        outputMode: "bounded",
        vectors: { primary: result.status },
      };
    }

    const unrestrictedStorage = this.storageManager.getUnrestrictedMemory(storageRoot);
    const unrestrictedVector = new CompanionVectorIndex(unrestrictedStorage);
    const [bounded, unrestricted] = await Promise.all([
      vector.search(input),
      unrestrictedVector.search(input),
    ]);
    const topK = Math.min(50, Math.max(1, input.topK ?? 6));
    const matches = mergeVectorMatches(bounded.matches, unrestricted.matches).slice(0, topK);
    const memoriesById = new Map(
      [...bounded.memories, ...unrestricted.memories].map((memory) => [memory.id, memory]),
    );
    const summariesById = new Map(
      [...bounded.summaries, ...unrestricted.summaries].map((summary) => [summary.id, summary]),
    );
    return {
      outputMode: "unrestricted",
      memories: matches.flatMap(({ item }) => {
        const memory = item.itemType === "memory" ? memoriesById.get(item.sourceId) : undefined;
        return memory ? [memory] : [];
      }),
      summaries: matches.flatMap(({ item }) => {
        const summary = item.itemType === "summary" ? summariesById.get(item.sourceId) : undefined;
        return summary ? [summary] : [];
      }),
      matches,
      status: combineCompanionVectorStatuses(bounded.status, unrestricted.status, matches.length),
      vectors: {
        primary: bounded.status,
        unrestrictedMemory: unrestricted.status,
      },
    };
  }

  async extractAndIndexUserMemory(input: {
    storageRoot?: string;
    outputMode: CompanionOutputMode;
    message: string;
    sessionId: string;
    sourceMessageId: string;
  }): Promise<void> {
    const storage = this.storageForOutputMode(input.storageRoot, input.outputMode);
    const extracted = new CompanionMemoryService(storage).extractFromUserMessage({
      message: input.message,
      sessionId: input.sessionId,
      sourceMessageId: input.sourceMessageId,
      outputMode: input.outputMode,
    });
    if (!extracted.memory) return;
    const policy = evaluateCompanionMemoryPolicy({
      value: extracted.memory.value,
      summary: extracted.memory.summary,
      key: extracted.memory.key,
      kind: extracted.memory.kind,
      outputMode: input.outputMode,
      requestedStatus: extracted.memory.status,
    });
    if (policy.vectorEligible) {
      await new CompanionVectorIndex(storage).indexMemory(extracted.memory);
    }
  }

  async summarizeSession(input: {
    storage: CompanionStorageHandle;
    sessionId: string;
    modelName?: string;
    force?: boolean;
    outputMode?: CompanionOutputMode;
    lifecycle?: {
      onStarted?: (input: {
        processedMessages: number;
        beforeChars: number;
        summaryType: string;
      }) => void;
      onCompleted?: (input: {
        processedMessages: number;
        beforeChars: number;
        afterChars: number;
        summaryType: string;
      }) => void;
      onFailed?: (error: unknown) => void;
    };
  }): Promise<CompanionSummaryStatus> {
    const outputMode = input.outputMode ?? "bounded";
    const messages = input.storage.listMessages(input.sessionId, 200);
    const completed = filterMessagesForMode(
      messages.filter((message) => message.status === "completed"),
      outputMode,
    );
    const summaries = filterSummariesForMode(
      input.storage.listSummaries(input.sessionId, 200),
      outputMode,
    );
    const lastSummary = summaries[summaries.length - 1];
    const lastSummaryIndex = lastSummary
      ? completed.findIndex((message) => message.id === lastSummary.sourceMessageEndId)
      : -1;
    const source = completed.slice(lastSummaryIndex + 1);
    if (source.length < 2) {
      return CompanionSummaryStatusSchema.parse({
        generated: false,
        reason: input.force ? "not_enough_unsummarized_messages" : "waiting_for_completed_turn",
      });
    }
    const first = source[0];
    const last = source[source.length - 1];
    if (!first || !last) {
      return CompanionSummaryStatusSchema.parse({ generated: false, reason: "empty_source" });
    }
    const beforeChars = source.reduce((sum, message) => sum + message.content.length, 0);
    const lifecycleInput = {
      processedMessages: source.length,
      beforeChars,
      summaryType: "companion_session_summary",
    };
    input.lifecycle?.onStarted?.(lifecycleInput);
    try {
      const summary = buildExtractiveSummary(
        source.map((message) => `${message.role}: ${message.content}`),
      );
      const record = input.storage.createSummary({
        sessionId: input.sessionId,
        sourceMessageStartId: first.id,
        sourceMessageEndId: last.id,
        summary,
        topics: [...extractTopics(summary), `mode:${outputMode}`],
        modelName: input.modelName,
      });
      await new CompanionVectorIndex(input.storage).indexSummary(record);
      input.lifecycle?.onCompleted?.({
        ...lifecycleInput,
        afterChars: summary.length,
      });
      return CompanionSummaryStatusSchema.parse({ generated: true, summaryId: record.id });
    } catch (error) {
      input.lifecycle?.onFailed?.(error);
      throw error;
    }
  }
}

function memoryIdentity(input: Pick<CompanionMemory, "kind" | "key" | "value" | "summary">): string {
  return JSON.stringify([input.kind, input.key, input.value, input.summary]);
}

export function normalizeCompanionOutputMode(
  mode?: CompanionOutputModeInput,
): CompanionOutputMode {
  const parsed = mode === undefined ? "bounded" : CompanionOutputModeInputSchema.parse(mode);
  return parsed === "unrestricted" || parsed === "raw" ? "unrestricted" : "bounded";
}

export function companionModeMetadata(
  outputMode: CompanionOutputMode,
): Record<string, unknown> {
  return {
    outputMode,
    companionMode: outputMode,
    rawOutput: outputMode === "unrestricted",
  };
}

export function filterMessagesForMode(
  messages: CompanionMessage[],
  outputMode: CompanionOutputMode,
): CompanionMessage[] {
  const conversationMessages = messages.filter(isConversationMessage);
  if (outputMode === "unrestricted") return conversationMessages;
  return conversationMessages.filter((message) => messageMode(message) !== "unrestricted");
}

function isConversationMessage(message: CompanionMessage): boolean {
  const responseType = message.metadata?.responseType;
  return responseType !== "agent_proposal"
    && responseType !== "agent_proposal_delivery_pending";
}

export function filterSummariesForMode(
  summaries: CompanionSummary[],
  outputMode: CompanionOutputMode,
): CompanionSummary[] {
  if (outputMode === "unrestricted") return summaries;
  return summaries.filter((summary) => summaryMode(summary) !== "unrestricted");
}

export function selectPromptSummaries(input: {
  sessionId: string;
  recentMessages: CompanionMessage[];
  stored: CompanionSummary[];
  retrieved: CompanionSummary[];
}): CompanionSummary[] {
  const recentMessageIds = new Set(input.recentMessages.map((message) => message.id));
  const olderLocal = input.stored.filter(
    (summary) => !recentMessageIds.has(summary.sourceMessageEndId),
  );
  const relevant = input.retrieved.filter(
    (summary) =>
      summary.sessionId !== input.sessionId
      || !recentMessageIds.has(summary.sourceMessageEndId),
  );
  return mergeSummaries(olderLocal.slice(-6), relevant);
}

export function mergeMemories(
  primary: CompanionMemory[],
  secondary: CompanionMemory[],
): CompanionMemory[] {
  const byId = new Map<string, CompanionMemory>();
  for (const memory of [...primary, ...secondary]) byId.set(memory.id, memory);
  return [...byId.values()];
}

function mergeSummaries(
  primary: CompanionSummary[],
  retrieved: CompanionSummary[],
): CompanionSummary[] {
  const byId = new Map<string, CompanionSummary>();
  for (const summary of [...primary, ...retrieved]) byId.set(summary.id, summary);
  return [...byId.values()].slice(-8);
}

function mergeVectorMatches(
  primary: CompanionVectorSearchMatch[],
  secondary: CompanionVectorSearchMatch[],
): CompanionVectorSearchMatch[] {
  const byId = new Map<string, CompanionVectorSearchMatch>();
  for (const match of [...primary, ...secondary]) {
    const existing = byId.get(match.item.id);
    if (!existing || match.score > existing.score) byId.set(match.item.id, match);
  }
  return [...byId.values()].sort(
    (left, right) => right.score - left.score || left.item.id.localeCompare(right.item.id),
  );
}

export function combineCompanionVectorStatuses(
  primary: CompanionVectorStatus,
  unrestrictedMemory: CompanionVectorStatus,
  retrievedCount: number,
): CompanionVectorStatus {
  const sameCapability = primary.capability === unrestrictedMemory.capability;
  const sameDimension = primary.dimension === unrestrictedMemory.dimension;
  const sameBackend = primary.backend === unrestrictedMemory.backend;
  return CompanionVectorStatusSchema.parse({
    enabled: primary.enabled && unrestrictedMemory.enabled,
    namespace: "companion:combined",
    provider: primary.provider === unrestrictedMemory.provider ? primary.provider : "multiple",
    capability: sameCapability ? primary.capability : undefined,
    dimension: sameDimension ? primary.dimension : undefined,
    remoteEnabled: primary.remoteEnabled === true || unrestrictedMemory.remoteEnabled === true,
    backend: sameBackend ? primary.backend : undefined,
    persistent: primary.persistent === true && unrestrictedMemory.persistent === true,
    degraded: primary.degraded === true || unrestrictedMemory.degraded === true,
    requiresRebuild:
      primary.requiresRebuild === true || unrestrictedMemory.requiresRebuild === true,
    itemCount: primary.itemCount + unrestrictedMemory.itemCount,
    retrievedCount,
    reason: [
      `primary:${primary.reason ?? "ready"}`,
      `unrestrictedMemory:${unrestrictedMemory.reason ?? "ready"}`,
    ].join(";"),
  });
}

function messageMode(message: CompanionMessage): CompanionOutputMode {
  const raw = message.metadata?.outputMode ?? message.metadata?.companionMode;
  return raw === "unrestricted" || raw === "raw" ? "unrestricted" : "bounded";
}

function summaryMode(summary: CompanionSummary): CompanionOutputMode {
  return summary.topics.includes("mode:unrestricted") ? "unrestricted" : "bounded";
}

function buildExtractiveSummary(lines: string[]): string {
  const joined = lines.join("\n").replace(/\s+/g, " ").trim();
  const clipped = joined.length > 700 ? `${joined.slice(0, 700)}...` : joined;
  return `这段较早对话的关键内容：${clipped}`;
}

function extractTopics(summary: string): string[] {
  const topics = ["聊天"];
  if (/工作|项目|代码|任务/.test(summary)) topics.push("工作");
  if (/难过|焦虑|孤独|情绪/.test(summary)) topics.push("情绪");
  if (/现实|朋友|家人|作息/.test(summary)) topics.push("现实支持");
  return [...new Set(topics)];
}
