import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import type { PermissionConfirmationRequest } from "./PermissionGuard.js";
import {
  PERMISSION_REQUEST_SCHEMA_VERSION,
  PermissionRequestCreateInputSchema,
  PermissionRequestItemSchema,
  PermissionRequestPayloadSchema,
  PermissionRequestRespondInputSchema,
  toScopedApprovedPermissions,
  type PermissionRequestCreateInput,
  type PermissionRequestItemInput,
  type PermissionRequestPayload,
  type PermissionRequestRespondInput,
} from "./permissionRequestTypes.js";

export class PermissionRequestValidationError extends Error {}
export class PermissionRequestPersistenceError extends Error {
  readonly code = "PERMISSION_REQUEST_PERSISTENCE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "PermissionRequestPersistenceError";
  }
}

export type CreatePermissionRequestInput = PermissionRequestCreateInput;

interface PermissionRequestRow {
  id: string;
  run_id: string;
  session_id: string | null;
  status: string;
  payload_json: string;
  created_at: string;
  responded_at: string | null;
}

export class PermissionRequestStore {
  private readonly requests = new Map<string, PermissionRequestPayload>();
  private readonly byRunId = new Map<string, string>();

  constructor(private readonly db?: DatabaseSync) {}

  usesConnection(db: DatabaseSync): boolean {
    return this.db === db;
  }

