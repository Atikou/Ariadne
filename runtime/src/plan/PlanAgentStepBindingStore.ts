import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { ToolPermissionSchema } from "../agent/types.js";
import type { UserPermissionPolicy } from "../agent/RunPolicyTypes.js";
import type { ToolPermission } from "../core/permissions.js";

const UserPermissionPolicySchema = z.enum([
  "readOnly",
  "confirmBeforeEdit",
  "autoEdit",
  "confirmBeforeRun",
  "autoRun",
]);

const PlanAgentStepBindingPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  executionMode: z.literal("agent_loop"),
  permissionPolicy: UserPermissionPolicySchema.optional(),
  runGrantedPermissions: z.array(ToolPermissionSchema).optional(),
  rollbackOnFailure: z.boolean(),
  fallbackToPlanOnUncertainty: z.boolean(),
}).strict();

export interface PlanAgentStepBindingPayload {
  schemaVersion: 1;
  executionMode: "agent_loop";
  permissionPolicy?: UserPermissionPolicy;
  runGrantedPermissions?: ToolPermission[];
  rollbackOnFailure: boolean;
  fallbackToPlanOnUncertainty: boolean;
}

export type PlanAgentStepBindingStatus =
  | "waiting_child"
  | "continuing"
  | "completed"
  | "failed"
  | "cancelled";

export interface PlanAgentStepBinding {
  id: string;
  planId: string;
  planVersion: number;
  planRunId: string;
  parentRunId: string;
  parentTaskId: string;
  stepId: string;
  stepRowId: string;
  childRunId: string;
  status: PlanAgentStepBindingStatus;
  payload: PlanAgentStepBindingPayload;
  error?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

/** Durable state center for a persisted plan step delegated to a child Agent Run. */
export class PlanAgentStepBindingStore {
  constructor(private readonly db: DatabaseSync) {}

  createWaiting(input: Omit<
    PlanAgentStepBinding,
    "id" | "status" | "createdAt" | "updatedAt" | "finishedAt" | "error"
  >): PlanAgentStepBinding {
    const payload = PlanAgentStepBindingPayloadSchema.parse(
      input.payload,
    ) as PlanAgentStepBindingPayload;
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO plan_agent_step_bindings(
        id, plan_id, plan_version, plan_run_id, parent_run_id, parent_task_id,
        step_id, step_row_id, child_run_id, status, payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting_child', ?, ?, ?)`,
    ).run(
      id,
      input.planId,
      input.planVersion,
      input.planRunId,
      input.parentRunId,
      input.parentTaskId,
      input.stepId,
      input.stepRowId,
      input.childRunId,
      JSON.stringify(payload),
      now,
      now,
    );
    return this.get(id)!;
  }

  get(id: string): PlanAgentStepBinding | null {
    const row = this.db.prepare(
      "SELECT * FROM plan_agent_step_bindings WHERE id=?",
    ).get(id) as Record<string, unknown> | undefined;
    return row ? mapBinding(row) : null;
  }

  getByChildRunId(childRunId: string): PlanAgentStepBinding | null {
    const row = this.db.prepare(
      "SELECT * FROM plan_agent_step_bindings WHERE child_run_id=?",
    ).get(childRunId) as Record<string, unknown> | undefined;
    return row ? mapBinding(row) : null;
  }

  listRecoverable(): PlanAgentStepBinding[] {
    const rows = this.db.prepare(
      `SELECT * FROM plan_agent_step_bindings
       WHERE status IN ('waiting_child', 'continuing')
       ORDER BY created_at ASC`,
    ).all() as Record<string, unknown>[];
    return rows.map(mapBinding);
  }

  claim(id: string): PlanAgentStepBinding | null {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      `UPDATE plan_agent_step_bindings
       SET status='continuing', error=NULL, updated_at=?
       WHERE id=? AND status='waiting_child'`,
    ).run(now, id);
    return Number(result.changes) === 1 ? this.get(id) : null;
  }

  release(id: string, error: string): PlanAgentStepBinding | null {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE plan_agent_step_bindings
       SET status='waiting_child', error=?, updated_at=?, finished_at=NULL
       WHERE id=? AND status='continuing'`,
    ).run(error.slice(0, 2000), now, id);
    return this.get(id);
  }

  finish(
    id: string,
    status: Extract<PlanAgentStepBindingStatus, "completed" | "failed" | "cancelled">,
    error?: string,
  ): PlanAgentStepBinding | null {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE plan_agent_step_bindings
       SET status=?, error=?, updated_at=?, finished_at=?
       WHERE id=? AND status='continuing'`,
    ).run(status, error?.slice(0, 2000) ?? null, now, now, id);
    return this.get(id);
  }

  resetInterruptedClaims(): number {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      `UPDATE plan_agent_step_bindings
       SET status='waiting_child', error='进程重启前的父计划续接未完成', updated_at=?, finished_at=NULL
       WHERE status='continuing'`,
    ).run(now);
    return Number(result.changes);
  }
}

function mapBinding(row: Record<string, unknown>): PlanAgentStepBinding {
  return {
    id: String(row.id),
    planId: String(row.plan_id),
    planVersion: Number(row.plan_version),
    planRunId: String(row.plan_run_id),
    parentRunId: String(row.parent_run_id),
    parentTaskId: String(row.parent_task_id),
    stepId: String(row.step_id),
    stepRowId: String(row.step_row_id),
    childRunId: String(row.child_run_id),
    status: String(row.status) as PlanAgentStepBindingStatus,
    payload: PlanAgentStepBindingPayloadSchema.parse(
      JSON.parse(String(row.payload_json)),
    ) as PlanAgentStepBindingPayload,
    error: row.error ? String(row.error) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    finishedAt: row.finished_at ? String(row.finished_at) : undefined,
  };
}
