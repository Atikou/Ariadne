import { CompanionVectorIndex, companionVectorStatus } from "./CompanionVectorIndex.js";
import { CompanionAgentResultPresenter } from "./CompanionAgentResultPresenter.js";
import type { CompanionAgentResultPresentationInput } from "./CompanionAgentResultPresenter.js";
import type { CompanionAgentResultPresented } from "./CompanionAgentResultContracts.js";
import {
  CompanionAgentProposalOutboxDispatcher,
} from "./CompanionAgentProposalOutboxDispatcher.js";
import type {
  CompanionAgentProposalSubmission,
  CompanionAgentProposalSubmissionResult,
} from "./CompanionAgentProposalOutboxContracts.js";
import { CompanionStorageManager } from "./CompanionStorageManager.js";
import { CompanionMemoryService } from "./CompanionMemoryService.js";
import {
  CompanionMemoryCreateResultSchema,
  CompanionMemoryDeleteResultSchema,
  CompanionMemoryListResultSchema,
  CompanionMemorySearchRequestSchema,
  CompanionMemorySearchResultSchema,
  CompanionMemoryUpdateRequestSchema,
  CompanionMemoryUpdateResultSchema,
  type CompanionMemory,
  type CompanionMemoryCandidate,
  type CompanionMemoryCreateResult,
  type CompanionMemoryDeleteResult,
  type CompanionMemoryKind,
  type CompanionMemoryListResult,
  type CompanionMemorySearchRequest,
  type CompanionMemorySearchResult,
  type CompanionMemoryStatus,
  type CompanionMemoryUpdateRequest,
  type CompanionMemoryUpdateResult,
  type CompanionOutputModeInput,
} from "./CompanionMemoryContracts.js";
import {
  assertCompanionMemoryStatus,
  evaluateCompanionMemoryPolicy,
  normalizeCompanionMemoryInput,
  type NormalizedCompanionMemoryInput,
} from "./CompanionMemoryPolicy.js";
import {
  CompanionConversationWorkflow,
  type CompanionConversationWorkflowDeps,
  type CompanionConversationRunContext,
} from "./CompanionConversationWorkflow.js";
import {
  CompanionKnowledgeService,
  filterMessagesForMode,
  filterSummariesForMode,
  mergeMemories,
  normalizeCompanionOutputMode,
} from "./CompanionKnowledgeService.js";
import type { CompanionRunCancelResult } from "./CompanionRunContracts.js";
import type { CompanionStreamEvent } from "./CompanionStreamContracts.js";
import {
  CompanionPersonaDeleteResultSchema,
  CompanionPersonaDetailResultSchema,
  CompanionPersonaListResultSchema,
  type CompanionPersonaDeleteResult,
  type CompanionPersonaDetailResult,
  type CompanionPersonaListResult,
} from "./CompanionPersonaContracts.js";
import {
  CompanionRawOutputStatusSchema,
  CompanionSessionCreateResultSchema,
  CompanionSessionDeleteResultSchema,
  CompanionSessionListResultSchema,
  CompanionSessionMessagesResultSchema,
  CompanionSessionSummaryResultSchema,
  type CompanionRawOutputStatus,
  type CompanionSessionCreateResult,
  type CompanionSessionDeleteResult,
  type CompanionSessionListResult,
  type CompanionSessionMessagesResult,
  type CompanionSessionSummaryResult,
  CompanionSessionUpdateRequestSchema,
  CompanionSessionUpdateResultSchema,
  type CompanionSessionUpdateRequest,
  type CompanionSessionUpdateResult,
} from "./CompanionSessionContracts.js";
import {
  CompanionVectorRebuildResultSchema,
  type CompanionVectorRebuildResult,
} from "./CompanionStorageVectorContracts.js";
import type {
  CompanionChatInput,
  CompanionChatResult,
} from "./CompanionChatContracts.js";

export type CompanionPostCommitFailure =
  | {
      operation: "delete_session_vectors";
      sessionId: string;
      attemptedEntries: number;
      failedEntries: number;
      requiresRebuild: true;
    }
  | {
      operation: "delete_session_storage_reset";
      sessionId: string;
      warningCodes: ["unrestricted_memory_detach_failed"];
      storageResetSucceeded: boolean;
    };

