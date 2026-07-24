import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { redactValue } from "../util/redact.js";
import { compactToolOutputForModel } from "../util/toolResultLayers.js";

import type { ChatMessage, ToolCall } from "../model/types.js";
import { ContextRestorer } from "./ContextRestorer.js";
import { ContextStructuredSummarySchema } from "./ContextContracts.js";
import { extractFileSnippetsFromToolMessages } from "./fileSnippets.js";
import { DatabaseManager } from "./DatabaseManager.js";
import { EmbeddingService } from "./EmbeddingService.js";
import { RuleMemoryExtractor, type IMemoryExtractor } from "./MemoryExtractor.js";
import { MemoryManager } from "./MemoryManager.js";
import { MemoryRetriever } from "./MemoryRetriever.js";
import { PromptBuilder } from "./PromptBuilder.js";
import { RunFactsLookup } from "./runFactsLookup.js";
import { SemanticRetriever } from "./SemanticRetriever.js";
import { SummaryManager } from "./SummaryManager.js";
import { SystemSectionBuilder } from "./SystemSectionBuilder.js";
import type { MessageAppendMeta } from "./MessageStore.js";
import { createContentEnvelope } from "./messageEnvelope.js";
import type { MessageEnvelopeInput } from "./messageEnvelope.js";
import {
  MemoryStore,
  MessageStore,
  ProjectStore,
  SessionStore,
  SummaryStore,
  TaskStore,
} from "./stores.js";
import type {
  ContextDebugSnapshot,
  ContextPackage,
  ContextPhase,
  MemoryCandidate,
  MemoryRecord,
  MemoryScope,
  MemoryType,
  MessageRecord,
  RenderedPrompt,
  SearchHit,
  SessionRecord,
  StructuredSummary,
  SummarizeFn,
  SummaryRecord,
} from "./types.js";
import { createVectorStore, type VectorStore } from "./VectorStore.js";

export interface ContextManagerOptions {
  dataDir: string;
  messageThreshold?: number;
  recentMessageCount?: number;
  summarize?: SummarizeFn;
  embeddingService?: EmbeddingService;
  vectorStore?: VectorStore;
  useLanceDb?: boolean;
  largeToolOutputChars?: number;
  memoryExtractor?: IMemoryExtractor;
}

/**
 * M6 门面：消息持久化、摘要压缩、上下文恢复、记忆与检索。
 */
export class ContextManager {
  readonly db: DatabaseManager;
  readonly sessions: SessionStore;
  readonly messages: MessageStore;
  readonly summaries: SummaryStore;
  readonly memories: MemoryStore;
  readonly projects: ProjectStore;
  readonly tasks: TaskStore;
  readonly summaryManager: SummaryManager;
  readonly restorer: ContextRestorer;
  readonly retriever: MemoryRetriever;
  readonly semanticRetriever: SemanticRetriever;
  readonly memoryManager: MemoryManager;
  readonly memoryExtractor: IMemoryExtractor;
  readonly sectionBuilder: SystemSectionBuilder;
  readonly promptBuilder: PromptBuilder;
  readonly embeddings: EmbeddingService;
  readonly vectors: VectorStore;

  private readonly largeToolChars: number;

  constructor(options: ContextManagerOptions) {
    this.db = new DatabaseManager(options.dataDir);
    this.sessions = new SessionStore(this.db);
    this.messages = new MessageStore(this.db);
    this.summaries = new SummaryStore(this.db);
    this.memories = new MemoryStore(this.db);
    this.projects = new ProjectStore(this.db);
    this.tasks = new TaskStore(this.db);
    this.embeddings = options.embeddingService ?? new EmbeddingService();
    this.vectors =
      options.vectorStore ??
      createVectorStore(
        options.dataDir,
        options.useLanceDb !== false,
        this.embeddings.dimension,
      );
    this.memoryManager = new MemoryManager(this.memories);
    this.memoryExtractor = options.memoryExtractor ?? new RuleMemoryExtractor();
    this.sectionBuilder = new SystemSectionBuilder();
    this.promptBuilder = new PromptBuilder();
    this.summaryManager = new SummaryManager(this.messages, this.summaries, {
      messageThreshold: options.messageThreshold,
      summarize: options.summarize,
    });
    this.semanticRetriever = new SemanticRetriever(this.db, this.embeddings, this.vectors);
    this.retriever = new MemoryRetriever(
      this.db,
      this.memories,
      this.memoryManager,
      this.embeddings,
      this.vectors,
    );
    this.restorer = new ContextRestorer(
      this.sessions,
      this.messages,
      this.summaries,
      this.projects,
      this.tasks,
      this.retriever,
      this.semanticRetriever,
      this.sectionBuilder,
      this.memoryManager,
      new RunFactsLookup(this.db),
      { recentMessageCount: options.recentMessageCount },
    );
    this.largeToolChars = options.largeToolOutputChars ?? 4000;
  }

