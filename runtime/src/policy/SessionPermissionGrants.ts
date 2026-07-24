import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import {
  PermissionRequestItemTypeSchema,
  ScopedApprovedPermissionsSchema,
  type ScopedApprovedPermissions,
} from "./permissionRequestTypes.js";

const SessionPermissionGrantSchema = ScopedApprovedPermissionsSchema.superRefine(
  (grant, ctx) => {
    const populatedTypes = PermissionRequestItemTypeSchema.options.filter(
      (type) => (grant[type]?.length ?? 0) > 0,
    );
    if (populatedTypes.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "会话授权至少包含一个权限目标",
      });
    }
    for (const type of populatedTypes) {
      const targets = grant[type] ?? [];
      if (new Set(targets).size === targets.length) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${type} 授权目标不得重复`,
        path: [type],
      });
    }
  },
);

export class SessionPermissionGrantValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionPermissionGrantValidationError";
  }
}

export class SessionPermissionGrantPersistenceError extends Error {
  readonly code = "SESSION_PERMISSION_GRANT_PERSISTENCE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "SessionPermissionGrantPersistenceError";
  }
}

/** 会话级已批准权限；数据库模式以 memory.db 为唯一权威。 */
export class SessionPermissionGrants {
  private readonly grants = new Map<string, ScopedApprovedPermissions>();

  constructor(private readonly db?: DatabaseSync) {}

  usesConnection(db: DatabaseSync): boolean {
    return this.db === db;
  }

  get(sessionId: string | undefined): ScopedApprovedPermissions | undefined {
    const normalizedSessionId = sessionId?.trim();
    if (!normalizedSessionId) return undefined;
    if (!this.db) {
      const existing = this.grants.get(normalizedSessionId);
      return existing ? cloneScoped(existing) : undefined;
    }

    const row = this.db
      .prepare(`SELECT grants_json FROM session_permission_grants WHERE session_id=?`)
      .get(normalizedSessionId) as { grants_json: string } | undefined;
    if (!row) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(row.grants_json);
    } catch {
      throw new SessionPermissionGrantPersistenceError(
        `会话 ${normalizedSessionId} 的 grants_json 无法解析`,
      );
    }
    const parsed = SessionPermissionGrantSchema.safeParse(raw);
    if (!parsed.success) {
      throw new SessionPermissionGrantPersistenceError(
        `会话 ${normalizedSessionId} 的持久授权不符合契约：${formatIssues(parsed.error)}`,
      );
    }
    return cloneScoped(parsed.data);
  }

  merge(sessionId: string, patch: ScopedApprovedPermissions): ScopedApprovedPermissions {
    const normalizedSessionId = parseSessionId(sessionId);
    const normalizedPatch = parseGrantPatch(patch);
    const merged = cloneScoped(mergeScoped(this.get(normalizedSessionId) ?? {}, normalizedPatch));

    if (this.db) {
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO session_permission_grants (session_id, grants_json, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             grants_json=excluded.grants_json,
             updated_at=excluded.updated_at`,
        )
        .run(normalizedSessionId, JSON.stringify(merged), now);
      return cloneScoped(merged);
    }

    this.grants.set(normalizedSessionId, cloneScoped(merged));
    return cloneScoped(merged);
  }

  clear(sessionId: string): void {
    const normalizedSessionId = parseSessionId(sessionId);
    if (this.db) {
      this.db
        .prepare(`DELETE FROM session_permission_grants WHERE session_id=?`)
        .run(normalizedSessionId);
      return;
    }
    this.grants.delete(normalizedSessionId);
  }
}

export const defaultSessionPermissionGrants = new SessionPermissionGrants();

function parseSessionId(sessionId: string): string {
  const normalized = sessionId.trim();
  if (normalized) return normalized;
  throw new SessionPermissionGrantValidationError("sessionId 不能为空");
}

function parseGrantPatch(patch: ScopedApprovedPermissions): ScopedApprovedPermissions {
  const parsed = SessionPermissionGrantSchema.safeParse(patch);
  if (parsed.success) return parsed.data;
  throw new SessionPermissionGrantValidationError(
    `会话授权参数无效：${formatIssues(parsed.error)}`,
  );
}

function mergeScoped(
  base: ScopedApprovedPermissions,
  patch: ScopedApprovedPermissions,
): ScopedApprovedPermissions {
  const merged: ScopedApprovedPermissions = { ...base };
  for (const type of PermissionRequestItemTypeSchema.options) {
    const next = [...new Set([...(merged[type] ?? []), ...(patch[type] ?? [])])];
    if (next.length > 0) merged[type] = next;
  }
  return SessionPermissionGrantSchema.parse(merged);
}

function cloneScoped(value: ScopedApprovedPermissions): ScopedApprovedPermissions {
  return SessionPermissionGrantSchema.parse(value);
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "grant"}: ${issue.message}`)
    .join("; ");
}