export interface CompanionServiceDeps {
  projectRoot: string;
  defaultStorageRoot?: string;
  directChat: CompanionConversationWorkflowDeps["directChat"];
  proposeAgentHandoff?: (
    input: CompanionAgentProposalSubmission,
  ) => CompanionAgentProposalSubmissionResult | Promise<CompanionAgentProposalSubmissionResult>;
  onPostCommitFailure?: (failure: CompanionPostCommitFailure) => void;
}

export type CompanionRunContext = CompanionConversationRunContext;
type CompanionStorageHandle = ReturnType<CompanionStorageManager["get"]>;

export class CompanionService {
  readonly storageManager: CompanionStorageManager;
  private readonly knowledge: CompanionKnowledgeService;
  private readonly conversation: CompanionConversationWorkflow;
  private readonly agentResultPresenter: CompanionAgentResultPresenter;
  private readonly agentProposalOutbox?: CompanionAgentProposalOutboxDispatcher;
  private stopProposalRecovery?: () => void;
  private started = false;

  constructor(private readonly deps: CompanionServiceDeps) {
    this.storageManager = new CompanionStorageManager(
      deps.projectRoot,
      deps.defaultStorageRoot,
    );
    this.agentProposalOutbox = deps.proposeAgentHandoff
      ? new CompanionAgentProposalOutboxDispatcher(deps.proposeAgentHandoff)
      : undefined;
    this.knowledge = new CompanionKnowledgeService(this.storageManager);
    this.agentResultPresenter = new CompanionAgentResultPresenter({
      storageManager: this.storageManager,
      knowledge: this.knowledge,
      directChat: deps.directChat,
    });
    this.conversation = new CompanionConversationWorkflow({
      storageManager: this.storageManager,
      knowledge: this.knowledge,
      directChat: deps.directChat,
      agentProposalOutbox: this.agentProposalOutbox,
    });
  }

  rawOutputStatus(): CompanionRawOutputStatus {
    return CompanionRawOutputStatusSchema.parse({
      enabled: true,
      profile: "raw_output",
      productVisible: true,
      safetyRewrite: false,
    });
  }

  storageStatus(storageRoot?: string) {
    return this.storageManager.get(storageRoot).status();
  }

  vectorStatus(storageRoot?: string) {
    const storage = this.storageManager.get(storageRoot);
    return companionVectorStatus(storage);
  }

  listPersonas(
    input?: { storageRoot?: string; includeInactive?: boolean },
  ): CompanionPersonaListResult {
    const storage = this.storageManager.get(input?.storageRoot);
    return CompanionPersonaListResultSchema.parse({
      storage: storage.status(),
      personas: storage.listPersonas({ includeInactive: input?.includeInactive }),
    });
  }

  getPersona(
    input: { storageRoot?: string; personaId: string },
  ): CompanionPersonaDetailResult | null {
    const storage = this.storageManager.get(input.storageRoot);
    const persona = storage.getPersona(input.personaId);
    if (!persona) return null;
    return CompanionPersonaDetailResultSchema.parse({
      storage: storage.status(),
      persona,
      versions: storage.listPersonaVersions(input.personaId),
    });
  }

  createPersona(input: {
    storageRoot?: string;
    name?: string;
    systemPrompt?: string;
    description?: string;
    copyFrom?: string;
  }): CompanionPersonaDetailResult {
    const storage = this.storageManager.get(input.storageRoot);
    const copyFrom = input.copyFrom?.trim();
    const source = copyFrom ? storage.getPersona(copyFrom) : null;
    if (copyFrom && !source) throw new Error(`复制源人格不存在：${copyFrom}`);
    const name = input.name?.trim() || source?.name;
    const systemPrompt = input.systemPrompt?.trim() || source?.systemPrompt;
    if (!name || !systemPrompt) {
      throw new Error("创建人格必须提供 copyFrom，或同时提供 name 与 systemPrompt");
    }
    const persona = storage.createPersona({
      name,
      systemPrompt,
      description: input.description?.trim() || source?.description,
    });
    return CompanionPersonaDetailResultSchema.parse({
      storage: storage.status(),
      persona,
      versions: storage.listPersonaVersions(persona.id),
    });
  }