  createSession(title?: string, projectId?: string, workspaceKey?: string): SessionRecord {
    return this.sessions.create(title, projectId, workspaceKey);
  }

  createProject(name: string, rootPath?: string, description?: string) {
    return this.projects.create(name, rootPath, description);
  }

  getSession(id: string): SessionRecord | null {
    return this.sessions.get(id);
  }

  setActiveTask(sessionId: string, taskId: string | null): void {
    this.sessions.setActiveTask(sessionId, taskId);
  }

  listSessions(): SessionRecord[] {
    return this.sessions.list();
  }

  updateSessionTitle(id: string, title: string): SessionRecord | null {
    return this.sessions.updateTitle(id, title);
  }

  /** 删除会话及其消息、摘要、会话级记忆与关联任务/运行记录。 */
  deleteSession(sessionId: string): boolean {
    if (!this.sessions.get(sessionId)) return false;
    const conn = this.db.connection;
    conn.exec("BEGIN");
    try {
      const messageRows = conn
        .prepare(`SELECT id FROM messages WHERE session_id=?`)
        .all(sessionId) as Array<{ id: string }>;
      for (const { id } of messageRows) {
        this.db.deleteFts("messages_fts", id);
      }

      const summaryRows = conn
        .prepare(`SELECT id FROM conversation_summaries WHERE session_id=?`)
        .all(sessionId) as Array<{ id: string }>;
      for (const { id } of summaryRows) {
        this.db.deleteFts("summaries_fts", id);
      }

      const memoryRows = conn
        .prepare(`SELECT id FROM memories WHERE scope='session' AND scope_id=?`)
        .all(sessionId) as Array<{ id: string }>;
      for (const { id } of memoryRows) {
        this.db.deleteFts("memories_fts", id);
      }

      const taskRows = conn
        .prepare(`SELECT id FROM tasks WHERE session_id=?`)
        .all(sessionId) as Array<{ id: string }>;
      for (const { id: taskId } of taskRows) {
        conn.prepare(`DELETE FROM task_step_dependencies WHERE task_id=?`).run(taskId);
        conn.prepare(`DELETE FROM task_attempts WHERE task_id=?`).run(taskId);
        conn.prepare(`DELETE FROM task_steps WHERE task_id=?`).run(taskId);
        conn.prepare(`DELETE FROM tasks WHERE id=?`).run(taskId);
      }

      const runRows = conn
        .prepare(`SELECT id FROM runs WHERE session_id=?`)
        .all(sessionId) as Array<{ id: string }>;
      for (const { id: runId } of runRows) {
        conn.prepare(`DELETE FROM run_states WHERE run_id=?`).run(runId);
      }
      conn.prepare(`DELETE FROM runs WHERE session_id=?`).run(sessionId);
      conn.prepare(`DELETE FROM user_visible_plans WHERE session_id=?`).run(sessionId);
      conn.prepare(`DELETE FROM conversation_summaries WHERE session_id=?`).run(sessionId);
      conn.prepare(`DELETE FROM messages WHERE session_id=?`).run(sessionId);
      conn.prepare(`DELETE FROM memories WHERE scope='session' AND scope_id=?`).run(sessionId);
      this.sessions.delete(sessionId);
      conn.exec("COMMIT");
      return true;
    } catch (error) {
      conn.exec("ROLLBACK");
      throw error;
    }
  }

