import { randomUUID } from "node:crypto";

import type { DatabaseManager } from "./DatabaseManager.js";
import { estimateTokens } from "./DatabaseManager.js";
import { ContextStructuredSummarySchema } from "./ContextContracts.js";
export { MessageStore } from "./MessageStore.js";
export { SessionStore } from "./SessionStore.js";
import type {
  MemoryRecord,
  MemoryLifecycleState,
  MemoryProvenance,
  MemoryScope,
  MemorySensitivity,
  MemoryType,
  ProjectRecord,
  StructuredSummary,
  SummaryRecord,
  SummaryType,
  TaskAttemptRecord,
  TaskRecord,
  TaskStepRecord,
} from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function parseSummary(content: string): StructuredSummary {
  const parsed = ContextStructuredSummarySchema.safeParse(JSON.parse(content) as unknown);
  if (!parsed.success) throw new Error("summary_schema_invalid");
  return parsed.data;
}

export class SummaryStore {
  constructor(private readonly db: DatabaseManager) {}

  save(input: {
    sessionId: string;
    projectId?: string;
    summaryType: SummaryType;
    content: StructuredSummary;
    startMessageId?: string;
    endMessageId?: string;
    tokenCount?: number;
    generationState: "model" | "derived" | "degraded";
    degradedReason?: string;
  }): SummaryRecord {
    const id = randomUUID();
    const ts = nowIso();
    const json = JSON.stringify(input.content);
    const tokens = input.tokenCount ?? estimateTokens(json);
    this.db.connection
      .prepare(
        `INSERT INTO conversation_summaries
         (id, session_id, project_id, summary_type, content, structured_json,
          start_message_id, end_message_id, token_count, schema_version,
          generation_state, degraded_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.projectId ?? null,
        input.summaryType,
        json,
        json,
        input.startMessageId ?? null,
        input.endMessageId ?? null,
        tokens,
        input.generationState,
        input.degradedReason ?? null,
        ts,
        ts,
      );
    this.db.upsertFts("summaries_fts", id, json);
    return {
      id,
      sessionId: input.sessionId,
      projectId: input.projectId,
      summaryType: input.summaryType,
      content: input.content,
      contentText: json,
      structuredJson: json,
      startMessageId: input.startMessageId,
      endMessageId: input.endMessageId,
      tokenCount: tokens,
      schemaVersion: 1,
      generationState: input.generationState,
      degradedReason: input.degradedReason,
      createdAt: ts,
      updatedAt: ts,
    };
  }

  latestByType(sessionId: string, summaryType: SummaryType): SummaryRecord | null {
    const row = this.db.connection
      .prepare(
        `SELECT * FROM conversation_summaries
         WHERE session_id=? AND summary_type=?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(sessionId, summaryType) as Record<string, unknown> | undefined;
    return row ? mapSummary(row) : null;
  }

  listBySession(sessionId: string): SummaryRecord[] {
    const rows = this.db.connection
      .prepare(
        `SELECT * FROM conversation_summaries WHERE session_id=? ORDER BY created_at ASC`,
      )
      .all(sessionId) as Record<string, unknown>[];
    return rows.map(mapSummary);
  }

  lastChunkEndMessageId(sessionId: string): string | undefined {
    const row = this.db.connection
      .prepare(
        `SELECT end_message_id FROM conversation_summaries
         WHERE session_id=? AND summary_type='chunk_summary' AND end_message_id IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(sessionId) as { end_message_id: string | null } | undefined;
    return row?.end_message_id ?? undefined;
  }
}

export class MemoryStore {
  constructor(private readonly db: DatabaseManager) {}

  upsert(input: {
    scope: MemoryScope;
    scopeId?: string;
    memoryType: MemoryType;
    key?: string;
    value: string;
    summary?: string;
    importance?: number;
    confidence?: number;
    lifecycleState: "candidate" | "active";
    provenance: MemoryProvenance;
    sensitivity?: MemorySensitivity;
    retentionUntil?: string;
  }): MemoryRecord {
    if (input.sensitivity === "secret") {
      throw new Error("secret_memory_persistence_denied");
    }
    const ts = nowIso();
    const existing = this.findExisting(input);
    if (existing && existing.value === input.value) {
      const lifecycleState =
        existing.lifecycleState === "active" ? "active" : input.lifecycleState;
      this.db.connection
        .prepare(
          `UPDATE memories
           SET summary=?, importance=?, confidence=?, lifecycle_state=?,
               provenance_json=?, sensitivity=?, retention_until=?, updated_at=?
           WHERE id=?`,
        )
        .run(
          input.summary ?? null,
          input.importance ?? existing.importance,
          input.confidence ?? existing.confidence,
          lifecycleState,
          JSON.stringify(input.provenance),
          input.sensitivity ?? existing.sensitivity,
          input.retentionUntil ?? existing.retentionUntil ?? null,
          ts,
          existing.id,
        );
      const ftsText = [input.value, input.summary ?? "", input.key ?? ""].join(" ");
      this.db.upsertFts("memories_fts", existing.id, ftsText);
      return this.get(existing.id)!;
    }

    if (existing) {
      this.transition(existing.id, "superseded");
    }

    const id = randomUUID();
    this.db.connection
      .prepare(
        `INSERT INTO memories
         (id, scope, scope_id, memory_type, key, value, summary, importance,
          confidence, lifecycle_state, provenance_json, sensitivity,
          retention_until, supersedes_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.scope,
        input.scopeId ?? null,
        input.memoryType,
        input.key ?? null,
        input.value,
        input.summary ?? null,
        input.importance ?? 0.5,
        input.confidence ?? 1,
        input.lifecycleState,
        JSON.stringify(input.provenance),
        input.sensitivity ?? "workspace",
        input.retentionUntil ?? null,
        existing?.id ?? null,
        ts,
        ts,
      );
    const ftsText = [input.value, input.summary ?? "", input.key ?? ""].join(" ");
    this.db.upsertFts("memories_fts", id, ftsText);
    return this.get(id)!;
  }

  get(id: string): MemoryRecord | null {
    const row = this.db.connection
      .prepare(`SELECT * FROM memories WHERE id=?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapMemory(row) : null;
  }

  listActive(scope: MemoryScope, scopeId?: string, limit = 20): MemoryRecord[] {
    const rows = scopeId
      ? (this.db.connection
          .prepare(
             `SELECT * FROM memories WHERE scope=? AND scope_id=? AND lifecycle_state='active'
                AND (retention_until IS NULL OR retention_until > ?)
              ORDER BY importance DESC, updated_at DESC LIMIT ?`,
          )
          .all(scope, scopeId, nowIso(), limit) as Record<string, unknown>[])
      : (this.db.connection
          .prepare(
             `SELECT * FROM memories WHERE scope=? AND lifecycle_state='active'
                AND (retention_until IS NULL OR retention_until > ?)
              ORDER BY importance DESC, updated_at DESC LIMIT ?`,
          )
          .all(scope, nowIso(), limit) as Record<string, unknown>[]);
    return dedupeMemories(rows.map(mapMemory));
  }

  listByType(
    scope: MemoryScope,
    scopeId: string | undefined,
    memoryType: MemoryType,
    limit = 10,
  ): MemoryRecord[] {
    const rows = scopeId
      ? (this.db.connection
          .prepare(
             `SELECT * FROM memories WHERE scope=? AND scope_id=? AND memory_type=? AND lifecycle_state='active'
                AND (retention_until IS NULL OR retention_until > ?)
              ORDER BY importance DESC, updated_at DESC LIMIT ?`,
          )
          .all(scope, scopeId, memoryType, nowIso(), limit) as Record<string, unknown>[])
      : (this.db.connection
          .prepare(
             `SELECT * FROM memories WHERE scope=? AND memory_type=? AND lifecycle_state='active'
                AND (retention_until IS NULL OR retention_until > ?)
              ORDER BY importance DESC, updated_at DESC LIMIT ?`,
          )
          .all(scope, memoryType, nowIso(), limit) as Record<string, unknown>[]);
    return dedupeMemories(rows.map(mapMemory));
  }

  searchActive(query: string, limit = 10): MemoryRecord[] {
    const safe = `%${query.replace(/[%_]/g, "")}%`;
    const rows = this.db.connection
      .prepare(
        `SELECT * FROM memories WHERE lifecycle_state='active'
         AND (retention_until IS NULL OR retention_until > ?)
         AND (value LIKE ? OR COALESCE(summary, '') LIKE ? OR COALESCE(key, '') LIKE ?)
         ORDER BY importance DESC, updated_at DESC LIMIT ?`,
      )
      .all(nowIso(), safe, safe, safe, limit) as Record<string, unknown>[];
    return dedupeMemories(rows.map(mapMemory));
  }

  transition(id: string, next: MemoryLifecycleState): MemoryRecord {
    const current = this.get(id);
    if (!current) throw new Error("memory_not_found");
    if (!allowedMemoryTransitions[current.lifecycleState].includes(next)) {
      throw new Error(`memory_transition_invalid:${current.lifecycleState}:${next}`);
    }
    this.db.connection.prepare(
      `UPDATE memories SET lifecycle_state=?, updated_at=? WHERE id=?`,
    ).run(next, nowIso(), id);
    if (next !== "active") this.db.deleteFts("memories_fts", id);
    else this.db.upsertFts(
      "memories_fts",
      id,
      [current.value, current.summary ?? "", current.key ?? ""].join(" "),
    );
    return this.get(id)!;
  }

  list(filter: {
    scope?: MemoryScope;
    scopeId?: string;
    lifecycleState?: MemoryLifecycleState;
    limit?: number;
  } = {}): MemoryRecord[] {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (filter.scope) {
      clauses.push("scope=?");
      values.push(filter.scope);
    }
    if (filter.scopeId) {
      clauses.push("scope_id=?");
      values.push(filter.scopeId);
    }
    if (filter.lifecycleState) {
      clauses.push("lifecycle_state=?");
      values.push(filter.lifecycleState);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    values.push(filter.limit ?? 200);
    const rows = this.db.connection
      .prepare(`SELECT * FROM memories ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...values) as Record<string, unknown>[];
    return rows.map(mapMemory);
  }

  replace(
    id: string,
    patch: {
      value?: string;
      summary?: string | null;
      importance?: number;
      confidence?: number;
      sensitivity?: MemorySensitivity;
      retentionUntil?: string | null;
    },
  ): MemoryRecord {
    const current = this.get(id);
    if (!current) throw new Error("memory_not_found");
    const sensitivity = patch.sensitivity ?? current.sensitivity;
    if (sensitivity === "secret") throw new Error("secret_memory_persistence_denied");
    const nextId = randomUUID();
    const ts = nowIso();
    const value = patch.value ?? current.value;
    const summary = patch.summary === undefined ? current.summary : patch.summary ?? undefined;
    const retentionUntil = patch.retentionUntil === undefined
      ? current.retentionUntil
      : patch.retentionUntil ?? undefined;

    this.db.connection.exec("BEGIN IMMEDIATE");
    try {
      if (current.lifecycleState === "candidate" || current.lifecycleState === "active") {
        this.db.connection.prepare(
          `UPDATE memories SET lifecycle_state='superseded', updated_at=? WHERE id=?`,
        ).run(ts, current.id);
        this.db.deleteFts("memories_fts", current.id);
      }
      this.db.connection.prepare(
        `INSERT INTO memories
         (id, scope, scope_id, memory_type, key, value, summary, importance,
          confidence, lifecycle_state, provenance_json, sensitivity,
          retention_until, supersedes_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
      ).run(
        nextId,
        current.scope,
        current.scopeId ?? null,
        current.memoryType,
        current.key ?? null,
        value,
        summary ?? null,
        patch.importance ?? current.importance,
        patch.confidence ?? current.confidence,
        JSON.stringify({
          origin: "user",
          sourceId: current.id,
          evidence: "user_edit",
        } satisfies MemoryProvenance),
        sensitivity,
        retentionUntil ?? null,
        current.id,
        ts,
        ts,
      );
      this.db.upsertFts(
        "memories_fts",
        nextId,
        [value, summary ?? "", current.key ?? ""].join(" "),
      );
      this.db.connection.exec("COMMIT");
    } catch (error) {
      this.db.connection.exec("ROLLBACK");
      throw error;
    }
    return this.get(nextId)!;
  }

  delete(id: string): boolean {
    const result = this.db.connection.prepare(`DELETE FROM memories WHERE id=?`).run(id);
    if (Number(result.changes) > 0) this.db.deleteFts("memories_fts", id);
    return Number(result.changes) > 0;
  }

  touchUsed(id: string): void {
    const ts = nowIso();
    this.db.connection
      .prepare(`UPDATE memories SET last_used_at=?, updated_at=? WHERE id=?`)
      .run(ts, ts, id);
  }

  private findExisting(input: {
    scope: MemoryScope;
    scopeId?: string;
    memoryType: MemoryType;
    key?: string;
    value: string;
  }): MemoryRecord | null {
    const scopeId = input.scopeId ?? null;
    const trimmedKey = input.key?.trim();
    const row = trimmedKey
      ? (this.db.connection
          .prepare(
            `SELECT * FROM memories
             WHERE scope=? AND COALESCE(scope_id, '')=COALESCE(?, '') AND memory_type=?
                AND key=? AND lifecycle_state IN ('active', 'candidate')
             ORDER BY updated_at DESC LIMIT 1`,
          )
          .get(input.scope, scopeId, input.memoryType, trimmedKey) as
          | Record<string, unknown>
          | undefined)
      : (this.db.connection
          .prepare(
            `SELECT * FROM memories
             WHERE scope=? AND COALESCE(scope_id, '')=COALESCE(?, '') AND memory_type=?
                AND key IS NULL AND value=? AND lifecycle_state IN ('active', 'candidate')
             ORDER BY updated_at DESC LIMIT 1`,
          )
          .get(input.scope, scopeId, input.memoryType, input.value) as
          | Record<string, unknown>
          | undefined);
    return row ? mapMemory(row) : null;
  }
}

function dedupeMemories(memories: MemoryRecord[]): MemoryRecord[] {
  const seen = new Set<string>();
  const out: MemoryRecord[] = [];
  for (const memory of memories) {
    const signature = [
      memory.scope,
      memory.scopeId ?? "",
      memory.memoryType,
      memory.key?.trim() || memory.value.trim(),
    ].join("\u0000");
    if (seen.has(signature)) continue;
    seen.add(signature);
    out.push(memory);
  }
  return out;
}

function mapSummary(row: Record<string, unknown>): SummaryRecord {
  const raw = String(row.content);
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    projectId: row.project_id ? String(row.project_id) : undefined,
    summaryType: String(row.summary_type) as SummaryType,
    content: parseSummary(raw),
    contentText: raw,
    structuredJson: row.structured_json ? String(row.structured_json) : raw,
    startMessageId: row.start_message_id ? String(row.start_message_id) : undefined,
    endMessageId: row.end_message_id ? String(row.end_message_id) : undefined,
    tokenCount: Number(row.token_count ?? 0),
    schemaVersion: 1,
    generationState: String(row.generation_state) as SummaryRecord["generationState"],
    degradedReason: row.degraded_reason ? String(row.degraded_reason) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapMemory(row: Record<string, unknown>): MemoryRecord {
  const provenance = JSON.parse(String(row.provenance_json)) as MemoryProvenance;
  return {
    id: String(row.id),
    scope: String(row.scope) as MemoryScope,
    scopeId: row.scope_id ? String(row.scope_id) : undefined,
    memoryType: String(row.memory_type) as MemoryType,
    key: row.key ? String(row.key) : undefined,
    value: String(row.value),
    summary: row.summary ? String(row.summary) : undefined,
    importance: Number(row.importance ?? 0.5),
    confidence: Number(row.confidence ?? 1),
    lifecycleState: String(row.lifecycle_state) as MemoryLifecycleState,
    provenance,
    sensitivity: String(row.sensitivity) as MemorySensitivity,
    retentionUntil: row.retention_until ? String(row.retention_until) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastUsedAt: row.last_used_at ? String(row.last_used_at) : undefined,
    supersedesId: row.supersedes_id ? String(row.supersedes_id) : undefined,
  };
}

const allowedMemoryTransitions: Record<MemoryLifecycleState, MemoryLifecycleState[]> = {
  candidate: ["active", "rejected", "expired"],
  active: ["rejected", "superseded", "expired"],
  rejected: [],
  superseded: [],
  expired: [],
};

export class ProjectStore {
  constructor(private readonly db: DatabaseManager) {}

  create(name: string, rootPath?: string, description?: string): ProjectRecord {
    const id = randomUUID();
    const ts = nowIso();
    this.db.connection
      .prepare(
        `INSERT INTO projects(id, name, root_path, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, name, rootPath ?? null, description ?? null, ts, ts);
    return this.get(id)!;
  }

  get(id: string): ProjectRecord | null {
    const row = this.db.connection
      .prepare(`SELECT * FROM projects WHERE id=?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapProject(row) : null;
  }

  list(limit = 50): ProjectRecord[] {
    const rows = this.db.connection
      .prepare(`SELECT * FROM projects ORDER BY updated_at DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map(mapProject);
  }
}

export class TaskStore {
  constructor(private readonly db: DatabaseManager) {}

  create(input: {
    goal: string;
    sessionId?: string;
    projectId?: string;
    status?: string;
    summary?: string;
  }): TaskRecord {
    const id = crypto.randomUUID();
    const ts = new Date().toISOString();
    const status = input.status ?? "pending";
    this.db.connection
      .prepare(
        `INSERT INTO tasks (id, session_id, project_id, goal, status, summary, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.sessionId ?? null, input.projectId ?? null, input.goal, status, input.summary ?? null, ts, ts);
    return this.get(id)!;
  }

  update(
    id: string,
    patch: {
      status?: string;
      summary?: string;
      goal?: string;
      inputs?: string[];
      outputs?: string[];
      acceptanceCriteria?: string[];
    },
  ): TaskRecord | null {
    const existing = this.get(id);
    if (!existing) return null;
    const ts = new Date().toISOString();
    this.db.connection
      .prepare(
        `UPDATE tasks SET status=?, summary=?, goal=?, inputs_json=?, outputs_json=?,
         acceptance_criteria_json=?, updated_at=? WHERE id=?`,
      )
      .run(
        patch.status ?? existing.status,
        patch.summary ?? existing.summary ?? null,
        patch.goal ?? existing.goal,
        patch.inputs ? JSON.stringify(patch.inputs) : JSON.stringify(existing.inputs ?? []),
        patch.outputs ? JSON.stringify(patch.outputs) : JSON.stringify(existing.outputs ?? []),
        patch.acceptanceCriteria
          ? JSON.stringify(patch.acceptanceCriteria)
          : JSON.stringify(existing.acceptanceCriteria ?? []),
        ts,
        id,
      );
    return this.get(id);
  }

  get(id: string): TaskRecord | null {
    const row = this.db.connection
      .prepare(`SELECT * FROM tasks WHERE id=?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapTask(row) : null;
  }

  listBySession(sessionId: string, limit = 20): TaskRecord[] {
    const rows = this.db.connection
      .prepare(
        `SELECT * FROM tasks WHERE session_id=? ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(sessionId, limit) as Record<string, unknown>[];
    return rows.map(mapTask);
  }

  getActiveForSession(sessionId: string): TaskRecord | null {
    const row = this.db.connection
      .prepare(
        `SELECT * FROM tasks WHERE session_id=? AND status NOT IN ('done', 'completed', 'failed', 'cancelled')
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    return row ? mapTask(row) : null;
  }

  upsertSteps(
    taskId: string,
    steps: Array<{
      stepId: string;
      position: number;
      title: string;
      objective?: string;
      description?: string;
      status: string;
      requiredPermissions: string[];
      needsConfirmation: boolean;
      acceptance?: string;
      dependsOn?: string[];
      requiredContext?: string[];
      availableTools?: string[];
      expectedArtifacts?: string[];
      priority?: number;
      tool?: string;
      toolInput?: Record<string, unknown>;
      result?: string;
      error?: string;
    }>,
  ): TaskStepRecord[] {
    const ts = new Date().toISOString();
    const existingCreated = this.db.connection.prepare(
      `SELECT id, created_at FROM task_steps WHERE task_id=? AND step_id=?`,
    );
    const upsert = this.db.connection.prepare(
      `INSERT INTO task_steps
       (id, task_id, step_id, position, title, objective, description, status,
        required_permissions_json, needs_confirmation, acceptance, required_context_json,
        available_tools_json, expected_artifacts_json, priority, tool, tool_input_json,
        result, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id, step_id) DO UPDATE SET
         position=excluded.position,
         title=excluded.title,
         objective=excluded.objective,
         description=excluded.description,
         status=excluded.status,
         required_permissions_json=excluded.required_permissions_json,
         needs_confirmation=excluded.needs_confirmation,
         acceptance=excluded.acceptance,
         required_context_json=excluded.required_context_json,
         available_tools_json=excluded.available_tools_json,
         expected_artifacts_json=excluded.expected_artifacts_json,
         priority=excluded.priority,
         tool=excluded.tool,
         tool_input_json=excluded.tool_input_json,
         result=excluded.result,
         error=excluded.error,
         updated_at=excluded.updated_at`,
    );
    const clearDeps = this.db.connection.prepare(
      `DELETE FROM task_step_dependencies WHERE task_id=? AND step_id=?`,
    );
    const insertDep = this.db.connection.prepare(
      `INSERT OR IGNORE INTO task_step_dependencies
       (task_id, step_id, depends_on_step_id, created_at) VALUES (?, ?, ?, ?)`,
    );

    for (const step of steps) {
      const existing = existingCreated.get(taskId, step.stepId) as
        | { id: string; created_at: string }
        | undefined;
      upsert.run(
        existing?.id ?? randomUUID(),
        taskId,
        step.stepId,
        step.position,
        step.title,
        step.objective ?? null,
        step.description ?? null,
        step.status,
        JSON.stringify(step.requiredPermissions),
        step.needsConfirmation ? 1 : 0,
        step.acceptance ?? null,
        JSON.stringify(step.requiredContext ?? []),
        JSON.stringify(step.availableTools ?? []),
        JSON.stringify(step.expectedArtifacts ?? []),
        step.priority ?? 100,
        step.tool ?? null,
        step.toolInput ? JSON.stringify(step.toolInput) : null,
        step.result ?? null,
        step.error ?? null,
        existing?.created_at ?? ts,
        ts,
      );
      clearDeps.run(taskId, step.stepId);
      for (const dep of step.dependsOn ?? []) {
        insertDep.run(taskId, step.stepId, dep, ts);
      }
    }
    return this.listSteps(taskId);
  }

  listSteps(taskId: string): TaskStepRecord[] {
    const rows = this.db.connection
      .prepare(`SELECT * FROM task_steps WHERE task_id=? ORDER BY position ASC`)
      .all(taskId) as Record<string, unknown>[];
    const deps = this.db.connection
      .prepare(`SELECT step_id, depends_on_step_id FROM task_step_dependencies WHERE task_id=?`)
      .all(taskId) as Array<{ step_id: string; depends_on_step_id: string }>;
    const byStep = new Map<string, string[]>();
    for (const dep of deps) {
      const list = byStep.get(dep.step_id) ?? [];
      list.push(dep.depends_on_step_id);
      byStep.set(dep.step_id, list);
    }
    return rows.map((row) => mapTaskStep(row, byStep.get(String(row.step_id)) ?? []));
  }

  recordAttempt(input: {
    taskId: string;
    stepId?: string;
    runId?: string;
    status: string;
    error?: string;
    result?: string;
    startedAt?: string;
    endedAt?: string;
  }): TaskAttemptRecord {
    const id = randomUUID();
    const startedAt = input.startedAt ?? new Date().toISOString();
    this.db.connection
      .prepare(
        `INSERT INTO task_attempts
         (id, task_id, step_id, run_id, status, error, result, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.taskId,
        input.stepId ?? null,
        input.runId ?? null,
        input.status,
        input.error ?? null,
        input.result ?? null,
        startedAt,
        input.endedAt ?? null,
      );
    return this.getAttempt(id)!;
  }

  updateLatestAttemptByRun(input: {
    taskId: string;
    runId: string;
    status: string;
    error?: string;
    result?: string;
    endedAt?: string;
  }): boolean {
    const row = this.db.connection.prepare(
      `SELECT id FROM task_attempts
       WHERE task_id=? AND run_id=?
       ORDER BY started_at DESC LIMIT 1`,
    ).get(input.taskId, input.runId) as { id: string } | undefined;
    if (!row) return false;
    this.db.connection.prepare(
      `UPDATE task_attempts
       SET status=?, error=?, result=?, ended_at=?
       WHERE id=?`,
    ).run(
      input.status,
      input.error ?? null,
      input.result ?? null,
      input.endedAt ?? new Date().toISOString(),
      row.id,
    );
    return true;
  }

  getAttempt(id: string): TaskAttemptRecord | null {
    const row = this.db.connection
      .prepare(`SELECT * FROM task_attempts WHERE id=?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapTaskAttempt(row) : null;
  }

  listAttempts(taskId: string): TaskAttemptRecord[] {
    const rows = this.db.connection
      .prepare(`SELECT * FROM task_attempts WHERE task_id=? ORDER BY started_at DESC`)
      .all(taskId) as Record<string, unknown>[];
    return rows.map(mapTaskAttempt);
  }
}

function mapProject(row: Record<string, unknown>): ProjectRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    rootPath: row.root_path ? String(row.root_path) : undefined,
    description: row.description ? String(row.description) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapTask(row: Record<string, unknown>): TaskRecord {
  return {
    id: String(row.id),
    sessionId: row.session_id ? String(row.session_id) : undefined,
    projectId: row.project_id ? String(row.project_id) : undefined,
    goal: String(row.goal),
    status: String(row.status),
    summary: row.summary ? String(row.summary) : undefined,
    inputs: parseJsonArray(row.inputs_json),
    outputs: parseJsonArray(row.outputs_json),
    acceptanceCriteria: parseJsonArray(row.acceptance_criteria_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function parseJsonArray(value: unknown): string[] {
  if (value === undefined || value === null || value === "") return [];
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function mapTaskStep(row: Record<string, unknown>, dependsOn: string[]): TaskStepRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    stepId: String(row.step_id),
    position: Number(row.position ?? 0),
    title: String(row.title),
    objective: row.objective ? String(row.objective) : undefined,
    description: row.description ? String(row.description) : undefined,
    status: String(row.status),
    requiredPermissions: parseJsonArray(row.required_permissions_json),
    needsConfirmation: Number(row.needs_confirmation ?? 0) === 1,
    acceptance: row.acceptance ? String(row.acceptance) : undefined,
    dependsOn,
    requiredContext: parseJsonArray(row.required_context_json),
    availableTools: parseJsonArray(row.available_tools_json),
    expectedArtifacts: parseJsonArray(row.expected_artifacts_json),
    priority: Number(row.priority ?? 100),
    tool: row.tool ? String(row.tool) : undefined,
    toolInput: parseJsonObject(row.tool_input_json),
    result: row.result ? String(row.result) : undefined,
    error: row.error ? String(row.error) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapTaskAttempt(row: Record<string, unknown>): TaskAttemptRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    stepId: row.step_id ? String(row.step_id) : undefined,
    runId: row.run_id ? String(row.run_id) : undefined,
    status: String(row.status),
    error: row.error ? String(row.error) : undefined,
    result: row.result ? String(row.result) : undefined,
    startedAt: String(row.started_at),
    endedAt: row.ended_at ? String(row.ended_at) : undefined,
  };
}
