import { randomUUID } from "node:crypto";

import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import {
  EvalSetScopeSchema,
  EvalSetVerdictSchema,
  type EvalSetRunSummary,
  type EvalSetScope,
} from "./eval-set-types.js";

export const ModelEvalRunRowSchema = z.object({
  id: z.string().uuid(),
  setName: z.string(),
  scope: EvalSetScopeSchema,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
}).strict().superRefine((run, ctx) => {
  if (run.total !== run.passed + run.failed + run.skipped) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "持久化评测计数总和不一致" });
  }
});
export type ModelEvalRunRow = z.infer<typeof ModelEvalRunRowSchema>;

export const ModelEvalResultRowSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  caseId: z.string(),
  caseTitle: z.string(),
  inputPreview: z.string(),
  verdict: EvalSetVerdictSchema,
  expectedTaskType: z.string().optional(),
  actualTaskType: z.string().optional(),
  expectedLevel: z.number().int().optional(),
  actualLevel: z.number().int().optional(),
  expectedStrategy: z.string().optional(),
  actualStrategy: z.string().optional(),
  notes: z.array(z.string()),
  createdAt: z.string().datetime(),
}).strict();
export type ModelEvalResultRow = z.infer<typeof ModelEvalResultRowSchema>;

function preview(text: string, max = 300): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function ensureEvalTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_eval_runs (
      id TEXT PRIMARY KEY,
      set_name TEXT NOT NULL,
      scope TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      total INTEGER NOT NULL,
      passed INTEGER NOT NULL,
      failed INTEGER NOT NULL,
      skipped INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_eval_runs_started ON model_eval_runs(started_at DESC);

    CREATE TABLE IF NOT EXISTS model_eval_results (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      case_id TEXT NOT NULL,
      case_title TEXT NOT NULL,
      input_preview TEXT NOT NULL,
      verdict TEXT NOT NULL,
      expected_task_type TEXT,
      actual_task_type TEXT,
      expected_level INTEGER,
      actual_level INTEGER,
      expected_strategy TEXT,
      actual_strategy TEXT,
      notes_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_eval_results_run ON model_eval_results(run_id, created_at);
  `);
}

export class ModelEvalStore {
  constructor(private readonly db: DatabaseSync) {}

  saveRun(summary: EvalSetRunSummary, setName: string, scope: EvalSetScope): void {
    this.db
      .prepare(
        `INSERT INTO model_eval_runs (
          id, set_name, scope, started_at, finished_at, total, passed, failed, skipped
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        summary.runId,
        setName,
        scope,
        summary.startedAt,
        summary.finishedAt,
        summary.total,
        summary.passed,
        summary.failed,
        summary.skipped,
      );

    const insert = this.db.prepare(
      `INSERT INTO model_eval_results (
        id, run_id, case_id, case_title, input_preview, verdict,
        expected_task_type, actual_task_type, expected_level, actual_level,
        expected_strategy, actual_strategy, notes_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const createdAt = summary.finishedAt;
    for (const result of summary.results) {
      insert.run(
        randomUUID(),
        summary.runId,
        result.caseId,
        result.caseTitle ?? result.caseId,
        preview(result.inputPreview ?? ""),
        result.verdict,
        result.expectedTaskType ?? null,
        result.actualTaskType ?? null,
        result.expectedLevel ?? null,
        result.actualLevel ?? null,
        result.expectedStrategy ?? null,
        result.actualStrategy ?? null,
        JSON.stringify(result.notes ?? []),
        createdAt,
      );
    }
  }

  getRun(runId: string): { run: ModelEvalRunRow; results: ModelEvalResultRow[] } | null {
    const row = this.db.prepare(`SELECT * FROM model_eval_runs WHERE id = ?`).get(runId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    const results = this.db
      .prepare(`SELECT * FROM model_eval_results WHERE run_id = ? ORDER BY created_at`)
      .all(runId) as Array<Record<string, unknown>>;
    return {
      run: mapRunRow(row),
      results: results.map(mapResultRow),
    };
  }

  listRuns(limit = 20): ModelEvalRunRow[] {
    const capped = Math.min(Math.max(limit, 1), 100);
    const rows = this.db
      .prepare(`SELECT * FROM model_eval_runs ORDER BY started_at DESC LIMIT ?`)
      .all(capped) as Array<Record<string, unknown>>;
    return rows.map(mapRunRow);
  }
}

function mapRunRow(r: Record<string, unknown>): ModelEvalRunRow {
  return ModelEvalRunRowSchema.parse({
    id: String(r.id),
    setName: String(r.set_name),
    scope: String(r.scope) as EvalSetScope,
    startedAt: String(r.started_at),
    finishedAt: String(r.finished_at),
    total: Number(r.total),
    passed: Number(r.passed),
    failed: Number(r.failed),
    skipped: Number(r.skipped),
  });
}

function mapResultRow(r: Record<string, unknown>): ModelEvalResultRow {
  let notes: string[] = [];
  try {
    notes = JSON.parse(String(r.notes_json ?? "[]")) as string[];
  } catch {
    notes = [];
  }
  return ModelEvalResultRowSchema.parse({
    id: String(r.id),
    runId: String(r.run_id),
    caseId: String(r.case_id),
    caseTitle: String(r.case_title),
    inputPreview: String(r.input_preview),
    verdict: String(r.verdict),
    expectedTaskType: r.expected_task_type ? String(r.expected_task_type) : undefined,
    actualTaskType: r.actual_task_type ? String(r.actual_task_type) : undefined,
    expectedLevel: r.expected_level != null ? Number(r.expected_level) : undefined,
    actualLevel: r.actual_level != null ? Number(r.actual_level) : undefined,
    expectedStrategy: r.expected_strategy ? String(r.expected_strategy) : undefined,
    actualStrategy: r.actual_strategy ? String(r.actual_strategy) : undefined,
    notes,
    createdAt: String(r.created_at),
  });
}
