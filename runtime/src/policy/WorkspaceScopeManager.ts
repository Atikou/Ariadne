import { randomUUID } from "node:crypto";
import path from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { ZodError } from "zod";

import { canonicalizePathIdentity } from "../platform/pathIdentity.js";
import type { ScopedApprovedPermissions } from "./permissionRequestTypes.js";
import {
  WorkspaceAccessAuditFilterSchema,
  WorkspaceAccessAuditInputSchema,
  WorkspaceAccessAuditRecordSchema,
  WorkspaceGrantFilterSchema,
  WorkspaceGrantInputSchema,
  WorkspaceGrantRevokeReasonSchema,
  WorkspaceGrantSchema,
  WorkspaceScopeUpdateRequestSchema,
  WorkspaceScopeSchema,
  type WorkspaceAccessAuditFilter,
  type WorkspaceAccessAuditInput,
  type WorkspaceAccessAuditRecord,
  type WorkspaceGrant,
  type WorkspaceGrantBinding,
  type WorkspaceGrantFilter,
  type WorkspaceGrantInput,
  type WorkspaceScope,
  type WorkspaceScopePermission,
  type WorkspaceScopeUpdateRequest,
} from "./workspaceScopeContracts.js";

export type {
  WorkspaceAccessAuditFilter,
  WorkspaceAccessAuditInput,
  WorkspaceAccessAuditRecord,
  WorkspaceGrant,
  WorkspaceGrantBinding,
  WorkspaceGrantFilter,
  WorkspaceGrantInput,
  WorkspaceGrantScope,
  WorkspaceGrantSource,
  WorkspaceScope,
  WorkspaceScopeGrantScope,
  WorkspaceScopeKind,
  WorkspaceScopePermission,
  WorkspaceScopeUpdateRequest,
} from "./workspaceScopeContracts.js";

export class WorkspaceGrantValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceGrantValidationError";
  }
}

export class WorkspaceGrantPersistenceError extends Error {
  readonly code = "WORKSPACE_GRANT_PERSISTENCE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceGrantPersistenceError";
  }
}

export class WorkspaceAccessAuditValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceAccessAuditValidationError";
  }
}

export class WorkspaceAccessAuditPersistenceError extends Error {
  readonly code = "WORKSPACE_ACCESS_AUDIT_PERSISTENCE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceAccessAuditPersistenceError";
  }
}

export class WorkspaceGrantStore {
  private readonly grants = new Map<string, WorkspaceGrant>();
  private readonly audit = new Map<string, WorkspaceAccessAuditRecord>();

  constructor(private readonly db?: DatabaseSync) {}

  usesConnection(db: DatabaseSync): boolean {
    return this.db === db;
  }

  list(filter: WorkspaceGrantFilter = {}): WorkspaceGrant[] {
    const normalizedFilter = parseGrantFilter(filter);
    const now = Date.now();
    const active = (grant: WorkspaceGrant) => {
      if (!normalizedFilter.includeRevoked && grant.revokedAt) return false;
      if (
        !normalizedFilter.includeExpired
        && grant.expiresAt
        && Date.parse(grant.expiresAt) <= now
      ) return false;
      if (grant.scope === "session" && grant.sessionId !== normalizedFilter.sessionId) return false;
      if (grant.scope === "project" && grant.projectId !== normalizedFilter.projectId) return false;
      return true;
    };

    if (!this.db) {
      return [...this.grants.values()]
        .map((grant) => cloneGrant(grant))
        .filter(active);
    }

    const where: string[] = [];
    const args: SQLInputValue[] = [];
    if (!normalizedFilter.includeRevoked) where.push("revoked_at IS NULL");
    if (!normalizedFilter.includeExpired) {
      where.push("(expires_at IS NULL OR expires_at > ?)");
      args.push(new Date().toISOString());
    }
    if (normalizedFilter.sessionId) {
      where.push("(scope != 'session' OR session_id = ?)");
      args.push(normalizedFilter.sessionId);
    } else {
      where.push("scope != 'session'");
    }
    if (normalizedFilter.projectId) {
      where.push("(scope != 'project' OR project_id = ?)");
      args.push(normalizedFilter.projectId);
    } else {
      where.push("scope != 'project'");
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM workspace_grants
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY updated_at DESC`,
      )
      .all(...args) as unknown as WorkspaceGrantRow[];
    return rows.map(rowToGrant).filter(active);
  }

  add(input: WorkspaceGrantInput): WorkspaceGrant {
    const normalized = parseGrantInput(input);
    const now = new Date().toISOString();
    const grant = parseGrant({
      ...normalized,
      id: normalized.id ?? randomUUID(),
      rootPath: canonicalizeExistingPath(normalized.rootPath),
      createdAt: now,
      updatedAt: now,
      source: normalized.source ?? "user_confirmed",
    });
    if (this.db) {
      this.db
        .prepare(
          `INSERT INTO workspace_grants
           (id, session_id, project_id, task_id, root_path, permissions_json, scope, source,
            created_at, updated_at, expires_at, revoked_at, revoked_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          grant.id,
          grant.sessionId ?? null,
          grant.projectId ?? null,
          grant.taskId ?? null,
          grant.rootPath,
          JSON.stringify(grant.permissions),
          grant.scope,
          grant.source,
          grant.createdAt,
          grant.updatedAt,
          grant.expiresAt ?? null,
          null,
          null,
        );
      return cloneGrant(grant);
    }
    this.grants.set(grant.id, cloneGrant(grant));
    return cloneGrant(grant);
  }