  /** @deprecated 请使用 saveUserMessage / saveAssistantMessage / saveToolMessage */
  appendMessage(sessionId: string, role: string, content: string): MessageRecord {
    return this.saveMessage(sessionId, role, content);
  }

  saveUserMessage(sessionId: string, content: string, runId?: string): MessageRecord {
    return this.saveMessage(sessionId, "user", content, undefined, {
      messageKind: "user_input",
      uiVisible: true,
      contentEnvelope: createContentEnvelope({
        origin: "user",
        evidence: "user_authored",
        verified: true,
        instructionAuthority: "user",
        externalContent: false,
        egressAllowed: ["model"],
        provenance: { runId },
      }),
      runId,
    });
  }

  saveAssistantToolAction(
    sessionId: string,
    content: string,
    runId: string | undefined,
    model?: { clientName?: string; modelName?: string; toolCalls?: ToolCall[] },
  ): MessageRecord {
    return this.saveMessage(sessionId, "assistant", content, model, {
      messageKind: "tool_action",
      uiVisible: false,
      contentEnvelope: createContentEnvelope({
        origin: "model",
        evidence: "unverified",
        verified: false,
        instructionAuthority: "data",
        externalContent: true,
        egressAllowed: [],
        provenance: { runId, providerId: model?.clientName },
      }),
      runId,
    }, { toolCalls: model?.toolCalls });
  }

  saveRawModelFinal(
    sessionId: string,
    answer: string,
    runId: string | undefined,
    model?: { clientName?: string; modelName?: string },
  ): MessageRecord {
    const content = JSON.stringify({ action: "final", answer });
    return this.saveMessage(sessionId, "assistant", content, model, {
      messageKind: "raw_model_final",
      uiVisible: false,
      contentEnvelope: createContentEnvelope({
        origin: "model",
        evidence: "unverified",
        verified: false,
        instructionAuthority: "data",
        externalContent: true,
        egressAllowed: [],
        provenance: { runId, providerId: model?.clientName },
      }),
      runId,
    });
  }

  saveGuardedFinalAnswer(
    sessionId: string,
    answer: string,
    runId: string | undefined,
  ): MessageRecord {
    return this.saveMessage(sessionId, "assistant", answer, undefined, {
      messageKind: "final_answer",
      uiVisible: true,
      contentEnvelope: createContentEnvelope({
        origin: "guard",
        evidence: "completion_guard",
        verified: true,
        instructionAuthority: "data",
        externalContent: false,
        egressAllowed: ["model"],
        provenance: { runId },
      }),
      runId,
    });
  }

  saveGuardAcceptedModelFinalAnswer(
    sessionId: string,
    answer: string,
    runId: string | undefined,
    model?: { clientName?: string; modelName?: string },
  ): MessageRecord {
    return this.saveMessage(sessionId, "assistant", answer, model, {
      messageKind: "final_answer",
      uiVisible: true,
      contentEnvelope: createContentEnvelope({
        origin: "model",
        evidence: "completion_guard",
        verified: true,
        instructionAuthority: "data",
        externalContent: true,
        egressAllowed: ["model"],
        provenance: { runId, providerId: model?.clientName },
      }),
      runId,
    });
  }

  saveConversationalReply(
    sessionId: string,
    answer: string,
    runId: string | undefined,
    model?: { clientName?: string; modelName?: string },
  ): MessageRecord {
    return this.saveMessage(sessionId, "assistant", answer, model, {
      messageKind: "conversational_reply",
      uiVisible: true,
      contentEnvelope: createContentEnvelope({
        origin: "model",
        evidence: "conversational_reply",
        verified: true,
        instructionAuthority: "data",
        externalContent: true,
        egressAllowed: ["model"],
        provenance: { runId, providerId: model?.clientName },
      }),
      runId,
    });
  }

