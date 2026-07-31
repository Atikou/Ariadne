import fs from "node:fs";
import path from "node:path";

import type { PermissionConfirmationRequest } from "./PermissionGuard.js";
import { classifyPathRisk, type PathRisk } from "./PathRiskClassifier.js";
import {
  isInsideScope,
  WorkspaceScopeManager,
  canonicalizeExistingPath,
  type WorkspaceGrantStore,
  type WorkspaceScope,
  type WorkspaceScopePermission,
} from "./WorkspaceScopeManager.js";
import type { ScopedApprovedPermissions } from "./permissionRequestTypes.js";

export type PathAccessReason =
  | "inside_primary_workspace"
  | "inside_granted_workspace"
  | "outside_workspace"
  | "permission_missing"
  | "dangerous_path"
  | "sensitive_file"
  | "multiple_workspace_roots";

export interface PathAccessRequest {
  path: string;
  operation: WorkspaceScopePermission;
  sessionId?: string;
  projectId?: string;
  taskId?: string;
  toolName: string;
  permissionPolicy?: string;
  scopedGrants?: ScopedApprovedPermissions;
}

export interface PathAccessDecision {
  allowed: boolean;
  needsConfirmation: boolean;
  reason: PathAccessReason;
  requiredPermission: WorkspaceScopePermission;
  matchedScope?: WorkspaceScope;
  normalizedPath: string;
  realPath?: string;
  requestRoot?: string;
  requestTarget?: string;
  pathRisk: PathRisk;
  crossWorkspace: boolean;
  permissionSource?: WorkspaceScope["source"];
}

export interface ToolPathPreparation {
  decision: PathAccessDecision;
  decisions: PathAccessDecision[];
  workspaceRoot: string;
  input: Record<string, unknown>;
  audit: WorkspaceAccessAudit;
  audits: WorkspaceAccessAudit[];
  grantVersionKey?: string;
}

export interface WorkspaceAccessAudit {
  workspaceScopeId?: string;
  matchedRoot?: string;
  crossWorkspace: boolean;
  grantId?: string;
  permissionSource?: WorkspaceScope["source"];
  pathRisk: PathRisk["kind"];
  pathRiskTier: PathRisk["tier"];
  normalizedPath: string;
  operation: WorkspaceScopePermission;
  grantVersion?: string;
}

export interface PathPolicyOptions {
  primaryRoot: string;
  grants?: WorkspaceGrantStore;
  configScopes?: Array<{
    id: string;
    rootPath: string;
    label?: string;
    permissions?: WorkspaceScopePermission[];
  }>;
}

interface PathSpec {
  field: string;
  path: string;
  operation: WorkspaceScopePermission;
  arrayIndex?: number;
}

export class PathPolicy {
  private readonly primaryRoot: string;
  private readonly scopeManager: WorkspaceScopeManager;

  constructor(primaryRootOrOptions: string | PathPolicyOptions, scopeManager?: WorkspaceScopeManager) {
    if (typeof primaryRootOrOptions === "string") {
      this.primaryRoot = canonicalizeExistingPath(primaryRootOrOptions);
      this.scopeManager = scopeManager ?? new WorkspaceScopeManager({ primaryRoot: this.primaryRoot });
    } else {
      this.primaryRoot = canonicalizeExistingPath(primaryRootOrOptions.primaryRoot);
      this.scopeManager =
        scopeManager ??
        new WorkspaceScopeManager({
          primaryRoot: this.primaryRoot,
          grants: primaryRootOrOptions.grants,
          configScopes: primaryRootOrOptions.configScopes,
        });
    }
  }