  updatePersona(input: {
    storageRoot?: string;
    personaId: string;
    patch: { name?: string; systemPrompt?: string; description?: string; active?: boolean };
  }): CompanionPersonaDetailResult | null {
    const storage = this.storageManager.get(input.storageRoot);
    const persona = storage.updatePersona(input.personaId, input.patch);
    if (!persona) return null;
    return CompanionPersonaDetailResultSchema.parse({
      storage: storage.status(),
      persona,
      versions: storage.listPersonaVersions(persona.id),
    });
  }

  revertPersona(
    input: { storageRoot?: string; personaId: string; version: number },
  ): CompanionPersonaDetailResult | null {
    const storage = this.storageManager.get(input.storageRoot);
    const persona = storage.revertPersona(input.personaId, input.version);
    if (!persona) return null;
    return CompanionPersonaDetailResultSchema.parse({
      storage: storage.status(),
      persona,
      versions: storage.listPersonaVersions(persona.id),
    });
  }

  deletePersona(
    input: { storageRoot?: string; personaId: string },
  ): CompanionPersonaDeleteResult | null {
    const storage = this.storageManager.get(input.storageRoot);
    if (!storage.deletePersona(input.personaId)) return null;
    return CompanionPersonaDeleteResultSchema.parse({
      storage: storage.status(),
      personaId: input.personaId,
      deleted: true,
    });
  }

  listMemories(input?: {
    storageRoot?: string;
    outputMode?: CompanionOutputModeInput;
    sessionId?: string;
    includeCandidates?: boolean;
  }): CompanionMemoryListResult {
    const storage = this.storageManager.get(input?.storageRoot);
    const outputMode = normalizeCompanionOutputMode(input?.outputMode);
    this.knowledge.migrateLegacyUnrestrictedMemories(input?.storageRoot);
    if (outputMode === "unrestricted") {
      const unrestrictedStorage = this.storageManager.getUnrestrictedMemory(input?.storageRoot);
      const bounded = new CompanionMemoryService(storage).list({
        outputMode: "bounded",
        sessionId: input?.sessionId,
        includeCandidates: input?.includeCandidates,
      });
      const unrestricted = new CompanionMemoryService(unrestrictedStorage).list({
        outputMode: "unrestricted",
        sessionId: input?.sessionId,
        includeCandidates: input?.includeCandidates,
      });
      return CompanionMemoryListResultSchema.parse({
        storage: storage.status(),
        unrestrictedStorage: unrestrictedStorage.status(),
        candidates: [...bounded.candidates, ...unrestricted.candidates],
        memories: mergeMemories(bounded.memories, unrestricted.memories),
      });
    }
    const service = new CompanionMemoryService(storage);
    return CompanionMemoryListResultSchema.parse({
      storage: storage.status(),
      ...service.list({
        outputMode,
        sessionId: input?.sessionId,
        includeCandidates: input?.includeCandidates,
      }),
    });
  }

  async createMemory(input: {
    storageRoot?: string;
    sessionId?: string;
    kind?: CompanionMemoryKind;
    key?: string;
    value?: string;
    summary?: string;
    status?: CompanionMemoryStatus;
    outputMode?: CompanionOutputModeInput;
  }): Promise<CompanionMemoryCreateResult> {
    assertCompanionMemoryStatus(input.status);
    if (input.status === "deleted" || input.status === "rejected") {
      throw new Error("createMemory 只允许 candidate 或 confirmed");
    }
    const normalized = normalizeCompanionMemoryInput(input);
    const outputMode = normalizeCompanionOutputMode(input.outputMode);
    const storage = this.knowledge.storageForOutputMode(input.storageRoot, outputMode);
    const policy = evaluateCompanionMemoryPolicy({
      ...normalized,
      outputMode,
      requestedStatus: input.status,
    });
    if (!policy.allowed) {
      return CompanionMemoryCreateResultSchema.parse({ storage: storage.status(), policy });
    }
    if (policy.statusDecision === "candidate") {
      const candidate = storage.createMemoryCandidate({
        sessionId: input.sessionId,
        kind: normalized.kind,
        key: normalized.key,
        value: normalized.value,
        summary: normalized.summary,
        outputMode,
        status: "candidate",
        reason: "manual",
        sensitivity: policy.sensitivity,
      });
      return CompanionMemoryCreateResultSchema.parse({
        storage: storage.status(),
        candidate,
        policy,
      });
    }
    const memory = storage.createMemory({
      sessionId: input.sessionId,
      kind: normalized.kind,
      key: normalized.key,
      value: normalized.value,
      summary: normalized.summary,
      outputMode,
      status: "confirmed",
      confidence: normalized.confidence ?? 1,
      importance: normalized.importance ?? 0.8,
    });
    if (policy.vectorEligible) await new CompanionVectorIndex(storage).indexMemory(memory);
    return CompanionMemoryCreateResultSchema.parse({
      storage: storage.status(),
      memory,
      policy,
      vector: companionVectorStatus(storage),
    });
  }