  /** @deprecated 请使用语义化 save* 方法 */
  saveAssistantMessage(
    sessionId: string,
    content: string,
    model?: { clientName?: string; modelName?: string },
  ): MessageRecord {
    return this.saveMessage(sessionId, "assistant", content, model);
  }

  /** 运行态 system；默认不进入已验证上下文。 */
  saveSystemMessage(sessionId: string, content: string, runId?: string): MessageRecord {
    return this.saveMessage(sessionId, "system", content, undefined, {
      messageKind: "workflow_event",
      uiVisible: false,
      contentEnvelope: createContentEnvelope({
        origin: "workflow",
        evidence: "unverified",
        verified: false,
        instructionAuthority: "data",
        externalContent: false,
        egressAllowed: [],
        provenance: { runId },
      }),
      runId,
    });
  }

  saveToolMessage(
    sessionId: string,
    content: string,
    runId?: string,
    meta?: {
      outcomeClass?: string;
      outcomeKind?: string;
      toolName?: string;
      toolCallId?: string;
      ledgerBacked?: boolean;
    },
  ): MessageRecord {
    const ledgerBacked =
      meta?.ledgerBacked ??
      (meta?.outcomeClass === "observation_success" &&
        meta?.outcomeKind !== "not_found" &&
        meta?.outcomeKind !== "no_results");
    return this.saveMessage(sessionId, "tool", content, undefined, {
      messageKind: "tool_result",
      uiVisible: false,
      contentEnvelope: createContentEnvelope({
        origin: "tool",
        evidence: ledgerBacked ? "tool_ledger" : "unverified",
        verified: ledgerBacked,
        instructionAuthority: "data",
        externalContent: true,
        egressAllowed: ledgerBacked ? ["model"] : [],
        provenance: {
          runId: runId ?? meta?.toolCallId,
          toolCallId: meta?.toolCallId,
        },
      }),
      runId: runId ?? meta?.toolCallId,
      ledgerBacked,
      outcomeClass: meta?.outcomeClass,
      outcomeKind: meta?.outcomeKind,
    }, {
      toolName: meta?.toolName,
      toolCallId: meta?.toolCallId,
    });
  }

  private saveMessage(
    sessionId: string,
    role: string,
    content: string,
    model?: { clientName?: string; modelName?: string },
    envelope?: MessageEnvelopeInput,
    protocol?: Pick<MessageAppendMeta, "toolName" | "toolCallId" | "toolCalls">,
  ): MessageRecord {
    const meta: MessageAppendMeta = {
      clientName: model?.clientName,
      modelName: model?.modelName,
      envelope,
      ...protocol,
    };
    const msg = this.messages.append(sessionId, role, content, meta);
    this.sessions.touch(sessionId, msg.id);
    this.appendMessageLog(sessionId, msg);
    return msg;
  }

  compactToolOutput(tool: string, output: unknown): unknown {
    return compactToolOutputForModel(tool, output, this.largeToolChars).modelVisible;
  }

  /** 恢复结构化上下文（运行时快照，不持久化 contextPackage 本身）。 */
  async restoreContextPackage(sessionId: string, query?: string): Promise<ContextPackage> {
    this.summaryManager.ensureSessionSummary(sessionId);
    return this.restorer.restore({
      sessionId,
      userInput: query,
    });
  }

  buildChatMessages(
    contextPackage: ContextPackage,
    systemBase: string,
    options?: { phase?: ContextPhase; currentUser?: string },
  ): ChatMessage[] {
    const phase = options?.phase ?? "pre_call";
    return this.promptBuilder.build({
      systemBase,
      systemSections: contextPackage.systemSections,
      messages: contextPackage.messages,
      phase,
      currentUser: phase === "pre_call" ? options?.currentUser : undefined,
    });
  }

  /** 从 contextPackage 生成调试用的渲染结果，不写回 contextPackage。 */
  buildRenderedPrompt(
    contextPackage: ContextPackage,
    systemBase: string,
    options?: { phase?: ContextPhase; currentUser?: string },
  ): RenderedPrompt {
    const phase = options?.phase ?? "pre_call";
    return {
      systemSectionsText: this.promptBuilder.renderSystemSectionsText(
        contextPackage.systemSections,
      ),
      finalMessages: this.buildChatMessages(contextPackage, systemBase, {
        phase,
        currentUser: phase === "pre_call" ? options?.currentUser : undefined,
      }),
    };
  }

