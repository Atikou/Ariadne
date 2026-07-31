import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { ZodError } from "zod";
import {
  renderAgentPlanMarkdown,
  type AgentPlanContract,
} from "../plan/AgentPlanContract.js";

import {
  PLAN_HANDOFF_SCHEMA_VERSION,
  PlanHandoffCreateInputSchema,
  PlanHandoffListFilterSchema,
  PlanHandoffPayloadSchema,
  PlanHandoffRespondInputSchema,
  type PlanHandoffCreateInput,
  type PlanHandoffListFilter,
  type PlanHandoffPayload,
  type PlanHandoffRespondInput,
} from "./planHandoffTypes.js";

export class PlanHandoffValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanHandoffValidationError";
  }
}

export class PlanHandoffPersistenceError extends Error {
  readonly code = "PLAN_HANDOFF_PERSISTENCE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "PlanHandoffPersistenceError";
  }
}

export type CreatePlanHandoffInput = PlanHandoffCreateInput;

interface PlanHandoffRow {
  id: string;
  plan_id: string;
  run_id: string;
  session_id: string | null;
  status: string;
  payload_json: string;
  created_at: string;
  responded_at: string | null;
}

const PLAN_HANDOFF_SELECT = `
  SELECT id, plan_id, run_id, session_id, status, payload_json, created_at, responded_at
  FROM plan_handoffs`;

export class PlanHandoffStore {
  private readonly handoffs = new Map<string, PlanHandoffPayload>();

  constructor(private readonly db?: DatabaseSync) {}