  async updateMemory(input: {
    memoryId: string;
    patch: CompanionMemoryUpdateRequest;
  }): Promise<CompanionMemoryUpdateResult | null> {
    const patch = CompanionMemoryUpdateRequestSchema.parse(input.patch);
    this.knowledge.migrateLegacyUnrestrictedMemories(patch.storageRoot);
    const located = this.knowledge.findMemoryStorage(patch.storageRoot, input.memoryId);
    const storage = located.storage;
    const vector = new CompanionVectorIndex(storage);
    if (located.memory) {
      if (located.memory.status !== "confirmed") return null;
      return updateConfirmedMemory({ storage, vector, memory: located.memory, patch });
    }
    if (!located.candidate || located.candidate.status === "deleted") return null;
    return updateMemoryCandidate({ storage, vector, candidate: located.candidate, patch });
  }

  async deleteMemory(input: {
    storageRoot?: string;
    memoryId: string;
  }): Promise<CompanionMemoryDeleteResult | null> {
    this.knowledge.migrateLegacyUnrestrictedMemories(input.storageRoot);
    const located = this.knowledge.findMemoryStorage(input.storageRoot, input.memoryId);
    const storage = located.storage;
    const targetId = located.memory && located.memory.status !== "deleted"
      ? located.memory.id
      : located.candidate && located.candidate.status !== "deleted"
        ? located.candidate.id
        : undefined;
    if (!targetId) return null;
    const deletion = storage.deleteMemoryResource(targetId);
    if (!deletion) return null;
    const vector = new CompanionVectorIndex(storage);
    if (deletion.memoryId) await vector.remove("memory", deletion.memoryId);
    return CompanionMemoryDeleteResultSchema.parse({
      ...deletion,
      deleted: true,
      requestedId: input.memoryId,
      storage: storage.status(),
      vector: vector.status(),
    });
  }

  async searchMemories(
    input: CompanionMemorySearchRequest,
  ): Promise<CompanionMemorySearchResult> {
    const request = CompanionMemorySearchRequestSchema.parse(input);
    const storage = this.storageManager.get(request.storageRoot);
    this.knowledge.migrateLegacyUnrestrictedMemories(request.storageRoot);
    const result = await this.knowledge.searchMemoryVectors(request.storageRoot, {
      query: request.query,
      outputMode: normalizeCompanionOutputMode(request.outputMode),
      topK: request.topK,
    });
    const payload = {
      outputMode: result.outputMode,
      memories: result.memories,
      summaries: result.summaries,
      matches: result.matches.map(({ item, outputMode, score }) => ({
        sourceType: item.itemType === "summary" ? "summary" as const : "memory" as const,
        sourceId: item.sourceId,
        outputMode,
        content: item.content,
        summary: item.summary,
        tags: item.tags ?? [],
        score,
      })),
    };
    if (result.outputMode === "bounded") {
      return CompanionMemorySearchResultSchema.parse({
        ...payload,
        storages: { primary: storage.status() },
        vectors: result.vectors,
      });
    }
    const unrestrictedStorage = this.storageManager.getUnrestrictedMemory(request.storageRoot);
    return CompanionMemorySearchResultSchema.parse({
      ...payload,
      storages: {
        primary: storage.status(),
        unrestrictedMemory: unrestrictedStorage.status(),
      },
      vectors: result.vectors,
    });
  }

