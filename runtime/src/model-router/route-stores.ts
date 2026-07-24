import { randomUUID } from "node:crypto";

import type { DatabaseSync } from "node:sqlite";

import type { ExecutionStrategy, FallbackTrigger, RouterDecision } from "./types.js";

function preview(text: string, max = 500): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export interface RouteLogRow {
  id: string;
  sessionId?: string;
  projectId?: string;
  userInputPreview: string;
  taskType: string;
  selectedLevel: number;
  executionStrategy: string;
  selectedModelId?: string;
  draftModelId?: string;
  reviewModelId?: string;
  finalModelId?: string;
  risk: string;
  reason: string;
  source: string;
  candidates: string[];
  requireUserConfirmation: boolean;
  fallbackNote?: string;
  createdAt: string;
}

export class RouteLogStore {
  constructor(private readonly db: DatabaseSync) {}

  save(decision: RouterDecision, userInputPreview: string): void {
    this.db
      .prepare(
        `INSERT INTO model_route_logs (
          id, session_id, project_id, user_input_preview, task_type, selected_level,
          execution_strategy, selected_model_id, draft_model_id, review_model_id, final_model_id,
          risk, reason, source, candidates_json, require_user_confirmation, fallback_note, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decision.id,
        decision.sessionId ?? null,
        decision.projectId ?? null,
        preview(userInputPreview),
        decision.taskType,
        decision.selectedLevel,
        decision.executionStrategy,
        decision.selectedModelId ?? null,
        decision.draftModelId ?? null,
        decision.reviewModelId ?? null,
        decision.finalModelId ?? null,
        decision.risk,
        decision.reason,
        decision.source,
        JSON.stringify(decision.candidates),
        decision.requireUserConfirmation ? 1 : 0,
        decision.fallbackNote ?? null,
        decision.createdAt,
      );
  }

  get(id: string): RouteLogRow | null {
    const row = this.db.prepare(`SELECT * FROM model_route_logs WHERE id=?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapRouteRow(row) : null;
  }

  listRecent(limit = 20, sessionId?: string): RouteLogRow[] {
    const capped = Math.min(Math.max(limit, 1), 100);
    const rows = sessionId
      ? (this.db
          .prepare(
            `SELECT * FROM model_route_logs WHERE session_id=? ORDER BY created_at DESC LIMIT ?`,
          )
          .all(sessionId, capped) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(`SELECT * FROM model_route_logs ORDER BY created_at DESC LIMIT ?`)
          .all(capped) as Array<Record<string, unknown>>);
    return rows.map(mapRouteRow);
  }
}

function mapRouteRow(r: Record<string, unknown>): RouteLogRow {
  let candidates: string[] = [];
  try {
    candidates = JSON.parse(String(r.candidates_json ?? "[]")) as string[];
  } catch {
    candidates = [];
  }
  return {
    id: String(r.id),
    sessionId: r.session_id ? String(r.session_id) : undefined,
    projectId: r.project_id ? String(r.project_id) : undefined,
    userInputPreview: String(r.user_input_preview),
    taskType: String(r.task_type),
    selectedLevel: Number(r.selected_level),
    executionStrategy: String(r.execution_strategy),
    selectedModelId: r.selected_model_id ? String(r.selected_model_id) : undefined,
    draftModelId: r.draft_model_id ? String(r.draft_model_id) : undefined,
    reviewModelId: r.review_model_id ? String(r.review_model_id) : undefined,
    finalModelId: r.final_model_id ? String(r.final_model_id) : undefined,
    risk: String(r.risk),
    reason: String(r.reason),
    source: String(r.source),
    candidates,
    requireUserConfirmation: Number(r.require_user_confirmation) === 1,
    fallbackNote: r.fallback_note ? String(r.fallback_note) : undefined,
    createdAt: String(r.created_at),
  };
}

export interface ModelCallLogRow {
  id: string;
  routeLogId?: string;
  collaborationRunId?: string;
  sessionId?: string;
  modelId: string;
  role: string;
  inputPreview?: string;
  outputPreview?: string;
  status: "ok" | "error";
  errorMessage?: string;
  promptTokens?: number;
  completionTokens?: number;
  durationMs?: number;
  createdAt: string;
}

export class ModelCallLogStore {
  constructor(private readonly db: DatabaseSync) {}

