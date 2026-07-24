import { extractFileSnippetsFromToolMessages } from "./fileSnippets.js";
import { extractFilePathsFromText, isLikelyWorkspaceFile, normalizeWorkspacePath } from "./filePathExtract.js";
import type { DatabaseManager } from "./DatabaseManager.js";
import type { MemoryRetriever } from "./MemoryRetriever.js";
import { MemoryStore } from "./stores.js";
import type { StructuredSummary } from "./types.js";
import { deserializeRunStateFromJson } from "./historyFileRecallerRunState.js";

export type HistoryFileSource =
  | "summary_important_files"
  | "project_memory"
  | "task_memory"
  | "run_state_location"
  | "recent_tool"
  | "memory_retrieval"
  | "task_required_context";

export interface HistoryFileHit {
  path: string;
  score: number;
  source: HistoryFileSource;
  reason: string;
  lastSeenAt?: string;
}

export interface HistoryFileRecallInput {
  projectId?: string;
  query: string;
  sessionId?: string;
  taskId?: string;
  limit?: number;
}

export interface HistoryFileRecallResult {
  hits: HistoryFileHit[];
  sourcesUsed: HistoryFileSource[];
}

/** 结合摘要、项目记忆、历史 RunState 与近期工具消息召回相关文件。 */
export class HistoryFileRecaller {
  private readonly memories: MemoryStore;

  constructor(
    private readonly db: DatabaseManager,
    memories?: MemoryStore,
    private readonly memoryRetriever?: MemoryRetriever,
  ) {
    this.memories = memories ?? new MemoryStore(db);
  }

  async recall(input: HistoryFileRecallInput): Promise<HistoryFileRecallResult> {
    const limit = Math.max(1, input.limit ?? 16);
    const merged = new Map<string, HistoryFileHit>();
    const sourcesUsed = new Set<HistoryFileSource>();
    const projectId = input.projectId ?? "default";
    const sessionIds = this.resolveSessionIds(projectId, input.sessionId);

    const add = (hit: Omit<HistoryFileHit, "path"> & { path: string }): void => {
      const path = normalizeWorkspacePath(hit.path);
      if (!isLikelyWorkspaceFile(path)) return;
      sourcesUsed.add(hit.source);
      const existing = merged.get(path);
      if (!existing || hit.score > existing.score) {
        merged.set(path, { ...hit, path });
      }
    };

    this.recallFromSummaries(projectId, sessionIds, add);
    this.recallFromMemories(projectId, input.taskId, input.query, add);
    this.recallFromRunStates(sessionIds, add);
    await this.recallFromRecentTools(sessionIds, add);
    this.recallFromTaskContext(projectId, sessionIds, add);
    await this.recallFromMemoryRetriever(input, projectId, add);

    const hits = [...merged.values()]
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, limit);