  async rebuildVector(
    input?: { storageRoot?: string },
  ): Promise<CompanionVectorRebuildResult> {
    const storage = this.storageManager.get(input?.storageRoot);
    this.knowledge.migrateLegacyUnrestrictedMemories(input?.storageRoot);
    const unrestrictedStorage = this.storageManager.getUnrestrictedMemory(input?.storageRoot);
    const vector = new CompanionVectorIndex(storage);
    const unrestrictedVector = new CompanionVectorIndex(unrestrictedStorage);
    const [primaryVector, unrestrictedMemoryVector] = await Promise.all([
      vector.rebuild(),
      unrestrictedVector.rebuild(),
    ]);
    return CompanionVectorRebuildResultSchema.parse({
      storages: {
        primary: storage.status(),
        unrestrictedMemory: unrestrictedStorage.status(),
      },
      vectors: {
        primary: primaryVector,
        unrestrictedMemory: unrestrictedMemoryVector,
      },
    });
  }

  listSessions(storageRoot?: string): CompanionSessionListResult {
    const storage = this.storageManager.get(storageRoot);
    return CompanionSessionListResultSchema.parse({
      storage: storage.status(),
      sessions: storage.listSessions(),
    });
  }

  hasSession(input: { storageRoot?: string; sessionId: string }): boolean {
    return Boolean(this.storageManager.get(input.storageRoot).getSession(input.sessionId));
  }

  createSession(
    input?: { storageRoot?: string; personaId?: string; title?: string },
  ): CompanionSessionCreateResult {
    const storage = this.storageManager.get(input?.storageRoot);
    return CompanionSessionCreateResultSchema.parse({
      storage: storage.status(),
      session: storage.createSession({
        personaId: input?.personaId,
        title: input?.title,
      }),
    });
  }

  updateSession(
    sessionId: string,
    rawInput: CompanionSessionUpdateRequest,
  ): CompanionSessionUpdateResult | null {
    const input = CompanionSessionUpdateRequestSchema.parse(rawInput);
    const storage = this.storageManager.get(input.storageRoot);
    const session = storage.updateSessionTitle(sessionId, input.title);
    return session
      ? CompanionSessionUpdateResultSchema.parse({ storage: storage.status(), session })
      : null;
  }

  async deleteSession(input: {
    storageRoot?: string;
    sessionId: string;
  }): Promise<CompanionSessionDeleteResult | null> {
    const storage = this.storageManager.get(input.storageRoot);
    const session = storage.getSession(input.sessionId);
    if (!session) return null;
    this.knowledge.migrateLegacyUnrestrictedMemories(input.storageRoot);

    const unrestrictedStorage = this.storageManager.getUnrestrictedMemory(input.storageRoot);
    const storageStatuses = {
      primary: storage.status(),
      unrestrictedMemory: unrestrictedStorage.status(),
    };
    const vector = new CompanionVectorIndex(storage);
    const unrestrictedVector = new CompanionVectorIndex(unrestrictedStorage);
    const vectorStatusesBeforeDeletion = {
      primary: vector.status(),
      unrestrictedMemory: unrestrictedVector.status(),
    };
    const operation = storage.deleteSessionAcrossStores(
      input.sessionId,
      unrestrictedStorage.dbPath,
    );
    if (!operation) return null;
    const { deletions } = operation;

    let attemptedEntries = 0;
    let failedEntries = 0;
    let primaryFailedEntries = 0;
    let unrestrictedFailedEntries = 0;
    for (const summaryId of deletions.primary.deletedSummaryIds) {
      attemptedEntries += 1;
      try {
        await vector.remove("summary", summaryId);
      } catch {
        failedEntries += 1;
        primaryFailedEntries += 1;
      }
    }
    for (const memoryId of deletions.primary.deletedMemoryIds) {
      attemptedEntries += 1;
      try {
        await vector.remove("memory", memoryId);
      } catch {
        failedEntries += 1;
        primaryFailedEntries += 1;
      }
    }
    for (const memoryId of deletions.unrestrictedMemory.deletedMemoryIds) {
      attemptedEntries += 1;
      try {
        await unrestrictedVector.remove("memory", memoryId);
      } catch {
        failedEntries += 1;
        unrestrictedFailedEntries += 1;
      }
    }
    if (failedEntries > 0) {
      this.reportPostCommitFailure({
        operation: "delete_session_vectors",
        sessionId: input.sessionId,
        attemptedEntries,
        failedEntries,
        requiresRebuild: true,
      });
    }
    if (operation.postCommitWarnings.length > 0) {
      let storageResetSucceeded = false;
      try {
        storageResetSucceeded = this.storageManager.close(storage.storageRoot);
      } catch {
        // The cache entry is evicted before close; a later access will open a clean connection.
      }
      this.reportPostCommitFailure({
        operation: "delete_session_storage_reset",
        sessionId: input.sessionId,
        warningCodes: ["unrestricted_memory_detach_failed"],
        storageResetSucceeded,
      });
    }

    return CompanionSessionDeleteResultSchema.parse({
      deleted: true,
      sessionId: input.sessionId,
      storages: storageStatuses,
      deletions,
      vectors: {
        primary: vectorStatusAfterDeletion(
          vectorStatusesBeforeDeletion.primary,
          deletions.primary.deletedSummaryIds.length
            + deletions.primary.deletedMemoryIds.length,
          primaryFailedEntries,
        ),
        unrestrictedMemory: vectorStatusAfterDeletion(
          vectorStatusesBeforeDeletion.unrestrictedMemory,
          deletions.unrestrictedMemory.deletedMemoryIds.length,
          unrestrictedFailedEntries,
        ),
      },
    });
  }