  create(row: Omit<ModelCallLogRow, "id" | "createdAt">): string {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO model_call_logs (
          id, route_log_id, collaboration_run_id, session_id, model_id, role,
          input_preview, output_preview, status, error_message,
          prompt_tokens, completion_tokens, duration_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        row.routeLogId ?? null,
        row.collaborationRunId ?? null,
        row.sessionId ?? null,
        row.modelId,
        row.role,
        row.inputPreview ?? null,
        row.outputPreview ?? null,
        row.status,
        row.errorMessage ?? null,
        row.promptTokens ?? null,
        row.completionTokens ?? null,
        row.durationMs ?? null,
        createdAt,
      );
    return id;
  }

  listByRoute(routeLogId: string): ModelCallLogRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM model_call_logs WHERE route_log_id = ? ORDER BY created_at`)
      .all(routeLogId) as Array<Record<string, unknown>>;
    return rows.map(mapCallRow);
  }
}

export interface CollaborationRunRow {
  id: string;
  sessionId?: string;
  projectId?: string;
  routeLogId?: string;
  strategy: string;
  draftModelId?: string;
  reviewModelId?: string;
  finalModelId?: string;
  verdict?: string;
  confidence?: number;
  issuesJson?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export class CollaborationRunStore {
  constructor(private readonly db: DatabaseSync) {}

  create(input: {
    sessionId?: string;
    projectId?: string;
    routeLogId?: string;
    strategy: string;
    draftModelId?: string;
    reviewModelId?: string;
    finalModelId?: string;
  }): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO model_collaboration_runs (
          id, session_id, project_id, route_log_id, strategy,
          draft_model_id, review_model_id, final_model_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId ?? null,
        input.projectId ?? null,
        input.routeLogId ?? null,
        input.strategy,
        input.draftModelId ?? null,
        input.reviewModelId ?? null,
        input.finalModelId ?? null,
        "running",
        now,
        now,
      );
    return id;
  }

  finish(
    id: string,
    patch: {
      verdict?: string;
      confidence?: number;
      issuesJson?: string;
      status: string;
    },
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE model_collaboration_runs SET
          verdict = COALESCE(?, verdict),
          confidence = COALESCE(?, confidence),
          issues_json = COALESCE(?, issues_json),
          status = ?,
          updated_at = ?
        WHERE id = ?`,
      )
      .run(
        patch.verdict ?? null,
        patch.confidence ?? null,
        patch.issuesJson ?? null,
        patch.status,
        now,
        id,
      );
  }

  listByRoute(routeLogId: string): CollaborationRunRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM model_collaboration_runs WHERE route_log_id=? ORDER BY created_at`)
      .all(routeLogId) as Array<Record<string, unknown>>;
    return rows.map(mapCollabRow);
  }
}

function mapCollabRow(r: Record<string, unknown>): CollaborationRunRow {
  return {
    id: String(r.id),
    sessionId: r.session_id ? String(r.session_id) : undefined,
    projectId: r.project_id ? String(r.project_id) : undefined,
    routeLogId: r.route_log_id ? String(r.route_log_id) : undefined,
    strategy: String(r.strategy),
    draftModelId: r.draft_model_id ? String(r.draft_model_id) : undefined,
    reviewModelId: r.review_model_id ? String(r.review_model_id) : undefined,
    finalModelId: r.final_model_id ? String(r.final_model_id) : undefined,
    verdict: r.verdict ? String(r.verdict) : undefined,
    confidence: r.confidence != null ? Number(r.confidence) : undefined,
    issuesJson: r.issues_json ? String(r.issues_json) : undefined,
    status: String(r.status),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapCallRow(r: Record<string, unknown>): ModelCallLogRow {
  return {
    id: String(r.id),
    routeLogId: r.route_log_id ? String(r.route_log_id) : undefined,
    collaborationRunId: r.collaboration_run_id ? String(r.collaboration_run_id) : undefined,
    sessionId: r.session_id ? String(r.session_id) : undefined,
    modelId: String(r.model_id),
    role: String(r.role),
    inputPreview: r.input_preview ? String(r.input_preview) : undefined,
    outputPreview: r.output_preview ? String(r.output_preview) : undefined,
    status: r.status === "error" ? "error" : "ok",
    errorMessage: r.error_message ? String(r.error_message) : undefined,
    promptTokens: r.prompt_tokens != null ? Number(r.prompt_tokens) : undefined,
    completionTokens: r.completion_tokens != null ? Number(r.completion_tokens) : undefined,
    durationMs: r.duration_ms != null ? Number(r.duration_ms) : undefined,
    createdAt: String(r.created_at),
  };
}

export interface FallbackLogRow {
  id: string;
  routeLogId: string;
  sessionId?: string;
  fromModelId: string;
  toModelId: string;
  fromStrategy: ExecutionStrategy;
  toStrategy: ExecutionStrategy;
  triggerType: FallbackTrigger;
  reason: string;
  createdAt: string;
}

export class FallbackLogStore {
  constructor(private readonly db: DatabaseSync) {}

  create(row: Omit<FallbackLogRow, "id" | "createdAt">): string {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO fallback_logs (
          id, route_log_id, session_id, from_model_id, to_model_id,
          from_strategy, to_strategy, trigger_type, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        row.routeLogId,
        row.sessionId ?? null,
        row.fromModelId,
        row.toModelId,
        row.fromStrategy,
        row.toStrategy,
        row.triggerType,
        row.reason,
        createdAt,
      );
    return id;
  }

  listByRoute(routeLogId: string): FallbackLogRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM fallback_logs WHERE route_log_id = ? ORDER BY created_at`)
      .all(routeLogId) as Array<Record<string, unknown>>;
    return rows.map(mapFallbackRow);
  }

  listBySession(sessionId: string, limit = 30): FallbackLogRow[] {
    const capped = Math.min(Math.max(limit, 1), 100);
    const rows = this.db
      .prepare(`SELECT * FROM fallback_logs WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(sessionId, capped) as Array<Record<string, unknown>>;
    return rows.map(mapFallbackRow).reverse();
  }
}

function mapFallbackRow(r: Record<string, unknown>): FallbackLogRow {
  return {
    id: String(r.id),
    routeLogId: String(r.route_log_id),
    sessionId: r.session_id ? String(r.session_id) : undefined,
    fromModelId: String(r.from_model_id),
    toModelId: String(r.to_model_id),
    fromStrategy: String(r.from_strategy) as ExecutionStrategy,
    toStrategy: String(r.to_strategy) as ExecutionStrategy,
    triggerType: String(r.trigger_type) as FallbackTrigger,
    reason: String(r.reason),
    createdAt: String(r.created_at),
  };
}

export function ensureRoutingTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_route_logs (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      project_id TEXT,
      user_input_preview TEXT NOT NULL,
      task_type TEXT NOT NULL,
      selected_level INTEGER NOT NULL,
      execution_strategy TEXT NOT NULL,
      selected_model_id TEXT,
      draft_model_id TEXT,
      review_model_id TEXT,
      final_model_id TEXT,
      risk TEXT NOT NULL,
      reason TEXT NOT NULL,
      source TEXT NOT NULL,
      candidates_json TEXT NOT NULL,
      require_user_confirmation INTEGER NOT NULL DEFAULT 0,
      fallback_note TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_route_logs_session ON model_route_logs(session_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS model_call_logs (
      id TEXT PRIMARY KEY,
      route_log_id TEXT,
      collaboration_run_id TEXT,
      session_id TEXT,
      model_id TEXT NOT NULL,
      role TEXT NOT NULL,
      input_preview TEXT,
      output_preview TEXT,
      status TEXT NOT NULL,
      error_message TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      duration_ms INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_call_logs_route ON model_call_logs(route_log_id, created_at);

    CREATE TABLE IF NOT EXISTS fallback_logs (
      id TEXT PRIMARY KEY,
      route_log_id TEXT NOT NULL,
      session_id TEXT,
      from_model_id TEXT NOT NULL,
      to_model_id TEXT NOT NULL,
      from_strategy TEXT NOT NULL,
      to_strategy TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fallback_logs_route ON fallback_logs(route_log_id, created_at);

    CREATE TABLE IF NOT EXISTS model_collaboration_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      project_id TEXT,
      route_log_id TEXT,
      strategy TEXT NOT NULL,
      draft_model_id TEXT,
      review_model_id TEXT,
      final_model_id TEXT,
      verdict TEXT,
      confidence REAL,
      issues_json TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}
