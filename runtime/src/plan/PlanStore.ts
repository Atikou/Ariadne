import { randomUUID } from "node:crypto";

import type { DatabaseManager } from "../context/DatabaseManager.js";
import { attachPlanHash } from "./planHash.js";
import { buildRenderedPreviews } from "./PlanRenderer.js";
import { canTransition } from "./PlanValidator.js";
import {
  PlanValidationError,
  UserVisiblePlanSchema,
  type InternalTaskPlan,
  type PlanStatus,
  type RenderedPlanPreview,
  type UserVisiblePlan,
} from "./types.js";

export interface PlanRecord {
  planId: string;
  version: number;
  status: PlanStatus;
  goal: string;
  mode: string;
  planHash: string;
  internal: InternalTaskPlan;
  createdAt: string;
  updatedAt: string;
}

export interface PlanApprovalRecord {
  id: string;
  planId: string;
  version: number;
  approvedBy: string;
  approvalStatus: "approved" | "rejected";
  comment?: string;
  createdAt: string;
}

/** InternalTaskPlan 持久化：唯一执行源。 */
export class PlanStore {
  constructor(private readonly db: DatabaseManager) {}

  save(plan: InternalTaskPlan, changeReason?: string): PlanRecord {
    const withHash = attachPlanHash(plan);
    const now = new Date().toISOString();
    const json = JSON.stringify(withHash);

    const existing = this.db.connection
      .prepare(`SELECT version FROM task_plans WHERE id=?`)
      .get(withHash.planId) as { version: number } | undefined;

    if (!existing) {
      this.db.connection
        .prepare(
          `INSERT INTO task_plans(id, version, status, kind, goal, mode, internal_json, plan_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          withHash.planId,
          withHash.version,
          withHash.status,
          withHash.kind,
          withHash.goal,
          withHash.mode,
          json,
          withHash.audit.planHash,
          now,
          now,
        );
    } else {
      this.db.connection
        .prepare(
          `UPDATE task_plans SET version=?, status=?, goal=?, mode=?, internal_json=?, plan_hash=?, updated_at=? WHERE id=?`,
        )
        .run(
          withHash.version,
          withHash.status,
          withHash.goal,
          withHash.mode,
          json,
          withHash.audit.planHash,
          now,
          withHash.planId,
        );
    }

    const versionExists = this.db.connection
      .prepare(`SELECT id FROM task_plan_versions WHERE plan_id=? AND version=?`)
      .get(withHash.planId, withHash.version);
    if (!versionExists) {
      this.db.connection
        .prepare(
          `INSERT INTO task_plan_versions(id, plan_id, version, internal_json, plan_hash, change_reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          withHash.planId,
          withHash.version,
          json,
          withHash.audit.planHash,
          changeReason ?? null,
          now,
        );
    } else {
      this.db.connection
        .prepare(
          `UPDATE task_plan_versions SET internal_json=?, plan_hash=?, change_reason=? WHERE plan_id=? AND version=?`,
        )
        .run(json, withHash.audit.planHash, changeReason ?? null, withHash.planId, withHash.version);
    }

    const previews = buildRenderedPreviews(withHash);
    this.savePreview(previews.markdown);
    this.savePreview(previews.json);

    return this.mapRow(withHash.planId, withHash.version, withHash, now, now);
  }

  listVersions(planId: string): Array<{
    version: number;
    status: PlanStatus;
    planHash: string;
    changeReason: string | null;
    createdAt: string;
  }> {
    const rows = this.db.connection
      .prepare(
        `SELECT version, plan_hash, change_reason, created_at, internal_json
         FROM task_plan_versions
         WHERE plan_id=?
         ORDER BY version ASC`,
      )
      .all(planId) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const internal = JSON.parse(String(row.internal_json)) as InternalTaskPlan;
      return {
        version: Number(row.version),
        status: internal.status,
        planHash: String(row.plan_hash),
        changeReason: row.change_reason ? String(row.change_reason) : null,
        createdAt: String(row.created_at),
      };
    });
  }

  getLatestVersion(planId: string): number | null {
    const row = this.db.connection
      .prepare(`SELECT MAX(version) AS max_version FROM task_plan_versions WHERE plan_id=?`)
      .get(planId) as { max_version: number | null } | undefined;
    if (row?.max_version == null) return null;
    return Number(row.max_version);
  }

  get(planId: string, version?: number): PlanRecord | null {
    if (version !== undefined) {
      const row = this.db.connection
        .prepare(`SELECT * FROM task_plan_versions WHERE plan_id=? AND version=?`)
        .get(planId, version) as Record<string, unknown> | undefined;
      if (!row) return null;
      return this.fromVersionRow(row);
    }
    const row = this.db.connection
      .prepare(`SELECT * FROM task_plans WHERE id=?`)
      .get(planId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.fromPlanRow(row);
  }

  updateStatus(planId: string, version: number, status: PlanStatus): PlanRecord | null {
    const current = this.get(planId, version);
    if (!current) return null;
    if (!canTransition(current.status, status)) {
      throw new Error(`不允许状态流转：${current.status} → ${status}`);
    }
    const updated: InternalTaskPlan = {
      ...current.internal,
      status,
      audit: {
        ...current.internal.audit,
        updatedAt: new Date().toISOString(),
      },
    };
    return this.save(updated, `status:${status}`);
  }

  savePreview(preview: RenderedPlanPreview): void {
    const id = `${preview.planId}:${preview.version}:${preview.format}`;
    this.db.connection
      .prepare(
        `INSERT INTO task_plan_previews(id, plan_id, version, format, content, source_plan_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET content=excluded.content, source_plan_hash=excluded.source_plan_hash, created_at=excluded.created_at`,
      )
      .run(
        id,
        preview.planId,
        preview.version,
        preview.format,
        preview.content,
        preview.sourcePlanHash,
        preview.generatedAt,
      );
  }

  getPreview(planId: string, version: number, format: "markdown" | "json"): RenderedPlanPreview | null {
    const row = this.db.connection
      .prepare(
        `SELECT * FROM task_plan_previews WHERE plan_id=? AND version=? AND format=? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(planId, version, format) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      planId: String(row.plan_id),
      version: Number(row.version),
      format: String(row.format) as "markdown" | "json",
      content: String(row.content),
      generatedAt: String(row.created_at),
      sourcePlanHash: String(row.source_plan_hash),
    };
  }

  commitRevision(input: {
    planId: string;
    baseVersion: number;
    revision: InternalTaskPlan;
  }): { superseded: PlanRecord; revision: PlanRecord } {
    if (
      input.revision.planId !== input.planId
      || input.revision.version !== input.baseVersion + 1
      || input.revision.status !== "awaiting_approval"
    ) {
      throw new PlanValidationError("INVALID_SCHEMA", "修订版本身份或状态无效");
    }

    return this.inTransaction(() => {
      const base = this.get(input.planId, input.baseVersion);
      if (!base) {
        throw new PlanValidationError("PLAN_NOT_FOUND", "计划不存在");
      }
      if (!canTransition(base.status, "superseded")) {
        throw new PlanValidationError(
          "PLAN_STATUS_CONFLICT",
          `计划状态 ${base.status} 不允许创建修订版`,
        );
      }
      if (this.get(input.planId, input.revision.version)) {
        throw new PlanValidationError(
          "PLAN_STATUS_CONFLICT",
          `版本 ${input.revision.version} 已存在`,
        );
      }

      const supersededPlan: InternalTaskPlan = {
        ...base.internal,
        status: "superseded",
        audit: {
          ...base.internal.audit,
          updatedAt: new Date().toISOString(),
        },
      };
      const superseded = this.save(supersededPlan, "status:superseded");
      const revision = this.save(input.revision, `revision:${input.baseVersion}`);
      return { superseded, revision };
    });
  }

  applyApprovalDecision(input: {
    planId: string;
    version: number;
    approvedBy: string;
    approvalStatus: "approved" | "rejected";
    comment?: string;
  }): InternalTaskPlan {
    return this.inTransaction(() => {
      const current = this.get(input.planId, input.version);
      if (!current) {
        throw new PlanValidationError("PLAN_NOT_FOUND", "计划不存在");
      }
      if (!canTransition(current.status, input.approvalStatus)) {
        throw new PlanValidationError(
          "PLAN_STATUS_CONFLICT",
          `计划状态 ${current.status} 不允许变更为 ${input.approvalStatus}`,
        );
      }

      this.recordApproval(input);
      const updated = this.updateStatus(input.planId, input.version, input.approvalStatus);
      if (!updated) {
        throw new PlanValidationError("PLAN_NOT_FOUND", "计划不存在");
      }
      return updated.internal;
    });
  }

  private recordApproval(input: {
    planId: string;
    version: number;
    approvedBy: string;
    approvalStatus: "approved" | "rejected";
    comment?: string;
  }): PlanApprovalRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.connection
      .prepare(
        `INSERT INTO task_plan_approvals(id, plan_id, version, approved_by, approval_status, comment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.planId,
        input.version,
        input.approvedBy,
        input.approvalStatus,
        input.comment ?? null,
        now,
      );
    return {
      id,
      planId: input.planId,
      version: input.version,
      approvedBy: input.approvedBy,
      approvalStatus: input.approvalStatus,
      comment: input.comment,
      createdAt: now,
    };
  }

  private inTransaction<T>(operation: () => T): T {
    this.db.connection.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.connection.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.connection.exec("ROLLBACK");
      } catch {
        // Preserve the decision error.
      }
      throw error;
    }
  }

  createPlanRun(input: {
    planId: string;
    version: number;
    status?: string;
  }): { id: string; planId: string; version: number; status: string; createdAt: string } {
    const id = randomUUID();
    const now = new Date().toISOString();
    const status = input.status ?? "pending";
    this.db.connection
      .prepare(
        `INSERT INTO task_plan_runs(id, plan_id, version, status, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, input.planId, input.version, status, now);
    return { id, planId: input.planId, version: input.version, status, createdAt: now };
  }

  updatePlanRun(
    runId: string,
    patch: {
      status?: string;
      startedAt?: string;
      finishedAt?: string | null;
      stopReason?: string | null;
    },
  ): boolean {
    const row = this.db.connection
      .prepare(`SELECT * FROM task_plan_runs WHERE id=?`)
      .get(runId) as Record<string, unknown> | undefined;
    if (!row) return false;
    this.db.connection
      .prepare(
        `UPDATE task_plan_runs SET status=?, started_at=?, finished_at=?, stop_reason=? WHERE id=?`,
      )
      .run(
        patch.status ?? String(row.status),
        patch.startedAt ?? (row.started_at ? String(row.started_at) : null),
        patch.finishedAt === undefined
          ? (row.finished_at ? String(row.finished_at) : null)
          : patch.finishedAt,
        patch.stopReason === undefined
          ? (row.stop_reason ? String(row.stop_reason) : null)
          : patch.stopReason,
        runId,
      );
    return true;
  }

  saveUserVisiblePlan(plan: UserVisiblePlan): UserVisiblePlan {
    const parsed = UserVisiblePlanSchema.parse(plan);
    this.db.connection
      .prepare(
        `INSERT INTO user_visible_plans(
          id, source_run_id, session_id, title, markdown, todos_json, risks_json,
          requires_user_confirmation, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title=excluded.title,
          markdown=excluded.markdown,
          todos_json=excluded.todos_json,
          risks_json=excluded.risks_json,
          requires_user_confirmation=excluded.requires_user_confirmation`,
      )
      .run(
        parsed.id,
        parsed.sourceRunId,
        parsed.sessionId ?? null,
        parsed.title,
        parsed.markdown,
        JSON.stringify(parsed.todos),
        JSON.stringify(parsed.risks),
        parsed.requiresUserConfirmation ? 1 : 0,
        parsed.createdAt,
      );
    return parsed;
  }

  getUserVisiblePlan(id: string): UserVisiblePlan | null {
    const row = this.db.connection
      .prepare(`SELECT * FROM user_visible_plans WHERE id=?`)
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return UserVisiblePlanSchema.parse({
      kind: "user_visible_plan",
      id: String(row.id),
      sourceRunId: String(row.source_run_id),
      sessionId: row.session_id ? String(row.session_id) : undefined,
      title: String(row.title),
      markdown: String(row.markdown),
      todos: JSON.parse(String(row.todos_json)),
      risks: JSON.parse(String(row.risks_json)),
      requiresUserConfirmation: Number(row.requires_user_confirmation) === 1,
      createdAt: String(row.created_at),
    });
  }

  getLatestUserVisiblePlanForSession(sessionId: string): UserVisiblePlan | null {
    const row = this.db.connection
      .prepare(
        `SELECT * FROM user_visible_plans WHERE session_id=? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.getUserVisiblePlan(String(row.id));
  }

  createPlanRunStep(input: {
    planRunId: string;
    stepId: string;
    status: string;
    toolName?: string;
  }): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.connection
      .prepare(
        `INSERT INTO task_plan_run_steps(
          id, plan_run_id, step_id, status, tool_name, started_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.planRunId, input.stepId, input.status, input.toolName ?? null, now, now);
    return id;
  }

  finishPlanRunStep(
    stepRowId: string,
    patch: { status: string; error?: string; outputPreview?: string },
  ): void {
    const now = new Date().toISOString();
    this.db.connection
      .prepare(
        `UPDATE task_plan_run_steps
         SET status=?, finished_at=?, error=?, output_preview=?
         WHERE id=?`,
      )
      .run(
        patch.status,
        now,
        patch.error ?? null,
        patch.outputPreview?.slice(0, 2000) ?? null,
        stepRowId,
      );
  }

  markPlanRunStepWaiting(stepRowId: string, error: string): void {
    this.db.connection
      .prepare(
        `UPDATE task_plan_run_steps
         SET status='waiting_agent', finished_at=NULL, error=?, output_preview=NULL
         WHERE id=?`,
      )
      .run(error.slice(0, 2000), stepRowId);
  }

  private fromPlanRow(row: Record<string, unknown>): PlanRecord {
    const internal = JSON.parse(String(row.internal_json)) as InternalTaskPlan;
    return this.mapRow(
      String(row.id),
      Number(row.version),
      internal,
      String(row.created_at),
      String(row.updated_at),
    );
  }

  private fromVersionRow(row: Record<string, unknown>): PlanRecord {
    const internal = JSON.parse(String(row.internal_json)) as InternalTaskPlan;
    const head = this.db.connection
      .prepare(`SELECT created_at, updated_at FROM task_plans WHERE id=?`)
      .get(String(row.plan_id)) as { created_at: string; updated_at: string } | undefined;
    return this.mapRow(
      String(row.plan_id),
      Number(row.version),
      internal,
      head?.created_at ?? String(row.created_at),
      head?.updated_at ?? String(row.created_at),
    );
  }

  private mapRow(
    planId: string,
    version: number,
    internal: InternalTaskPlan,
    createdAt: string,
    updatedAt: string,
  ): PlanRecord {
    return {
      planId,
      version,
      status: internal.status,
      goal: internal.goal,
      mode: internal.mode,
      planHash: internal.audit.planHash,
      internal,
      createdAt,
      updatedAt,
    };
  }
}