  evaluate(request: PathAccessRequest): PathAccessDecision {
    const normalizedPath = normalizePathForAccess(this.primaryRoot, request.path);
    const realPath = resolveRealPathForAccess(normalizedPath);
    const pathRisk = classifyPathRisk(realPath ?? normalizedPath);
    const crossWorkspace = !isInsideScope(this.primaryRoot, realPath ?? normalizedPath);

    if (pathRisk.kind === "dangerous_path" && crossWorkspace) {
      return {
        allowed: false,
        needsConfirmation: false,
        reason: "dangerous_path",
        requiredPermission: request.operation,
        normalizedPath,
        realPath,
        pathRisk,
        crossWorkspace,
      };
    }

    const matchedScope = this.scopeManager.resolveScopeForPath(realPath ?? normalizedPath, request.operation, {
      sessionId: request.sessionId,
      projectId: request.projectId,
      scopedGrants: request.scopedGrants,
    });
    if (matchedScope) {
      return {
        allowed: true,
        needsConfirmation: false,
        reason: matchedScope.kind === "primary" ? "inside_primary_workspace" : "inside_granted_workspace",
        requiredPermission: request.operation,
        matchedScope,
        normalizedPath,
        realPath,
        pathRisk,
        crossWorkspace,
        permissionSource: matchedScope.source,
      };
    }

    const requestRoot = suggestGrantRoot(normalizedPath, request.operation, request.toolName);
    // 保留 Windows 盘根目录末尾的分隔符，避免把 D:\ 错写成具有
    // “D 盘当前目录”语义的 D:/**。解析端仍会兼容历史记录中的 D:/**。
    const requestTarget = `${requestRoot}${/[\\/]$/.test(requestRoot) ? "" : path.sep}**`;
    return {
      allowed: false,
      needsConfirmation: true,
      reason: crossWorkspace ? "outside_workspace" : "permission_missing",
      requiredPermission: request.operation,
      normalizedPath,
      realPath,
      requestRoot,
      requestTarget,
      pathRisk,
      crossWorkspace,
    };
  }

  prepareTool(
    toolName: string,
    input: Record<string, unknown>,
    opts?: {
      sessionId?: string;
      projectId?: string;
      taskId?: string;
      scopedGrants?: ScopedApprovedPermissions;
    },
  ): ToolPathPreparation | undefined {
    const specs = pathSpecsForTool(toolName, input);
    if (specs.length === 0) return undefined;

    const decisions = specs.map((spec) =>
      this.evaluate({
        path: spec.path,
        operation: spec.operation,
        sessionId: opts?.sessionId,
        projectId: opts?.projectId,
        taskId: opts?.taskId,
        toolName,
        scopedGrants: opts?.scopedGrants,
      }),
    );
    const denied = decisions.find((d) => !d.allowed && !d.needsConfirmation);
    const missing = decisions.find((d) => !d.allowed && d.needsConfirmation);
    const decision = denied ?? missing ?? incompatibleMultiRootDecision(decisions) ?? pickRepresentativeDecision(decisions);
    const audits = decisions.map(buildAudit);
    const audit = buildAudit(decision);

    if (!decision.allowed) {
      return {
        decision,
        decisions,
        workspaceRoot: this.primaryRoot,
        input: { ...input },
        audit,
        audits,
        grantVersionKey: grantVersionKey(audits),
      };
    }

    const executionRoot = resolveExecutionRoot(this.primaryRoot, specs, decisions);
    const preparedInput = prepareInputForScope(input, specs, decisions, executionRoot);
    return {
      decision,
      decisions,
      workspaceRoot: executionRoot,
      input: preparedInput,
      audit,
      audits,
      grantVersionKey: grantVersionKey(audits),
    };
  }
}

export function buildPathConfirmationRequest(input: {
  toolName: string;
  decision: PathAccessDecision;
  intent: import("../agent/IntentTypes.js").AgentIntentType;
  permissionPolicy: import("../agent/RunPolicyTypes.js").UserPermissionPolicy;
}): PermissionConfirmationRequest {
  const target = input.decision.requestTarget ?? input.decision.normalizedPath;
  const operationLabel =
    input.decision.requiredPermission === "read"
      ? "读取"
      : input.decision.requiredPermission === "write"
        ? "写入"
        : "执行 Shell";
  const riskReasons = [
    input.decision.crossWorkspace ? "cross_workspace" : undefined,
    ...input.decision.pathRisk.reasons,
  ].filter((item): item is string => Boolean(item));
  return {
    status: "waiting_confirmation",
    title: "等待确认跨工作区访问",
    message: `Agent 想${operationLabel}工作区外路径：${input.decision.normalizedPath}`,
    tool: input.toolName,
    permission: input.decision.requiredPermission === "read" ? "read" : input.decision.requiredPermission,
    intent: input.intent,
    permissionPolicy: input.permissionPolicy,
    action: `${operationLabel}外部工作区`,
    affects: {
      files: input.decision.requiredPermission === "shell" ? [] : [target],
      commands: input.decision.requiredPermission === "shell" ? [target] : [],
      networkTargets: [],
    },
    risk: {
      tier: input.decision.pathRisk.tier === "critical" ? "critical" : "high",
      category: input.decision.requiredPermission === "shell" ? "shell_command" : "permission_boundary",
      summary: "跨工作区访问需要用户显式授权",
      reasons: riskReasons.length ? riskReasons : ["cross_workspace"],
    },
  };
}