  create(input: CreatePlanHandoffInput): PlanHandoffPayload {
    const normalized = parseCreateInput(input);
    const existing = this.getPendingByRunId(normalized.runId);
    if (existing) return existing;

    const payload = this.buildPayload(normalized);
    if (this.db) {
      this.db
        .prepare(
          `INSERT INTO plan_handoffs
           (id, plan_id, run_id, session_id, status, payload_json, created_at, updated_at, responded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          payload.id,
          payload.planId,
          payload.runId,
          payload.sessionId ?? null,
          payload.status,
          JSON.stringify(payload),
          payload.createdAt,
          payload.createdAt,
          null,
        );
      return clonePayload(payload);
    }

    this.handoffs.set(payload.id, clonePayload(payload));
    return clonePayload(payload);
  }

  get(id: string): PlanHandoffPayload | null {
    if (this.db) {
      const row = this.db
        .prepare(`${PLAN_HANDOFF_SELECT} WHERE id=?`)
        .get(id) as PlanHandoffRow | undefined;
      return this.parsePayload(row);
    }
    return this.readMemoryPayload(id);
  }

  getPendingByRunId(runId: string): PlanHandoffPayload | null {
    if (this.db) {
      const row = this.db
        .prepare(
          `${PLAN_HANDOFF_SELECT}
           WHERE run_id=? AND status='pending'
           ORDER BY updated_at DESC
           LIMIT 1`,
        )
        .get(runId) as PlanHandoffRow | undefined;
      return this.parsePayload(row);
    }
    return this.findLatestMemory(
      (handoff) => handoff.runId === runId && handoff.status === "pending",
      (handoff) => handoff.createdAt,
    );
  }

  getApprovedByRunId(runId: string): PlanHandoffPayload | null {
    if (this.db) {
      const row = this.db
        .prepare(
          `${PLAN_HANDOFF_SELECT}
           WHERE run_id=? AND status='approved'
           ORDER BY responded_at DESC
           LIMIT 1`,
        )
        .get(runId) as PlanHandoffRow | undefined;
      return this.parsePayload(row);
    }
    return this.findLatestMemory(
      (handoff) => handoff.runId === runId && handoff.status === "approved",
      (handoff) => "respondedAt" in handoff ? handoff.respondedAt : handoff.createdAt,
    );
  }

  getPendingBySessionId(sessionId: string): PlanHandoffPayload | null {
    const parsed = PlanHandoffListFilterSchema.safeParse({ sessionId });
    if (!parsed.success || !parsed.data.sessionId) return null;
    const normalizedSessionId = parsed.data.sessionId;

    if (this.db) {
      const row = this.db
        .prepare(
          `${PLAN_HANDOFF_SELECT}
           WHERE session_id=? AND status='pending'
           ORDER BY updated_at DESC
           LIMIT 1`,
        )
        .get(normalizedSessionId) as PlanHandoffRow | undefined;
      return this.parsePayload(row);
    }
    return this.findLatestMemory(
      (handoff) => handoff.sessionId === normalizedSessionId && handoff.status === "pending",
      (handoff) => handoff.createdAt,
    );
  }

  listPending(input?: PlanHandoffListFilter): PlanHandoffPayload[] {
    const filter = parseListFilter(input);
    if (this.db) {
      const where = ["status='pending'"];
      const args: SQLInputValue[] = [];
      if (filter.runId) {
        where.push("run_id=?");
        args.push(filter.runId);
      }
      if (filter.sessionId) {
        where.push("session_id=?");
        args.push(filter.sessionId);
      }
      const rows = this.db
        .prepare(
          `${PLAN_HANDOFF_SELECT}
           WHERE ${where.join(" AND ")}
           ORDER BY updated_at DESC`,
        )
        .all(...args) as unknown as PlanHandoffRow[];
      return rows.map((row) => this.parsePayload(row)!);
    }

    return [...this.handoffs.keys()]
      .map((id) => this.readMemoryPayload(id))
      .filter((handoff): handoff is PlanHandoffPayload => Boolean(handoff))
      .filter((handoff) => handoff.status === "pending")
      .filter((handoff) => !filter.runId || handoff.runId === filter.runId)
      .filter((handoff) => !filter.sessionId || handoff.sessionId === filter.sessionId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  respond(id: string, input: PlanHandoffRespondInput): PlanHandoffPayload | null {
    const decision = parseRespondInput(input);
    const handoff = this.get(id);
    if (!handoff || handoff.status !== "pending") return null;

    const respondedAt = new Date().toISOString();
    const decidedPlan = handoff.plan
      ? {
          ...handoff.plan,
          planState: decision.decision === "approve"
            ? "approved" as const
            : "superseded" as const,
          updatedAt: respondedAt,
        }
      : undefined;
    const updated = PlanHandoffPayloadSchema.parse({
      ...handoff,
      ...(decidedPlan ? { plan: decidedPlan } : {}),
      status: decision.decision === "approve" ? "approved" : "rejected",
      decision: decision.decision,
      respondedAt,
    });

    if (this.db) {
      const result = this.db
        .prepare(
          `UPDATE plan_handoffs
           SET status=?, payload_json=?, updated_at=?, responded_at=?
           WHERE id=? AND status='pending'`,
        )
        .run(updated.status, JSON.stringify(updated), respondedAt, respondedAt, id);
      if (Number(result.changes) === 0) return null;
    } else {
      this.handoffs.set(id, clonePayload(updated));
    }
    return clonePayload(updated);
  }

  updatePlan(id: string, plan: AgentPlanContract): PlanHandoffPayload | null {
    const handoff = this.get(id);
    if (!handoff) return null;
    if (
      handoff.planId !== plan.planId
      || (handoff.planVersion !== undefined && handoff.planVersion !== plan.version)
    ) {
      throw new PlanHandoffValidationError(
        `计划交接 ${id} 与计划 ${plan.planId} v${plan.version} 不一致`,
      );
    }
    const updatedAt = new Date().toISOString();
    const updated = PlanHandoffPayloadSchema.parse({
      ...handoff,
      plan,
      planVersion: plan.version,
      planMarkdown: renderAgentPlanMarkdown(plan),
    });
    if (this.db) {
      const result = this.db.prepare(
        `UPDATE plan_handoffs
         SET payload_json=?, updated_at=?
         WHERE id=?`,
      ).run(JSON.stringify(updated), updatedAt, id);
      if (Number(result.changes) === 0) return null;
    } else {
      this.handoffs.set(id, clonePayload(updated));
    }
    return clonePayload(updated);
  }

  deleteByRunId(runId: string): void {
    if (this.db) {
      this.db.prepare(`DELETE FROM plan_handoffs WHERE run_id=?`).run(runId);
      return;
    }
    for (const [id, handoff] of this.handoffs) {
      if (handoff.runId === runId) this.handoffs.delete(id);
    }
  }

  private buildPayload(input: CreatePlanHandoffInput): PlanHandoffPayload {
    const id = randomUUID();
    return PlanHandoffPayloadSchema.parse({
      schemaVersion: PLAN_HANDOFF_SCHEMA_VERSION,
      id,
      planId: input.plan.planId,
      runId: input.runId,
      sessionId: input.sessionId,
      status: "pending",
      resumeMode: "implement",
      message: input.message,
      planVariant: input.planVariant,
      planMarkdown: renderAgentPlanMarkdown(input.plan),
      plan: input.plan,
      planVersion: input.plan.version,
      createdAt: new Date().toISOString(),
    });
  }

  private parsePayload(row: PlanHandoffRow | undefined): PlanHandoffPayload | null {
    if (!row) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(row.payload_json);
    } catch {
      throw new PlanHandoffPersistenceError("计划交接持久化 JSON 无法解析");
    }
    const payload = parsePersistedPayload(raw);
    assertSqlEnvelopeMatches(row, payload);
    return payload;
  }

  private readMemoryPayload(id: string): PlanHandoffPayload | null {
    const payload = this.handoffs.get(id);
    return payload ? parsePersistedPayload(payload) : null;
  }

  private findLatestMemory(
    predicate: (handoff: PlanHandoffPayload) => boolean,
    timestampOf: (handoff: PlanHandoffPayload) => string,
  ): PlanHandoffPayload | null {
    let latest: PlanHandoffPayload | null = null;
    for (const id of this.handoffs.keys()) {
      const handoff = this.readMemoryPayload(id);
      if (!handoff || !predicate(handoff)) continue;
      if (!latest || timestampOf(handoff) > timestampOf(latest)) latest = handoff;
    }
    return latest;
  }
}

function parseCreateInput(input: CreatePlanHandoffInput): CreatePlanHandoffInput {
  const parsed = PlanHandoffCreateInputSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new PlanHandoffValidationError(`计划交接创建参数无效：${formatIssues(parsed.error)}`);
}

function parseListFilter(input?: PlanHandoffListFilter): PlanHandoffListFilter {
  const parsed = PlanHandoffListFilterSchema.safeParse(input ?? {});
  if (parsed.success) return parsed.data;
  throw new PlanHandoffValidationError(`计划交接查询参数无效：${formatIssues(parsed.error)}`);
}

function parseRespondInput(input: PlanHandoffRespondInput): PlanHandoffRespondInput {
  const parsed = PlanHandoffRespondInputSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new PlanHandoffValidationError(`计划交接响应格式无效：${formatIssues(parsed.error)}`);
}

function parsePersistedPayload(raw: unknown): PlanHandoffPayload {
  const parsed = PlanHandoffPayloadSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new PlanHandoffPersistenceError(
    `计划交接持久化数据不符合 schemaVersion=1 契约：${formatIssues(parsed.error)}`,
  );
}

function clonePayload(payload: PlanHandoffPayload): PlanHandoffPayload {
  return PlanHandoffPayloadSchema.parse(payload);
}

function assertSqlEnvelopeMatches(row: PlanHandoffRow, payload: PlanHandoffPayload): void {
  const mismatches = [
    row.id === payload.id ? undefined : "id",
    row.plan_id === payload.planId ? undefined : "plan_id",
    row.run_id === payload.runId ? undefined : "run_id",
    row.session_id === (payload.sessionId ?? null) ? undefined : "session_id",
    row.status === payload.status ? undefined : "status",
    row.created_at === payload.createdAt ? undefined : "created_at",
    row.responded_at === ("respondedAt" in payload ? payload.respondedAt : null)
      ? undefined
      : "responded_at",
  ].filter((field): field is string => Boolean(field));
  if (mismatches.length === 0) return;
  throw new PlanHandoffPersistenceError(
    `计划交接 SQLite 索引列与 payload_json 不一致：${mismatches.join(", ")}`,
  );
}

function formatIssues(error: ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`)
    .join("; ");
}

export const defaultPlanHandoffStore = new PlanHandoffStore();
