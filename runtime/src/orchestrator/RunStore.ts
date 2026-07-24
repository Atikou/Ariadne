import { randomUUID } from "node:crypto";

import type { DatabaseManager } from "../context/DatabaseManager.js";
import type { CorrelationContext } from "../core/correlation.js";
import type { RunKind, RunRecord, RunStatus } from "../core/runTypes.js";

export class RunStore {
  constructor(private readonly db: DatabaseManager) {}

  usesConnection(db: DatabaseManager["connection"]): boolean {
    return this.db.connection === db;
  }

  create(input: {
    kind: RunKind;
    status?: RunStatus;
    sessionId?: string;
    taskId?: string;
    parentRunId?: string;
    triggerId?: string;
    goal?: string;
    correlation?: CorrelationContext;
  }): RunRecord {
    const id = randomUUID();
    const ts = new Date().toISOString();
    const status = input.status ?? "pending";
    this.db.connection
      .prepare(
        `INSERT INTO runs
         (id, kind, status, session_id, task_id, parent_run_id, trigger_id, goal, correlation_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.kind,
        status,
        input.sessionId ?? null,
        input.taskId ?? null,
        input.parentRunId ?? null,
        input.triggerId ?? null,
        input.goal ?? null,
        input.correlation ? JSON.stringify(input.correlation) : null,
        ts,
        ts,
      );
    return this.get(id)!;
  }

  update(
    id: string,
    patch: {
      status?: RunStatus;
      /** undefined 保留原值，null 显式清除。 */
      error?: string | null;
      resultJson?: string;
      taskId?: string;
      correlationJson?: string;
    },
  ): RunRecord | null {
    const existing = this.get(id);
    if (!existing) return null;
    const ts = new Date().toISOString();
    this.db.connection
      .prepare(
        `UPDATE runs SET status=?, error=?, result_json=?, task_id=?, correlation_json=?, updated_at=? WHERE id=?`,
      )
      .run(
        patch.status ?? existing.status,
        patch.error === undefined ? existing.error ?? null : patch.error,
        patch.resultJson ?? existing.resultJson ?? null,
        patch.taskId ?? existing.taskId ?? null,
        patch.correlationJson ?? existing.correlationJson ?? null,
        ts,
        id,
      );
    return this.get(id);
  }

  get(id: string): RunRecord | null {
    const row = this.db.connection
      .prepare(`SELECT * FROM runs WHERE id=?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapRun(row) : null;
  }

  list(opts?: { limit?: number; status?: RunStatus }): RunRecord[] {
    const limit = opts?.limit ?? 50;
    const rows = opts?.status
      ? (this.db.connection
          .prepare(`SELECT * FROM runs WHERE status=? ORDER BY created_at DESC LIMIT ?`)
          .all(opts.status, limit) as Record<string, unknown>[])
      : (this.db.connection
          .prepare(`SELECT * FROM runs ORDER BY created_at DESC LIMIT ?`)
          .all(limit) as Record<string, unknown>[]);
    return rows.map(mapRun);
  }

  delete(id: string): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    const conn = this.db.connection;
    conn.prepare(`DELETE FROM run_states WHERE run_id=?`).run(id);
    conn.prepare(`DELETE FROM runs WHERE id=?`).run(id);
    return true;
  }
}

function mapRun(row: Record<string, unknown>): RunRecord {
  return {
    id: String(row.id),
    kind: String(row.kind) as RunKind,
    status: String(row.status) as RunStatus,
    sessionId: row.session_id ? String(row.session_id) : undefined,
    taskId: row.task_id ? String(row.task_id) : undefined,
    parentRunId: row.parent_run_id ? String(row.parent_run_id) : undefined,
    triggerId: row.trigger_id ? String(row.trigger_id) : undefined,
    goal: row.goal ? String(row.goal) : undefined,
    error: row.error ? String(row.error) : undefined,
    resultJson: row.result_json ? String(row.result_json) : undefined,
    correlationJson: row.correlation_json ? String(row.correlation_json) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
