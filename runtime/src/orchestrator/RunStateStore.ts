import type { DatabaseManager } from "../context/DatabaseManager.js";
import type { RunState, RunStateStatus } from "./runStateTypes.js";

export class RunStateStore {
  constructor(private readonly db: DatabaseManager) {}

  save(state: RunState): RunState {
    const ts = new Date().toISOString();
    const existing = this.get(state.runId);
    const createdAt = existing?.updatedAt ?? ts;
    const payload = serializeRunState({ ...state, updatedAt: ts });
    this.db.connection
      .prepare(
        `INSERT INTO run_states
         (run_id, mode, goal, session_id, task_id, status, state_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           mode=excluded.mode,
           goal=excluded.goal,
           session_id=excluded.session_id,
           task_id=excluded.task_id,
           status=excluded.status,
           state_json=excluded.state_json,
           updated_at=excluded.updated_at`,
      )
      .run(
        state.runId,
        state.mode,
        state.goal,
        state.sessionId ?? null,
        state.taskId ?? null,
        state.status,
        payload,
        createdAt,
        ts,
      );
    return this.get(state.runId)!;
  }

  get(runId: string): RunState | null {
    const row = this.db.connection
      .prepare(`SELECT state_json FROM run_states WHERE run_id=?`)
      .get(runId) as { state_json: string } | undefined;
    if (!row) return null;
    return deserializeRunState(row.state_json);
  }

  updateStatus(runId: string, status: RunStateStatus): RunState | null {
    const existing = this.get(runId);
    if (!existing) return null;
    return this.save({ ...existing, status });
  }

  markCompleted(runId: string): RunState | null {
    return this.updateStatus(runId, "completed");
  }

  listResumable(limit = 50): RunState[] {
    const rows = this.db.connection
      .prepare(
        `SELECT state_json FROM run_states WHERE status='resumable' ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(limit) as Array<{ state_json: string }>;
    return rows.map((row) => deserializeRunState(row.state_json));
  }

  delete(runId: string): void {
    this.db.connection.prepare(`DELETE FROM run_states WHERE run_id=?`).run(runId);
  }
}

function serializeRunState(state: RunState): string {
  return JSON.stringify(state);
}

function deserializeRunState(json: string): RunState {
  return JSON.parse(json) as RunState;
}