  listMessages(input: {
    storageRoot?: string;
    sessionId: string;
    limit?: number;
    outputMode?: CompanionOutputModeInput;
  }): CompanionSessionMessagesResult | null {
    const storage = this.storageManager.get(input.storageRoot);
    const session = storage.getSession(input.sessionId);
    if (!session) return null;
    const outputMode = normalizeCompanionOutputMode(input.outputMode);
    return CompanionSessionMessagesResultSchema.parse({
      storage: storage.status(),
      session,
      messages: filterMessagesForMode(storage.listMessages(input.sessionId, input.limit ?? 100), outputMode),
      summaries: filterSummariesForMode(storage.listSummaries(input.sessionId), outputMode),
      rawOutput: this.rawOutputStatus(),
    });
  }

  async chat(input: CompanionChatInput): Promise<CompanionChatResult> {
    return this.conversation.chat(input);
  }

  async presentAgentResult(
    input: CompanionAgentResultPresentationInput,
  ): Promise<CompanionAgentResultPresented> {
    return this.agentResultPresenter.present(input);
  }

  async summarize(input: {
    storageRoot?: string;
    sessionId: string;
    force?: boolean;
    outputMode?: CompanionOutputModeInput;
  }): Promise<CompanionSessionSummaryResult | null> {
    const storage = this.storageManager.get(input.storageRoot);
    const session = storage.getSession(input.sessionId);
    if (!session) return null;
    const outputMode = normalizeCompanionOutputMode(input.outputMode);
    return CompanionSessionSummaryResultSchema.parse({
      storage: storage.status(),
      session,
      summaryStatus: await this.knowledge.summarizeSession({
        storage,
        sessionId: input.sessionId,
        force: input.force === true,
        outputMode,
      }),
      summaries: storage.listSummaries(input.sessionId),
    });
  }

  async chatStream(
    input: CompanionChatInput,
    emit: (event: CompanionStreamEvent) => void,
    context: CompanionRunContext = {},
  ): Promise<void> {
    return this.conversation.chatStream(input, emit, context);
  }

  cancelRun(runId: string): CompanionRunCancelResult {
    return this.conversation.cancelRun(runId);
  }

  /** Starts proposal recovery after the application composition root is fully wired. */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.agentProposalOutbox) return;
    this.stopProposalRecovery = this.storageManager.onAccess((storage) => {
      void this.agentProposalOutbox?.recover(storage);
    });
    this.storageManager.get();
  }

  close(): void {
    this.conversation.close();
    this.stopProposalRecovery?.();
    this.stopProposalRecovery = undefined;
    this.started = false;
    this.storageManager.closeAll();
  }

  private reportPostCommitFailure(failure: CompanionPostCommitFailure): void {
    try {
      this.deps.onPostCommitFailure?.(failure);
    } catch {
      // Diagnostics must not turn an authoritative deletion into a failure.
    }
  }

}