function pathSpecsForTool(toolName: string, input: Record<string, unknown>): PathSpec[] {
  const specs: PathSpec[] = [];
  const readPath = (field: string): string | undefined => {
    const value = input[field];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const add = (field: string, operation: WorkspaceScopePermission, value?: string, arrayIndex?: number) => {
    if (value?.trim()) specs.push({ field, path: value.trim(), operation, arrayIndex });
  };
  const addArray = (field: string, operation: WorkspaceScopePermission) => {
    const values = input[field];
    if (!Array.isArray(values)) return;
    values.forEach((value, arrayIndex) => {
      if (typeof value === "string" && value.trim()) add(field, operation, value, arrayIndex);
    });
  };

  switch (toolName) {
    case "read_file":
    case "diff_file":
      add("path", "read", readPath("path"));
      break;
    case "list_files":
      add("root", "read", readPath("root") ?? ".");
      break;
    case "search_text":
      add(readPath("dir") ? "dir" : "root", "read", readPath("dir") ?? readPath("root") ?? ".");
      break;
    case "project_scan":
    case "project_index_update":
    case "symbol_search":
      add("root", toolName === "project_index_update" ? "write" : "read", readPath("root") ?? ".");
      if (toolName === "project_index_update") addArray("paths", "write");
      break;
    case "locate_relevant_files":
      add("root", "read", ".");
      break;
    case "context_pack":
      addArray("files", "read");
      break;
    case "write_file":
    case "apply_patch":
      add("path", "write", readPath("path"));
      break;
    case "backup_file":
      addArray("paths", "write");
      break;
    case "rollback_change":
      add("path", "write", readPath("path"));
      break;
    case "shell_run":
    case "background_shell_start":
    case "git_status":
      add("cwd", "shell", readPath("cwd") ?? ".");
      break;
    case "git_diff":
      add("cwd", "shell", readPath("cwd") ?? ".");
      add("path", "read", readPath("path"));
      break;
  }
  return specs;
}

function normalizePathForAccess(primaryRoot: string, target: string): string {
  const workspaceRelativeAlias = windowsWorkspaceRelativeAlias(primaryRoot, target);
  if (workspaceRelativeAlias) return path.resolve(primaryRoot, workspaceRelativeAlias);
  return path.isAbsolute(target) ? path.resolve(target) : path.resolve(primaryRoot, target);
}

function windowsWorkspaceRelativeAlias(primaryRoot: string, target: string): string | undefined {
  if (!isWindowsRootPath(primaryRoot)) return undefined;
  const normalized = target.trim().replace(/\\/g, "/");
  if (!/^\/(?!\/)/.test(normalized)) return undefined;
  const relative = normalized.replace(/^\/+/, "");
  if (!relative || /^[A-Za-z]:\//.test(relative)) return undefined;
  return relative;
}

function isWindowsRootPath(rootPath: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path.resolve(rootPath)) || /^\\\\/.test(path.resolve(rootPath));
}

function resolveRealPathForAccess(targetPath: string): string | undefined {
  let current = path.resolve(targetPath);
  const missingSegments: string[] = [];
  while (true) {
    try {
      const real = fs.realpathSync.native(current);
      return missingSegments.length ? path.join(real, ...missingSegments.reverse()) : real;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      missingSegments.push(path.basename(current));
      current = parent;
    }
  }
}

function suggestGrantRoot(fullPath: string, operation: WorkspaceScopePermission, toolName: string): string {
  if (operation === "shell" || toolName === "list_files" || toolName === "search_text" || toolName === "project_scan") {
    return existingDirectoryOrSelf(fullPath);
  }
  return existingDirectoryOrSelf(path.dirname(fullPath));
}

function existingDirectoryOrSelf(candidate: string): string {
  let current = path.resolve(candidate);
  while (true) {
    try {
      const stat = fs.statSync(current);
      if (stat.isDirectory()) return current;
      return path.dirname(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(candidate);
      current = parent;
    }
  }
}

function buildAudit(decision: PathAccessDecision): WorkspaceAccessAudit {
  return {
    workspaceScopeId: decision.matchedScope?.id,
    matchedRoot: decision.matchedScope?.rootPath,
    crossWorkspace: decision.crossWorkspace,
    grantId: decision.matchedScope?.grantId,
    permissionSource: decision.permissionSource,
    pathRisk: decision.pathRisk.kind,
    pathRiskTier: decision.pathRisk.tier,
    normalizedPath: decision.normalizedPath,
    operation: decision.requiredPermission,
    grantVersion: decision.matchedScope?.grantVersion,
  };
}

function pickRepresentativeDecision(decisions: PathAccessDecision[]): PathAccessDecision {
  return (
    decisions.find((d) => d.crossWorkspace) ??
    decisions.find((d) => d.pathRisk.kind !== "normal") ??
    decisions[0]!
  );
}

function incompatibleMultiRootDecision(decisions: PathAccessDecision[]): PathAccessDecision | undefined {
  if (!decisions.every((d) => d.allowed)) return undefined;
  const roots = new Set(decisions.map((d) => d.matchedScope?.rootPath).filter((root): root is string => Boolean(root)));
  if (roots.size <= 1) return undefined;
  const representative = pickRepresentativeDecision(decisions);
  return {
    ...representative,
    allowed: false,
    needsConfirmation: false,
    reason: "multiple_workspace_roots",
  };
}

function sharedMatchedRoot(decisions: PathAccessDecision[]): string | undefined {
  const roots = [...new Set(decisions.map((d) => d.matchedScope?.rootPath).filter((root): root is string => Boolean(root)))];
  return roots.length === 1 ? roots[0] : undefined;
}

function resolveExecutionRoot(
  primaryRoot: string,
  specs: PathSpec[],
  decisions: PathAccessDecision[],
): string {
  const targets = decisions.map((decision) => decision.realPath ?? decision.normalizedPath);
  if (targets.every((target) => isInsideScope(primaryRoot, target))) return primaryRoot;

  const matchedRoot = sharedMatchedRoot(decisions) ?? primaryRoot;
  try {
    if (fs.statSync(matchedRoot).isDirectory()) return matchedRoot;
    return path.dirname(matchedRoot);
  } catch {
    const exactFileScope = decisions.every((decision, index) => {
      const target = decision.realPath ?? decision.normalizedPath;
      const spec = specs[index];
      return Boolean(spec)
        && !isDirectoryPathField(spec!.field)
        && canonicalizeExistingPath(target) === canonicalizeExistingPath(matchedRoot);
    });
    return exactFileScope ? path.dirname(matchedRoot) : matchedRoot;
  }
}

function isDirectoryPathField(field: string): boolean {
  return field === "root" || field === "dir" || field === "cwd";
}

function prepareInputForScope(
  input: Record<string, unknown>,
  specs: PathSpec[],
  decisions: PathAccessDecision[],
  matchedRoot: string,
): Record<string, unknown> {
  const prepared = { ...input };
  specs.forEach((spec, index) => {
    const decision = decisions[index];
    if (!decision?.allowed || !decision.matchedScope) return;
    // Use the canonical/real target when available. On Windows the model may
    // supply an 8.3 alias (ADMINI~1) while the matched scope is canonicalized
    // to the long path (Administrator). Relativizing those two spellings
    // directly produces a false ../../ traversal that the tool sandbox rejects
    // after the user has already approved the exact operation.
    const preparedTarget = decision.realPath ?? decision.normalizedPath;
    const rel = path.relative(matchedRoot, preparedTarget).replace(/\\/g, "/") || ".";
    if (spec.arrayIndex != null) {
      const values = Array.isArray(prepared[spec.field]) ? [...(prepared[spec.field] as unknown[])] : [];
      values[spec.arrayIndex] = rel;
      prepared[spec.field] = values;
    } else {
      prepared[spec.field] = rel;
    }
  });
  return prepared;
}

function grantVersionKey(audits: WorkspaceAccessAudit[]): string | undefined {
  const parts = audits
    .map((a) => `${a.workspaceScopeId ?? "none"}:${a.grantVersion ?? "none"}:${a.matchedRoot ?? ""}`)
    .filter(Boolean);
  return parts.length ? [...new Set(parts)].join("|") : undefined;
}