  /** 组装带 phase 的调试快照（不持久化）。 */
  async buildContextSnapshot(
    sessionId: string,
    options: {
      phase: ContextPhase;
      userInput?: string;
      systemBase?: string;
      currentUser?: string;
    },
  ): Promise<ContextDebugSnapshot> {
    const contextPackage = await this.restoreContextPackage(sessionId, options.userInput);
    const renderedPrompt = this.buildRenderedPrompt(contextPackage, options.systemBase ?? "", {
      phase: options.phase,
      currentUser: options.phase === "pre_call" ? options.currentUser : undefined,
    });
    return { phase: options.phase, contextPackage, renderedPrompt };
  }

  async finalizeTurn(sessionId: string, query?: string): Promise<{
    compressed: SummaryRecord | null;
    postCall: ContextDebugSnapshot;
  }> {
    await this.extractAndUpsertMemories(sessionId);

    const compressed = await this.summaryManager.compressIfNeeded(sessionId);
    if (compressed) {
      const json = JSON.stringify(compressed.content);
      await this.retriever.indexSummary(
        compressed.id,
        json,
        "session",
        sessionId,
        compressed.content.current_goal,
        compressed.summaryType,
        compressed.content,
      );
      const fromSummary = await this.memoryExtractor.extractFromSummary(compressed);
      this.upsertCandidates(fromSummary, "candidate");
    }

    const recentTools = this.messages.listRecentByRole(sessionId, "tool", 8);
    for (const snippet of extractFileSnippetsFromToolMessages(recentTools)) {
      void this.semanticRetriever
        .indexCodeFragment({
          sourceId: snippet.messageId,
          path: snippet.path,
          content: snippet.preview,
          scope: "session",
          scopeId: sessionId,
          tags: snippet.tags,
        })
        .catch((error) => {
          this.logContextError("context_index_code_fragment_failed", {
            messageId: snippet.messageId,
            path: snippet.path,
            error: String(error),
          });
        });
    }

    const postCall = await this.buildContextSnapshot(sessionId, {
      phase: "post_call",
      userInput: query,
    });
    return { compressed, postCall };
  }

  /** 从近期 user 消息与摘要抽取并写入长期记忆（主数据落 SQLite/LanceDB）。 */
  async extractAndUpsertMemories(sessionId: string): Promise<MemoryRecord[]> {
    const recentUsers = this.messages.listRecentByRole(sessionId, "user", 10);
    const candidates = await this.memoryExtractor.extractFromMessages(recentUsers);
    return this.upsertCandidates(candidates, "active");
  }

  private upsertCandidates(
    candidates: MemoryCandidate[],
    lifecycleState: "candidate" | "active",
  ): MemoryRecord[] {
    return candidates.map((c) =>
      this.upsertMemory({
        scope: c.scope,
        scopeId: c.scopeId,
        memoryType: c.memoryType,
        key: c.key,
        value: c.value,
        summary: c.summary,
        importance: c.importance,
        confidence: c.confidence,
        provenance: c.provenance,
        sensitivity: c.sensitivity,
        retentionUntil: c.retentionUntil,
        lifecycleState,
      }),
    );
  }

  upsertMemory(input: {
    scope: MemoryScope;
    scopeId?: string;
    memoryType: MemoryType;
    key?: string;
    value: string;
    summary?: string;
    importance?: number;
    confidence?: number;
    provenance?: MemoryCandidate["provenance"];
    sensitivity?: MemoryCandidate["sensitivity"];
    retentionUntil?: string;
    lifecycleState?: "candidate" | "active";
  }): MemoryRecord {
    const record = this.memoryManager.upsert({
      ...input,
      provenance: input.provenance ?? {
        origin: "user",
        evidence: "explicit_user_memory_update",
      },
    }, input.lifecycleState ?? "active");
    if (record.lifecycleState === "active") void this.retriever
      .indexMemory(
        record.id,
        record.value,
        record.scope,
        record.scopeId,
        record.summary,
        record.memoryType,
      )
      .catch((error) => {
        this.logContextError("context_index_memory_failed", {
          memoryId: record.id,
          error: String(error),
        });
      });
    return record;
  }