  update(id: string, patch: WorkspaceScopeUpdateRequest): WorkspaceGrant | null {
    const grantId = id.trim();
    if (!grantId) return null;
    const normalized = parseGrantUpdate(patch);
    const existing = this.get(grantId);
    if (!existing || existing.revokedAt) return null;
    const binding = normalized.binding ?? bindingFromGrant(existing);
    const updated = parseGrant({
      ...existing,
      sessionId: binding.scope === "session" ? binding.sessionId : undefined,
      projectId: binding.scope === "project" ? binding.projectId : undefined,
      permissions: normalized.permissions ?? existing.permissions,
      expiresAt: normalized.expiresAt === null
        ? undefined
        : normalized.expiresAt ?? existing.expiresAt,
      scope: binding.scope,
      updatedAt: new Date().toISOString(),
    });
    if (this.db) {
      const result = this.db
        .prepare(
          `UPDATE workspace_grants
           SET session_id=?, project_id=?, permissions_json=?, scope=?, expires_at=?, updated_at=?
           WHERE id=? AND revoked_at IS NULL`,
        )
        .run(
          updated.sessionId ?? null,
          updated.projectId ?? null,
          JSON.stringify(updated.permissions),
          updated.scope,
          updated.expiresAt ?? null,
          updated.updatedAt,
          grantId,
        );
      if (Number(result.changes) === 0) return null;
      return cloneGrant(updated);
    }
    this.grants.set(grantId, cloneGrant(updated));
    return cloneGrant(updated);
  }

  revoke(id: string, reason = "user_revoked"): boolean {
    const grantId = id.trim();
    if (!grantId) return false;
    const parsedReason = WorkspaceGrantRevokeReasonSchema.safeParse(reason);
    if (!parsedReason.success) {
      throw new WorkspaceGrantValidationError(
        `工作区授权撤销原因无效：${formatIssues(parsedReason.error)}`,
      );
    }
    const existing = this.get(grantId);
    if (!existing || existing.revokedAt) return false;
    const revokedAt = new Date().toISOString();
    const revoked = parseGrant({
      ...existing,
      revokedAt,
      revokedReason: parsedReason.data,
      updatedAt: revokedAt,
    });
    if (this.db) {
      const result = this.db
        .prepare(
          `UPDATE workspace_grants
           SET revoked_at=?, revoked_reason=?, updated_at=?
           WHERE id=? AND revoked_at IS NULL`,
        )
        .run(revokedAt, parsedReason.data, revokedAt, grantId);
      return Number(result.changes) > 0;
    }
    this.grants.set(grantId, cloneGrant(revoked));
    return true;
  }

  get(id: string): WorkspaceGrant | null {
    const grantId = id.trim();
    if (!grantId) return null;
    if (!this.db) {
      const memory = this.grants.get(grantId);
      return memory ? cloneGrant(memory) : null;
    }
    const row = this.db
      .prepare(`SELECT * FROM workspace_grants WHERE id=?`)
      .get(grantId) as WorkspaceGrantRow | undefined;
    return row ? rowToGrant(row) : null;
  }