  create(input: CreatePermissionRequestInput): PermissionRequestPayload {
    const normalized = PermissionRequestCreateInputSchema.parse(input);
    if (this.db) {
      const existing = this.getPendingByRunId(normalized.runId);
      if (existing) return existing;

      const payload = this.buildPayload(normalized);
      this.db
        .prepare(
          `INSERT INTO permission_requests
           (id, run_id, session_id, status, payload_json, created_at, updated_at, responded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          payload.id,
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

    const existingId = this.byRunId.get(normalized.runId);
    if (existingId) {
      const existing = this.readMemoryPayload(existingId);
      if (existing?.status === "pending") return existing;
    }

    const payload = this.buildPayload(normalized);
    this.requests.set(payload.id, clonePayload(payload));
    this.byRunId.set(normalized.runId, payload.id);
    return clonePayload(payload);
  }

  private buildPayload(input: CreatePermissionRequestInput): PermissionRequestPayload {
    const requiredPermissions = input.requiredPermissions.map((item) => ({
      ...item,
      id: randomUUID(),
    }));
    return PermissionRequestPayloadSchema.parse({
      schemaVersion: PERMISSION_REQUEST_SCHEMA_VERSION,
      id: randomUUID(),
      runId: input.runId,
      sessionId: input.sessionId,
      projectId: input.projectId,
      status: "pending",
      title: input.title,
      summary: input.summary,
      planMarkdown: input.planMarkdown,
      intent: input.intent,
      executionStage: input.executionStage,
      planVariant: input.planVariant,
      requiredPermissions,
      blockedTool: input.blockedTool,
      approvalVersion: randomUUID(),
      createdAt: new Date().toISOString(),
    });
  }

  get(id: string): PermissionRequestPayload | null {
    if (this.db) {
      const row = this.db
        .prepare(
          `SELECT id, run_id, session_id, status, payload_json, created_at, responded_at
           FROM permission_requests WHERE id=?`,
        )
        .get(id) as PermissionRequestRow | undefined;
      return this.parsePayload(row);
    }
    return this.readMemoryPayload(id);
  }

  getPendingByRunId(runId: string): PermissionRequestPayload | null {
    if (this.db) {
      const row = this.db
        .prepare(
          `SELECT id, run_id, session_id, status, payload_json, created_at, responded_at
           FROM permission_requests
           WHERE run_id=? AND status='pending'
           ORDER BY updated_at DESC
           LIMIT 1`,
        )
        .get(runId) as PermissionRequestRow | undefined;
      return this.parsePayload(row);
    }

    const id = this.byRunId.get(runId);
    if (!id) return null;
    const request = this.readMemoryPayload(id);
    if (!request || request.status !== "pending") return null;
    return request;
  }

  getApprovedByRunId(runId: string): PermissionRequestPayload | null {
    if (this.db) {
      const row = this.db
        .prepare(
          `SELECT id, run_id, session_id, status, payload_json, created_at, responded_at
           FROM permission_requests
           WHERE run_id=? AND status='approved'
           ORDER BY updated_at DESC
           LIMIT 1`,
        )
        .get(runId) as PermissionRequestRow | undefined;
      return this.parsePayload(row);
    }
    for (const requestId of this.requests.keys()) {
      const request = this.readMemoryPayload(requestId);
      if (!request) continue;
      if (request.runId === runId && request.status === "approved") return request;
    }
    return null;
  }

  listPending(opts?: { sessionId?: string; runId?: string }): PermissionRequestPayload[] {
    if (this.db) {
      const where: string[] = ["status='pending'"];
      const args: SQLInputValue[] = [];
      if (opts?.runId) {
        where.push("run_id=?");
        args.push(opts.runId);
      }
      if (opts?.sessionId) {
        where.push("session_id=?");
        args.push(opts.sessionId);
      }
      const rows = this.db
        .prepare(
          `SELECT id, run_id, session_id, status, payload_json, created_at, responded_at
           FROM permission_requests
           WHERE ${where.join(" AND ")}
           ORDER BY updated_at DESC`,
        )
        .all(...args) as unknown as PermissionRequestRow[];
      return rows
        .map((row) => this.parsePayload(row))
        .filter((item): item is PermissionRequestPayload => Boolean(item));
    }

    const all = [...this.requests.keys()]
      .map((id) => this.readMemoryPayload(id))
      .filter((item): item is PermissionRequestPayload => item?.status === "pending");
    return all
      .filter((item) => !opts?.runId || item.runId === opts.runId)
      .filter((item) => !opts?.sessionId || item.sessionId === opts.sessionId);
  }

  respond(id: string, input: PermissionRequestRespondInput): PermissionRequestPayload | null {
    const parsedInput = PermissionRequestRespondInputSchema.safeParse(input);
    if (!parsedInput.success) {
      const issue = parsedInput.error.issues[0];
      const field = issue?.path.join(".") || "body";
      throw new PermissionRequestValidationError(
        `权限响应格式无效：${field} ${issue?.message ?? "不符合契约"}`,
      );
    }
    input = parsedInput.data;
    const existing = this.get(id);
    if (!existing || existing.status !== "pending") return null;
    if (input.approvalVersion !== existing.approvalVersion) {
      throw new PermissionRequestValidationError("权限申请版本不匹配，请刷新后重新确认");
    }
    if (input.decision === "allow_session" && !existing.sessionId) {
      throw new PermissionRequestValidationError(
        "该权限申请没有 sessionId，不能使用 allow_session",
      );
    }
    if (input.decision === "allow_project" && !existing.projectId) {
      throw new PermissionRequestValidationError(
        "该权限申请没有 projectId，不能使用 allow_project",
      );
    }
    if (
      input.decision === "allow_workspace"
      && existing.requiredPermissions.some((item) => item.type === "shell")
    ) {
      throw new PermissionRequestValidationError(
        "shell 权限不支持长期工作区授权，请使用允许一次或本次会话",
      );
    }

    const respondedAt = new Date().toISOString();
    if (input.decision === "deny") {
      const denied = PermissionRequestPayloadSchema.parse({
        ...existing,
        status: "denied",
        respondedAt,
        decision: input.decision,
      });
      this.persistResponse(denied, respondedAt);
      return clonePayload(denied);
    }

    const requestedIds = input.approvedItemIds;
    const requiredById = new Map(existing.requiredPermissions.map((item) => [item.id, item]));
    const approvedItems = requestedIds.map((itemId) => {
      const item = requiredById.get(itemId);
      if (!item) {
        throw new PermissionRequestValidationError(`批准项不属于原权限申请：${itemId}`);
      }
      return item;
    });
    const approved = PermissionRequestPayloadSchema.parse({
      ...existing,
      status: "approved",
      respondedAt,
      decision: input.decision,
      approvedItemIds: requestedIds,
      approvedPermissions: toScopedApprovedPermissions(approvedItems),
    });
    this.persistResponse(approved, respondedAt);
    return clonePayload(approved);
  }

  /**
   * 消费一次已批准动作。调用方必须使用 payload.blockedTool 中的服务端快照，
   * 不能再接受客户端重传的 tool/input。
   */
  consumeApproved(id: string, expectedTool: string): PermissionRequestPayload | null {
    const existing = this.get(id);
    if (
      !existing ||
      existing.status !== "approved" ||
      existing.consumedAt ||
      existing.blockedTool?.name !== expectedTool
    ) {
      return null;
    }
    const consumed = PermissionRequestPayloadSchema.parse({
      ...existing,
      consumedAt: new Date().toISOString(),
    });
    this.persistPayload(consumed);
    return clonePayload(consumed);
  }

  private persistResponse(payload: PermissionRequestPayload, respondedAt: string): void {
    const validated = clonePayload(payload);
    if (!this.db) {
      this.requests.set(validated.id, validated);
      return;
    }
    const result = this.db
      .prepare(
        `UPDATE permission_requests
         SET status=?, payload_json=?, updated_at=?, responded_at=?
         WHERE id=? AND status='pending'`,
      )
      .run(
        validated.status,
        JSON.stringify(validated),
        respondedAt,
        respondedAt,
        validated.id,
      );
    if (Number(result.changes) !== 1) {
      throw new PermissionRequestPersistenceError(
        `权限申请 ${validated.id} 未能从 pending 原子迁移到 ${validated.status}`,
      );
    }
  }

  private persistPayload(payload: PermissionRequestPayload): void {
    const validated = clonePayload(payload);
    if (!this.db) {
      this.requests.set(validated.id, validated);
      return;
    }
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(`UPDATE permission_requests SET payload_json=?, updated_at=? WHERE id=?`)
      .run(JSON.stringify(validated), updatedAt, validated.id);
  }

  private parsePayload(row: PermissionRequestRow | undefined): PermissionRequestPayload | null {
    if (!row) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(row.payload_json);
    } catch {
      throw new PermissionRequestPersistenceError("权限申请持久化 JSON 无法解析");
    }
    const payload = parsePersistedPayload(raw);
    assertSqlEnvelopeMatches(row, payload);
    return payload;
  }

  private readMemoryPayload(id: string): PermissionRequestPayload | null {
    const payload = this.requests.get(id);
    return payload ? parsePersistedPayload(payload) : null;
  }
}

function clonePayload(payload: PermissionRequestPayload): PermissionRequestPayload {
  return PermissionRequestPayloadSchema.parse(payload);
}

function assertSqlEnvelopeMatches(
  row: PermissionRequestRow,
  payload: PermissionRequestPayload,
): void {
  const mismatches = [
    row.id === payload.id ? undefined : "id",
    row.run_id === payload.runId ? undefined : "run_id",
    row.session_id === (payload.sessionId ?? null) ? undefined : "session_id",
    row.status === payload.status ? undefined : "status",
    row.created_at === payload.createdAt ? undefined : "created_at",
    row.responded_at === (payload.respondedAt ?? null) ? undefined : "responded_at",
  ].filter((field): field is string => Boolean(field));
  if (mismatches.length === 0) return;
  throw new PermissionRequestPersistenceError(
    `权限申请 SQLite 索引列与 payload_json 不一致：${mismatches.join(", ")}`,
  );
}

function parsePersistedPayload(raw: unknown): PermissionRequestPayload {
  const normalized = normalizeLegacyPayload(raw);
  const parsed = PermissionRequestPayloadSchema.safeParse(normalized);
  if (parsed.success) return parsed.data;
  const details = parsed.error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`)
    .join("; ");
  throw new PermissionRequestPersistenceError(
    `权限申请持久化数据不符合 schemaVersion=1 契约：${details}`,
  );
}

function normalizeLegacyPayload(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : undefined;
  const requiredPermissions = Array.isArray(raw.requiredPermissions)
    ? raw.requiredPermissions.map((item, index) => {
        if (!isRecord(item)) return item;
        const itemId = typeof item.id === "string" && item.id.trim()
          ? item.id.trim()
          : id
            ? `legacy:${id}:${index}`
            : item.id;
        return { ...item, id: itemId };
      })
    : raw.requiredPermissions;
  const normalized: Record<string, unknown> = {
    ...raw,
    requiredPermissions,
    approvalVersion:
      typeof raw.approvalVersion === "string" && raw.approvalVersion.trim()
        ? raw.approvalVersion
        : id
          ? `legacy:${id}`
          : raw.approvalVersion,
  };

  if (raw.status !== "approved") return normalized;
  const parsedItems = PermissionRequestItemSchema.array().safeParse(requiredPermissions);
  if (!parsedItems.success) return normalized;
  if (normalized.approvedItemIds === undefined) {
    normalized.approvedItemIds = parsedItems.data.map((item) => item.id);
  }
  if (
    normalized.approvedPermissions === undefined
    && Array.isArray(normalized.approvedItemIds)
  ) {
    const approvedIds = new Set(normalized.approvedItemIds);
    normalized.approvedPermissions = toScopedApprovedPermissions(
      parsedItems.data.filter((item) => approvedIds.has(item.id)),
    );
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const defaultPermissionRequestStore = new PermissionRequestStore();

export function permissionItemsFromConfirmation(
  confirmation: PermissionConfirmationRequest,
): PermissionRequestItemInput[] {
  const items: PermissionRequestItemInput[] = [];
  for (const file of confirmation.affects.files) {
      items.push({
        type: confirmation.permission === "read" ? "read_file" : "write_file",
        target: file,
        reason: confirmation.message,
        tool: confirmation.tool,
        riskTier: confirmation.risk.tier,
        rootPath: file.replace(/[\\/]\*\*?$/, ""),
        operation: confirmation.permission === "read" ? "read" : "write",
        pathRisk: confirmation.risk.reasons.find((r) => r !== "cross_workspace"),
      });
  }
  for (const command of confirmation.affects.commands) {
      items.push({
        type: "shell",
        target: command,
        reason: confirmation.message,
        tool: confirmation.tool,
        riskTier: confirmation.risk.tier,
        rootPath: command.replace(/[\\/]\*\*?$/, ""),
        operation: "shell",
        pathRisk: confirmation.risk.reasons.find((r) => r !== "cross_workspace"),
      });
  }
  for (const target of confirmation.affects.networkTargets) {
    items.push({
      type: "network",
      target,
      reason: confirmation.message,
      tool: confirmation.tool,
      riskTier: confirmation.risk.tier,
    });
  }
  if (items.length === 0) {
    items.push({
      type:
        confirmation.permission === "read"
          ? "read_file"
          : confirmation.permission === "shell"
            ? "shell"
            : "write_file",
      target: confirmation.action,
      reason: confirmation.message,
      tool: confirmation.tool,
      riskTier: confirmation.risk.tier,
      rootPath: confirmation.action.replace(/[\\/]\*\*?$/, ""),
      operation:
        confirmation.permission === "read"
          ? "read"
          : confirmation.permission === "shell"
            ? "shell"
            : "write",
      pathRisk: confirmation.risk.reasons.find((r) => r !== "cross_workspace"),
    });
  }
  return items;
}