    return { hits, sourcesUsed: [...sourcesUsed] };
  }

  private resolveSessionIds(projectId: string, sessionId?: string): string[] {
    const ids = new Set<string>();
    if (sessionId) ids.add(sessionId);
    const rows = this.db.connection
      .prepare(
        `SELECT id FROM sessions
         WHERE project_id=? OR id=?
         ORDER BY updated_at DESC LIMIT 12`,
      )
      .all(projectId, sessionId ?? "") as Array<{ id: string }>;
    for (const row of rows) ids.add(row.id);
    return [...ids];
  }

  private recallFromSummaries(
    projectId: string,
    sessionIds: string[],
    add: (hit: HistoryFileHit) => void,
  ): void {
    const rows = sessionIds.length
      ? (this.db.connection
          .prepare(
            `SELECT content, updated_at FROM conversation_summaries
             WHERE project_id=? OR session_id IN (${sessionIds.map(() => "?").join(",")})
             ORDER BY updated_at DESC LIMIT 24`,
          )
          .all(projectId, ...sessionIds) as Array<{ content: string; updated_at: string }>)
      : (this.db.connection
          .prepare(
            `SELECT content, updated_at FROM conversation_summaries
             WHERE project_id=?
             ORDER BY updated_at DESC LIMIT 24`,
          )
          .all(projectId) as Array<{ content: string; updated_at: string }>);

    for (const row of rows) {
      let summary: StructuredSummary;
      try {
        summary = JSON.parse(row.content) as StructuredSummary;
      } catch {
        continue;
      }
      for (const file of summary.important_files ?? []) {
        add({
          path: file,
          score: 0.86,
          source: "summary_important_files",
          reason: "会话摘要标记的重要文件",
          lastSeenAt: row.updated_at,
        });
      }
      for (const file of extractFilePathsFromText(row.content)) {
        add({
          path: file,
          score: 0.62,
          source: "summary_important_files",
          reason: "摘要正文提及的文件路径",
          lastSeenAt: row.updated_at,
        });
      }
    }
  }

  private recallFromMemories(
    projectId: string,
    taskId: string | undefined,
    query: string,
    add: (hit: HistoryFileHit) => void,
  ): void {
    for (const memory of this.memories.listActive("project", projectId, 12)) {
      const text = `${memory.key ?? ""}\n${memory.value}\n${memory.summary ?? ""}`;
      const queryHit = query.trim() && text.toLowerCase().includes(query.trim().toLowerCase());
      for (const file of extractFilePathsFromText(text)) {
        add({
          path: file,
          score: queryHit ? 0.74 : 0.58 + memory.importance * 0.1,
          source: "project_memory",
          reason: `项目记忆（${memory.memoryType}）`,
          lastSeenAt: memory.lastUsedAt ?? memory.updatedAt,
        });
      }
    }
    if (taskId) {
      for (const memory of this.memories.listActive("task", taskId, 8)) {
        for (const file of extractFilePathsFromText(`${memory.value}\n${memory.summary ?? ""}`)) {
          add({
            path: file,
            score: 0.72,
            source: "task_memory",
            reason: "历史任务记忆",
            lastSeenAt: memory.updatedAt,
          });
        }
      }
    }
    if (query.trim()) {
      for (const memory of this.memories.searchActive(query.trim(), 8)) {
        for (const file of extractFilePathsFromText(`${memory.value}\n${memory.summary ?? ""}`)) {
          add({
            path: file,
            score: 0.66,
            source: "project_memory",
            reason: "记忆 FTS 命中",
            lastSeenAt: memory.updatedAt,
          });
        }
      }
    }
  }

  private recallFromRunStates(sessionIds: string[], add: (hit: HistoryFileHit) => void): void {
    if (!sessionIds.length) return;
    const rows = this.db.connection
      .prepare(
        `SELECT state_json, updated_at FROM run_states
         WHERE session_id IN (${sessionIds.map(() => "?").join(",")})
         ORDER BY updated_at DESC LIMIT 20`,
      )
      .all(...sessionIds) as Array<{ state_json: string; updated_at: string }>;

    for (const row of rows) {
      const state = deserializeRunStateFromJson(row.state_json);
      for (const file of state.readFiles ?? []) {
        add({
          path: file,
          score: 0.68,
          source: "run_state_location",
          reason: "历史 Run 已读文件",
          lastSeenAt: row.updated_at,
        });
      }
      const location = state.location;
      if (!location) continue;
      for (const file of location.primaryFiles ?? []) {
        add({
          path: file,
          score: 0.82,
          source: "run_state_location",
          reason: "历史 Run 定位 primary",
          lastSeenAt: row.updated_at,
        });
      }
      for (const file of location.candidateFiles ?? []) {
        add({
          path: file,
          score: 0.7,
          source: "run_state_location",
          reason: "历史 Run 定位 candidate",
          lastSeenAt: row.updated_at,
        });
      }
      for (const file of location.visitedFiles ?? []) {
        add({
          path: file,
          score: 0.56,
          source: "run_state_location",
          reason: "历史 Run 已访问文件",
          lastSeenAt: row.updated_at,
        });
      }
    }
  }

  private async recallFromRecentTools(
    sessionIds: string[],
    add: (hit: HistoryFileHit) => void,
  ): Promise<void> {
    if (!sessionIds.length) return;
    const rows = this.db.connection
      .prepare(
        `SELECT id, content, created_at FROM messages
         WHERE session_id IN (${sessionIds.map(() => "?").join(",")}) AND role='tool'
         ORDER BY created_at DESC LIMIT 36`,
      )
      .all(...sessionIds) as Array<{ id: string; content: string; created_at: string }>;
    const snippets = extractFileSnippetsFromToolMessages(rows, { maxSnippets: 12 });
    for (const snippet of snippets) {
      add({
        path: snippet.path,
        score: 0.54,
        source: "recent_tool",
        reason: `近期工具 ${snippet.tool}`,
        lastSeenAt: rows.find((r) => r.id === snippet.messageId)?.created_at,
      });
    }
  }

  private recallFromTaskContext(
    projectId: string,
    sessionIds: string[],
    add: (hit: HistoryFileHit) => void,
  ): void {
    const rows = sessionIds.length
      ? (this.db.connection
          .prepare(
            `SELECT ts.required_context_json, ts.updated_at
             FROM task_steps ts
             JOIN tasks t ON t.id = ts.task_id
             WHERE t.project_id=? OR t.session_id IN (${sessionIds.map(() => "?").join(",")})
             ORDER BY ts.updated_at DESC LIMIT 30`,
          )
          .all(projectId, ...sessionIds) as Array<{ required_context_json: string | null; updated_at: string }>)
      : (this.db.connection
          .prepare(
            `SELECT ts.required_context_json, ts.updated_at
             FROM task_steps ts
             JOIN tasks t ON t.id = ts.task_id
             WHERE t.project_id=?
             ORDER BY ts.updated_at DESC LIMIT 30`,
          )
          .all(projectId) as Array<{ required_context_json: string | null; updated_at: string }>);

    for (const row of rows) {
      if (!row.required_context_json) continue;
      let paths: string[] = [];
      try {
        const parsed = JSON.parse(row.required_context_json) as unknown;
        if (Array.isArray(parsed)) {
          paths = parsed.filter((item): item is string => typeof item === "string");
        }
      } catch {
        continue;
      }
      for (const file of paths) {
        add({
          path: file,
          score: 0.76,
          source: "task_required_context",
          reason: "历史任务步骤 requiredContext",
          lastSeenAt: row.updated_at,
        });
      }
    }
  }

  private async recallFromMemoryRetriever(
    input: HistoryFileRecallInput,
    projectId: string,
    add: (hit: HistoryFileHit) => void,
  ): Promise<void> {
    if (!this.memoryRetriever || !input.query.trim() || !input.sessionId) return;
    const retrieved = await this.memoryRetriever.retrieve({
      userInput: input.query,
      sessionId: input.sessionId,
      projectId,
      taskId: input.taskId,
      limit: 8,
    });
    for (const item of retrieved) {
      const text = `${item.memory.value}\n${item.memory.summary ?? ""}`;
      for (const file of extractFilePathsFromText(text)) {
        add({
          path: file,
          score: Math.min(0.84, 0.5 + item.score * 0.35),
          source: "memory_retrieval",
          reason: `记忆检索（${item.reason}）`,
          lastSeenAt: item.memory.lastUsedAt ?? item.memory.updatedAt,
        });
      }
    }
  }
}