  recordAccess(input: WorkspaceAccessAuditInput): WorkspaceAccessAuditRecord {
    const normalizedInput = parseAuditInput(input);
    const record = parseAuditRecord({
      ...normalizedInput,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    });
    if (this.db) {
      this.db
        .prepare(
          `INSERT INTO workspace_access_audit
           (id, run_id, session_id, task_id, tool_call_id, tool_name, operation, normalized_path,
            matched_root, workspace_scope_id, grant_id, permission_source, decision, reason,
            cross_workspace, path_risk, path_risk_tier, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.runId ?? null,
          record.sessionId ?? null,
          record.taskId ?? null,
          record.toolCallId ?? null,
          record.toolName,
          record.operation,
          record.normalizedPath,
          record.matchedRoot ?? null,
          record.workspaceScopeId ?? null,
          record.grantId ?? null,
          record.permissionSource ?? null,
          record.decision,
          record.reason,
          record.crossWorkspace ? 1 : 0,
          record.pathRisk,
          record.pathRiskTier,
          record.createdAt,
        );
      return cloneAuditRecord(record);
    }
    this.audit.set(record.id, cloneAuditRecord(record));
    return cloneAuditRecord(record);
  }

  listAudit(filter: WorkspaceAccessAuditFilter = {}): WorkspaceAccessAuditRecord[] {
    const normalizedFilter = parseAuditFilter(filter);
    const limit = normalizedFilter.limit ?? 100;
    if (!this.db) {
      return [...this.audit.values()]
        .filter((record) => !normalizedFilter.sessionId || record.sessionId === normalizedFilter.sessionId)
        .filter((record) => !normalizedFilter.runId || record.runId === normalizedFilter.runId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
        .slice(0, limit)
        .map(cloneAuditRecord);
    }
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    if (normalizedFilter.sessionId) {
      where.push("session_id=?");
      args.push(normalizedFilter.sessionId);
    }
    if (normalizedFilter.runId) {
      where.push("run_id=?");
      args.push(normalizedFilter.runId);
    }
    args.push(limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM workspace_access_audit
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...args) as unknown as WorkspaceAuditRow[];
    return rows.map(rowToAudit);
  }
}

export interface WorkspaceScopeManagerOptions {
  primaryRoot: string;
  primaryLabel?: string;
  grants?: WorkspaceGrantStore;
  configScopes?: Array<{
    id: string;
    rootPath: string;
    label?: string;
    permissions?: WorkspaceScopePermission[];
  }>;
}

export class WorkspaceScopeManager {
  private readonly primaryRoot: string;
  private readonly grants: WorkspaceGrantStore;
  private readonly configScopes: WorkspaceScope[];

  constructor(private readonly options: WorkspaceScopeManagerOptions) {
    this.primaryRoot = canonicalizeExistingPath(options.primaryRoot);
    this.grants = options.grants ?? new WorkspaceGrantStore();
    this.configScopes = (options.configScopes ?? []).map((scope) => parseScope({
      id: scope.id,
      rootPath: canonicalizeExistingPath(scope.rootPath),
      label: scope.label,
      kind: "config",
      permissions: scope.permissions ?? ["read"],
      grantScope: "project",
      source: "config",
      grantVersion: "config",
    }));
  }

  getScopes(input?: {
    sessionId?: string;
    projectId?: string;
    scopedGrants?: ScopedApprovedPermissions;
  }): WorkspaceScope[] {
    const primary = parseScope({
      id: "primary",
      rootPath: this.primaryRoot,
      label: this.options.primaryLabel ?? "Primary workspace",
      kind: "primary",
      permissions: ["read", "write", "shell"],
      grantScope: "workspace",
      source: "primary",
      grantVersion: "primary",
    });
    const persisted = this.grants.list({ sessionId: input?.sessionId, projectId: input?.projectId }).map(grantToScope);
    const scoped = scopesFromApprovedPermissions(input?.scopedGrants);
    return dedupeScopes([primary, ...this.configScopes, ...persisted, ...scoped]);
  }

  addScope(grant: WorkspaceGrantInput): WorkspaceGrant {
    return this.grants.add(grant);
  }

  revokeScope(scopeId: string): boolean {
    return this.grants.revoke(scopeId);
  }

  resolveScopeForPath(
    targetPath: string,
    operation: WorkspaceScopePermission,
    input?: { sessionId?: string; projectId?: string; scopedGrants?: ScopedApprovedPermissions },
  ): WorkspaceScope | null {
    const full = canonicalizeExistingPath(targetPath);
    const matches = this.getScopes(input)
      .filter((scope) => scope.permissions.includes(operation))
      .filter((scope) => isInsideScope(scope.rootPath, full))
      .sort((a, b) => b.rootPath.length - a.rootPath.length);
    return matches[0] ?? null;
  }
}

export function isInsideScope(rootPath: string, targetPath: string): boolean {
  const root = canonicalizeExistingPath(rootPath);
  const full = canonicalizeExistingPath(targetPath);
  const rel = path.relative(root, full);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function canonicalizeExistingPath(inputPath: string): string {
  return canonicalizePathIdentity(inputPath);
}

function grantToScope(grant: WorkspaceGrant): WorkspaceScope {
  return parseScope({
    id: grant.id,
    rootPath: grant.rootPath,
    kind: "granted",
    permissions: grant.permissions,
    grantScope: grant.scope,
    expiresAt: grant.expiresAt,
    grantId: grant.id,
    source: grant.source,
    grantVersion: grant.updatedAt,
  });
}

function scopesFromApprovedPermissions(grants?: ScopedApprovedPermissions): WorkspaceScope[] {
  if (!grants) return [];
  const scopes: WorkspaceScope[] = [];
  const add = (bucket: keyof ScopedApprovedPermissions, permission: WorkspaceScopePermission) => {
    for (const target of grants[bucket] ?? []) {
      const rootPath = normalizeGrantTargetToRoot(target);
      if (!rootPath) continue;
      scopes.push(parseScope({
        id: `scoped:${bucket}:${rootPath}`,
        rootPath,
        kind: "temporary",
        permissions: [permission],
        grantScope: "once",
        source: "user_confirmed",
        grantId: `scoped:${bucket}:${rootPath}`,
        grantVersion: "once",
      }));
    }
  };
  add("read_file", "read");
  add("write_file", "write");
  add("shell", "shell");
  return scopes;
}

export function normalizeGrantTargetToRoot(target: string): string | undefined {
  const trimmed = target.trim();
  if (!trimmed) return undefined;
  const withoutGlob = trimmed.replace(/[\\/]\*\*?$/, "");
  // Windows 的裸盘符（例如从 D:/** 去掉 glob 后得到的 D:）表示“该盘当前目录”，
  // 并不等价于磁盘根目录 D:\。权限作用域禁止保留这种上下文相关语义，
  // 否则用户明明批准了盘根目录，续跑时却会被解析回进程当前工作目录并再次阻塞。
  const unambiguousRoot = /^[a-zA-Z]:$/.test(withoutGlob) ? `${withoutGlob}\\` : withoutGlob;
  return canonicalizeExistingPath(unambiguousRoot);
}

function dedupeScopes(scopes: WorkspaceScope[]): WorkspaceScope[] {
  const byKey = new Map<string, WorkspaceScope>();
  for (const scope of scopes) {
    const rootPath = canonicalizeExistingPath(scope.rootPath);
    const key = `${rootPath.toLowerCase()}::${scope.kind}::${scope.source}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, parseScope({ ...scope, rootPath }));
      continue;
    }
    existing.permissions = [...new Set([...existing.permissions, ...scope.permissions])];
    existing.grantVersion = [existing.grantVersion, scope.grantVersion].filter(Boolean).join("|");
  }
  return [...byKey.values()].map((scope) => parseScope(scope));
}