function vectorStatusAfterDeletion(
  status: ReturnType<CompanionVectorIndex["status"]>,
  deletedEntries: number,
  failedEntries: number,
): ReturnType<CompanionVectorIndex["status"]> {
  const cleanupFailed = failedEntries > 0;
  const reason = cleanupFailed
    ? [status.reason, "delete_session_vector_cleanup_failed"].filter(Boolean).join(";")
    : status.reason;
  return {
    ...status,
    itemCount: Math.max(0, status.itemCount - deletedEntries),
    ...(cleanupFailed
      ? {
          degraded: true,
          requiresRebuild: true,
          reason,
        }
      : {}),
  };
}

async function updateConfirmedMemory(input: {
  storage: CompanionStorageHandle;
  vector: CompanionVectorIndex;
  memory: CompanionMemory;
  patch: CompanionMemoryUpdateRequest;
}): Promise<CompanionMemoryUpdateResult> {
  const { storage, vector, memory, patch } = input;
  if (patch.status === "rejected" || patch.status === "candidate") {
    throw new Error("已确认记忆不能降级；请使用 DELETE 删除记忆");
  }
  const normalized = normalizeCompanionMemoryInput({
    kind: patch.kind ?? memory.kind,
    key: patch.key ?? memory.key,
    value: patch.value ?? memory.value,
    summary: patch.summary ?? memory.summary,
    importance: patch.importance ?? memory.importance,
    confidence: patch.confidence ?? memory.confidence,
  });
  const policy = evaluateCompanionMemoryPolicy({
    ...normalized,
    outputMode: memory.outputMode,
    requestedStatus: "confirmed",
  });
  if (!policy.allowed) {
    return CompanionMemoryUpdateResultSchema.parse({
      outcome: "memory_blocked",
      changed: false,
      storage: storage.status(),
      memory,
      policy,
      vector: vector.status(),
    });
  }
  if (policy.statusDecision === "candidate") {
    return CompanionMemoryUpdateResultSchema.parse({
      outcome: "memory_review_required",
      changed: false,
      storage: storage.status(),
      memory,
      policy,
      vector: vector.status(),
    });
  }

  const changed = memoryValuesChanged(memory, normalized);
  const vectorChanged = memory.kind !== normalized.kind
    || memory.value !== normalized.value
    || memory.summary !== normalized.summary;
  const updated = changed
    ? storage.updateMemory(memory.id, normalized)
    : memory;
  if (!updated || updated.status !== "confirmed") {
    throw new Error("companion_memory_update_lost_record");
  }
  if (!policy.vectorEligible) await vector.remove("memory", memory.id);
  else if (vectorChanged) await vector.indexMemory(updated);
  return CompanionMemoryUpdateResultSchema.parse({
    outcome: "memory_updated",
    changed,
    storage: storage.status(),
    memory: updated,
    policy,
    vector: vector.status(),
  });
}