  getMemory(id: string): MemoryRecord | null {
    return this.memories.get(id);
  }

  deactivateMemory(memoryId: string, reason: string): boolean {
    const existing = this.memories.get(memoryId);
    if (existing?.lifecycleState !== "active") return false;
    this.memoryManager.transition(memoryId, reason === "expired" ? "expired" : "rejected");
    void this.vectors.deleteBySource(memoryId).catch(() => undefined);
    return true;
  }

  confirmMemory(memoryId: string): MemoryRecord {
    const memory = this.memoryManager.transition(memoryId, "active");
    void this.retriever.indexMemory(
      memory.id,
      memory.value,
      memory.scope,
      memory.scopeId,
      memory.summary,
      memory.memoryType,
    );
    return memory;
  }

  deleteMemory(memoryId: string): boolean {
    const deleted = this.memoryManager.delete(memoryId);
    if (deleted) void this.vectors.deleteBySource(memoryId);
    return deleted;
  }

  listMemories(scope?: MemoryScope, scopeId?: string): MemoryRecord[] {
    if (!scope) {
      return [
        ...this.memories.listActive("global"),
        ...this.memories.listActive("session", scopeId),
      ];
    }
    return this.memories.listActive(scope, scopeId);
  }

  search(
    query: string,
    scope?: MemoryScope,
    scopeId?: string,
    tags?: string[],
  ): Promise<SearchHit[]> {
    return this.retriever.search(query, scope, scopeId, tags);
  }

  close(): void {
    this.db.close();
  }

  private appendMessageLog(
    sessionId: string,
    msg: { id: string; role: string; content: string; createdAt: string },
  ): void {
    const logDir = path.join(this.db.filesDir, "..", "logs", "messages");
    mkdirSync(logDir, { recursive: true });
    const file = path.join(logDir, `${sessionId}.jsonl`);
    appendFileSync(
      file,
      `${JSON.stringify({ id: msg.id, role: msg.role, content: msg.content, at: msg.createdAt })}\n`,
      "utf-8",
    );
  }

  private logContextError(type: string, data: Record<string, unknown>): void {
    try {
      appendFileSync(
        path.join(this.db.filesDir, "..", "logs", "context-errors.jsonl"),
        `${JSON.stringify(redactValue({ type, ...data, at: new Date().toISOString() }))}\n`,
        "utf-8",
      );
    } catch {
      // 日志写入失败不应影响主请求。
    }
  }
}

/** 用 LLM 生成结构化摘要（供生产环境注入 SummaryManager）。 */
export function createLlmSummarize(
  chat: (prompt: string) => Promise<string>,
): SummarizeFn {
  return async (messages) => {
    const transcript = messages
      .map((m) => `[${m.role}] ${m.content.slice(0, 500)}`)
      .join("\n");
    const prompt = [
      "请将以下对话片段压缩为 JSON 摘要，字段：",
      "current_goal, important_decisions[], user_preferences[], project_state[],",
      "open_questions[], recent_changes[], important_files[], tool_results[], errors_seen[]",
      "只输出 JSON，不要其它文字。",
      "",
      transcript,
    ].join("\n");
    const raw = await chat(prompt);
    try {
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start >= 0 && end > start) {
        const parsed = ContextStructuredSummarySchema.safeParse(
          JSON.parse(raw.slice(start, end + 1)) as unknown,
        );
        if (parsed.success) {
          return {
            schemaVersion: 1,
            content: parsed.data,
            generationState: "model",
          };
        }
      }
    } catch {
      // fallback
    }
    return {
      schemaVersion: 1,
      content: { current_goal: messages.find((message) => message.role === "user")?.content.slice(0, 300) },
      generationState: "degraded",
      degradedReason: "model_summary_schema_invalid",
    };
  };
}