interface WorkspaceGrantRow {
  id: string;
  session_id: string | null;
  project_id: string | null;
  task_id: string | null;
  root_path: string;
  permissions_json: string;
  scope: string;
  source: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
}

function rowToGrant(row: WorkspaceGrantRow): WorkspaceGrant {
  let permissions: unknown;
  try {
    permissions = JSON.parse(row.permissions_json);
  } catch {
    throw new WorkspaceGrantPersistenceError(
      `工作区授权 ${row.id} 的 permissions_json 无法解析`,
    );
  }
  const persisted = parsePersistedGrant({
    id: row.id,
    sessionId: row.session_id ?? undefined,
    projectId: row.project_id ?? undefined,
    taskId: row.task_id ?? undefined,
    rootPath: row.root_path,
    permissions,
    scope: row.scope,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
    revokedReason: row.revoked_reason ?? undefined,
  }, row.id);
  return parsePersistedGrant({
    ...persisted,
    rootPath: canonicalizeExistingPath(persisted.rootPath),
  }, row.id);
}

function parseGrantInput(input: WorkspaceGrantInput): WorkspaceGrantInput {
  const parsed = WorkspaceGrantInputSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new WorkspaceGrantValidationError(
    `工作区授权创建参数无效：${formatIssues(parsed.error)}`,
  );
}

function parseGrantFilter(filter: WorkspaceGrantFilter): WorkspaceGrantFilter {
  const parsed = WorkspaceGrantFilterSchema.safeParse(filter);
  if (parsed.success) return parsed.data;
  throw new WorkspaceGrantValidationError(
    `工作区授权查询参数无效：${formatIssues(parsed.error)}`,
  );
}