async function updateMemoryCandidate(input: {
  storage: CompanionStorageHandle;
  vector: CompanionVectorIndex;
  candidate: CompanionMemoryCandidate;
  patch: CompanionMemoryUpdateRequest;
}): Promise<CompanionMemoryUpdateResult> {
  const { storage, vector, candidate, patch } = input;
  if (candidate.status === "confirmed") {
    if (patch.status !== "confirmed" || hasEditableMemoryFields(patch)) {
      throw new Error("候选记忆已确认；后续编辑必须使用 confirmed memory id");
    }
    const memory = storage.getMemoryByCandidateId(candidate.id);
    if (!memory || memory.status !== "confirmed") {
      throw new Error("confirmed_candidate_missing_memory");
    }
    return CompanionMemoryUpdateResultSchema.parse({
      outcome: "candidate_already_confirmed",
      changed: false,
      storage: storage.status(),
      candidate,
      memory,
      vector: vector.status(),
    });
  }
  if (candidate.status === "rejected") {
    if (patch.status !== "rejected") throw new Error("已拒绝候选不能重新确认或编辑");
    return CompanionMemoryUpdateResultSchema.parse({
      outcome: "candidate_rejected",
      changed: false,
      storage: storage.status(),
      candidate,
      vector: vector.status(),
    });
  }
  if (candidate.status !== "candidate") throw new Error("候选记忆已结束，不能更新");

  if (patch.status === "rejected") {
    const rejected = storage.updateMemoryCandidate(candidate.id, { status: "rejected" });
    if (!rejected || rejected.status !== "rejected") {
      throw new Error("companion_memory_candidate_reject_lost_record");
    }
    return CompanionMemoryUpdateResultSchema.parse({
      outcome: "candidate_rejected",
      changed: true,
      storage: storage.status(),
      candidate: rejected,
      vector: vector.status(),
    });
  }
  if (
    patch.status !== "confirmed"
    && (patch.importance !== undefined || patch.confidence !== undefined)
  ) {
    throw new Error("importance 和 confidence 只能在确认候选时设置");
  }

  const normalized = normalizeCompanionMemoryInput({
    kind: patch.kind ?? candidate.kind,
    key: patch.key ?? candidate.key,
    value: patch.value ?? candidate.value,
    summary: patch.summary ?? candidate.summary,
    importance: patch.importance,
    confidence: patch.confidence,
  });
  const requestedStatus = patch.status === "confirmed" ? "confirmed" : "candidate";
  const policy = evaluateCompanionMemoryPolicy({
    ...normalized,
    outputMode: candidate.outputMode,
    requestedStatus,
  });
  if (!policy.allowed) {
    return CompanionMemoryUpdateResultSchema.parse({
      outcome: "candidate_blocked",
      changed: false,
      storage: storage.status(),
      candidate,
      policy,
      vector: vector.status(),
    });
  }
  if (requestedStatus === "confirmed" && policy.statusDecision === "confirmed") {
    const memory = storage.confirmMemoryCandidate(candidate.id, {
      kind: normalized.kind,
      key: normalized.key,
      value: normalized.value,
      summary: normalized.summary,
      sensitivity: policy.sensitivity,
      importance: normalized.importance,
      confidence: normalized.confidence,
    });
    const confirmedCandidate = storage.getMemoryCandidate(candidate.id);
    if (!memory || memory.status !== "confirmed" || confirmedCandidate?.status !== "confirmed") {
      throw new Error("companion_memory_candidate_confirmation_failed");
    }
    if (policy.vectorEligible) await vector.indexMemory(memory);
    else await vector.remove("memory", memory.id);
    return CompanionMemoryUpdateResultSchema.parse({
      outcome: "candidate_confirmed",
      changed: true,
      storage: storage.status(),
      candidate: confirmedCandidate,
      memory,
      policy,
      vector: vector.status(),
    });
  }
  if (policy.statusDecision !== "candidate") {
    throw new Error("companion_memory_candidate_policy_state_invalid");
  }
  const changed = candidateValuesChanged(candidate, normalized, policy.sensitivity);
  const updated = changed
    ? storage.updateMemoryCandidate(candidate.id, {
        kind: normalized.kind,
        key: normalized.key,
        value: normalized.value,
        summary: normalized.summary,
        sensitivity: policy.sensitivity,
        status: "candidate",
      })
    : candidate;
  if (!updated || updated.status !== "candidate") {
    throw new Error("companion_memory_candidate_update_lost_record");
  }
  return CompanionMemoryUpdateResultSchema.parse({
    outcome: "candidate_updated",
    changed,
    storage: storage.status(),
    candidate: updated,
    policy,
    vector: vector.status(),
  });
}

function hasEditableMemoryFields(patch: CompanionMemoryUpdateRequest): boolean {
  return "kind" in patch && [
    patch.kind,
    patch.key,
    patch.value,
    patch.summary,
    patch.importance,
    patch.confidence,
  ].some((value) => value !== undefined);
}

function memoryValuesChanged(
  memory: CompanionMemory,
  normalized: NormalizedCompanionMemoryInput,
): boolean {
  return memory.kind !== normalized.kind
    || memory.key !== normalized.key
    || memory.value !== normalized.value
    || memory.summary !== normalized.summary
    || memory.importance !== normalized.importance
    || memory.confidence !== normalized.confidence;
}

function candidateValuesChanged(
  candidate: CompanionMemoryCandidate,
  normalized: NormalizedCompanionMemoryInput,
  sensitivity: CompanionMemoryCandidate["sensitivity"],
): boolean {
  return candidate.kind !== normalized.kind
    || candidate.key !== normalized.key
    || candidate.value !== normalized.value
    || candidate.summary !== normalized.summary
    || candidate.sensitivity !== sensitivity;
}