function parseAuditInput(input: WorkspaceAccessAuditInput): WorkspaceAccessAuditInput {
  const parsed = WorkspaceAccessAuditInputSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new WorkspaceAccessAuditValidationError(
    `工作区访问审计参数无效：${formatIssues(parsed.error)}`,
  );
}

function parseAuditFilter(filter: WorkspaceAccessAuditFilter): WorkspaceAccessAuditFilter {
  const parsed = WorkspaceAccessAuditFilterSchema.safeParse(filter);
  if (parsed.success) return parsed.data;
  throw new WorkspaceAccessAuditValidationError(
    `工作区访问审计查询参数无效：${formatIssues(parsed.error)}`,
  );
}

function parseAuditRecord(value: unknown): WorkspaceAccessAuditRecord {
  const parsed = WorkspaceAccessAuditRecordSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new WorkspaceAccessAuditValidationError(
    `工作区访问审计状态无效：${formatIssues(parsed.error)}`,
  );
}

function parsePersistedAudit(value: unknown, id: string): WorkspaceAccessAuditRecord {
  const parsed = WorkspaceAccessAuditRecordSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new WorkspaceAccessAuditPersistenceError(
    `工作区访问审计 ${id} 的 SQLite 记录不符合契约：${formatIssues(parsed.error)}`,
  );
}

function cloneAuditRecord(record: WorkspaceAccessAuditRecord): WorkspaceAccessAuditRecord {
  return parseAuditRecord(record);
}

function parseGrantUpdate(update: WorkspaceScopeUpdateRequest): WorkspaceScopeUpdateRequest {
  const parsed = WorkspaceScopeUpdateRequestSchema.safeParse(update);
  if (parsed.success) return parsed.data;
  throw new WorkspaceGrantValidationError(
    `工作区授权更新参数无效：${formatIssues(parsed.error)}`,
  );
}

function parseGrant(value: unknown): WorkspaceGrant {
  const parsed = WorkspaceGrantSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new WorkspaceGrantValidationError(
    `工作区授权状态无效：${formatIssues(parsed.error)}`,
  );
}

function parsePersistedGrant(value: unknown, id: string): WorkspaceGrant {
  const parsed = WorkspaceGrantSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new WorkspaceGrantPersistenceError(
    `工作区授权 ${id} 的 SQLite 记录不符合契约：${formatIssues(parsed.error)}`,
  );
}

function cloneGrant(grant: WorkspaceGrant): WorkspaceGrant {
  return parseGrant(grant);
}

function parseScope(value: unknown): WorkspaceScope {
  const parsed = WorkspaceScopeSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new WorkspaceGrantValidationError(
    `工作区 scope 状态无效：${formatIssues(parsed.error)}`,
  );
}

function bindingFromGrant(grant: WorkspaceGrant): WorkspaceGrantBinding {
  if (grant.scope === "session") {
    return { scope: "session", sessionId: grant.sessionId! };
  }
  if (grant.scope === "project") {
    return { scope: "project", projectId: grant.projectId! };
  }
  return { scope: "workspace" };
}

function formatIssues(error: ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`)
    .join("; ");
}

interface WorkspaceAuditRow {
  id: string;
  run_id: string | null;
  session_id: string | null;
  task_id: string | null;
  tool_call_id: string | null;
  tool_name: string;
  operation: string;
  normalized_path: string;
  matched_root: string | null;
  workspace_scope_id: string | null;
  grant_id: string | null;
  permission_source: string | null;
  decision: string;
  reason: string;
  cross_workspace: number;
  path_risk: string;
  path_risk_tier: string;
  created_at: string;
}

function rowToAudit(row: WorkspaceAuditRow): WorkspaceAccessAuditRecord {
  if (row.cross_workspace !== 0 && row.cross_workspace !== 1) {
    throw new WorkspaceAccessAuditPersistenceError(
      `工作区访问审计 ${row.id} 的 cross_workspace 不是 0 或 1`,
    );
  }
  return parsePersistedAudit({
    id: row.id,
    runId: row.run_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    taskId: row.task_id ?? undefined,
    toolCallId: row.tool_call_id ?? undefined,
    toolName: row.tool_name,
    operation: row.operation,
    normalizedPath: row.normalized_path,
    matchedRoot: row.matched_root ?? undefined,
    workspaceScopeId: row.workspace_scope_id ?? undefined,
    grantId: row.grant_id ?? undefined,
    permissionSource: row.permission_source ?? undefined,
    decision: row.decision,
    reason: row.reason,
    crossWorkspace: row.cross_workspace === 1,
    pathRisk: row.path_risk,
    pathRiskTier: row.path_risk_tier,
    createdAt: row.created_at,
  }, row.id);
}
