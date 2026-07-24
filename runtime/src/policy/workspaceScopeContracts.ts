import path from "node:path";

import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);
export const WorkspaceScopeIdentifierSchema = nonEmptyString.max(512);
const boundedId = WorkspaceScopeIdentifierSchema;
const pathString = nonEmptyString.max(32_768);
export const WorkspaceAbsolutePathSchema = pathString.refine((value) => path.isAbsolute(value), {
  message: "持久授权路径必须是绝对路径",
});
const absolutePathString = WorkspaceAbsolutePathSchema;
const timestamp = z.string().datetime({ offset: true });
const futureTimestamp = timestamp.refine((value) => Date.parse(value) > Date.now(), {
  message: "expiresAt 必须晚于当前时间",
});
const auditLimitQuery = z
  .string()
  .regex(/^[1-9]\d*$/, "limit 必须是正整数")
  .transform(Number)
  .pipe(z.number().finite().int().min(1).max(500));

export const WorkspaceScopePermissionSchema = z.enum(["read", "write", "shell"]);
export type WorkspaceScopePermission = z.infer<typeof WorkspaceScopePermissionSchema>;

export const WorkspaceGrantScopeSchema = z.enum(["session", "project", "workspace"]);
export type WorkspaceGrantScope = z.infer<typeof WorkspaceGrantScopeSchema>;

export const WorkspaceScopeGrantScopeSchema = z.enum([
  "once",
  "session",
  "project",
  "workspace",
]);
export type WorkspaceScopeGrantScope = z.infer<typeof WorkspaceScopeGrantScopeSchema>;

export const WorkspaceScopeKindSchema = z.enum([
  "primary",
  "granted",
  "config",
  "temporary",
]);
export type WorkspaceScopeKind = z.infer<typeof WorkspaceScopeKindSchema>;

export const WorkspaceGrantSourceSchema = z.enum(["user_confirmed", "config"]);
export type WorkspaceGrantSource = z.infer<typeof WorkspaceGrantSourceSchema>;

export const WorkspaceScopeSourceSchema = z.union([
  z.literal("primary"),
  WorkspaceGrantSourceSchema,
]);
export type WorkspaceScopeSource = z.infer<typeof WorkspaceScopeSourceSchema>;

export const WorkspaceScopePermissionsSchema = z
  .array(WorkspaceScopePermissionSchema)
  .min(1)
  .superRefine((permissions, ctx) => {
    if (new Set(permissions).size === permissions.length) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "permissions 不得重复",
    });
  });

const createCommon = {
  rootPath: pathString,
  permissions: WorkspaceScopePermissionsSchema,
  expiresAt: futureTimestamp.optional(),
};

export const WorkspaceScopeCreateRequestSchema = z.discriminatedUnion("scope", [
  z.object({
    ...createCommon,
    scope: z.literal("session"),
    sessionId: boundedId,
  }).strict(),
  z.object({
    ...createCommon,
    scope: z.literal("project"),
    projectId: boundedId,
  }).strict(),
  z.object({
    ...createCommon,
    scope: z.literal("workspace"),
  }).strict(),
]);
export type WorkspaceScopeCreateRequest = z.infer<typeof WorkspaceScopeCreateRequestSchema>;

export const WorkspaceGrantBindingSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("session"), sessionId: boundedId }).strict(),
  z.object({ scope: z.literal("project"), projectId: boundedId }).strict(),
  z.object({ scope: z.literal("workspace") }).strict(),
]);
export type WorkspaceGrantBinding = z.infer<typeof WorkspaceGrantBindingSchema>;

export const WorkspaceScopeUpdateRequestSchema = z
  .object({
    permissions: WorkspaceScopePermissionsSchema.optional(),
    expiresAt: futureTimestamp.nullable().optional(),
    binding: WorkspaceGrantBindingSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.permissions !== undefined || value.expiresAt !== undefined || value.binding) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "至少提供 permissions、expiresAt 或 binding 之一",
    });
  });
export type WorkspaceScopeUpdateRequest = z.infer<typeof WorkspaceScopeUpdateRequestSchema>;

export const WorkspaceScopeDeleteRequestSchema = z
  .object({ reason: nonEmptyString.max(500).optional() })
  .strict();
export type WorkspaceScopeDeleteRequest = z.infer<typeof WorkspaceScopeDeleteRequestSchema>;

const grantInputCommon = {
  id: boundedId.optional(),
  taskId: boundedId.optional(),
  rootPath: absolutePathString,
  permissions: WorkspaceScopePermissionsSchema,
  expiresAt: timestamp.optional(),
  source: WorkspaceGrantSourceSchema.optional(),
};

export const WorkspaceGrantInputSchema = z.discriminatedUnion("scope", [
  z.object({
    ...grantInputCommon,
    scope: z.literal("session"),
    sessionId: boundedId,
  }).strict(),
  z.object({
    ...grantInputCommon,
    scope: z.literal("project"),
    projectId: boundedId,
  }).strict(),
  z.object({
    ...grantInputCommon,
    scope: z.literal("workspace"),
  }).strict(),
]);
export type WorkspaceGrantInput = z.infer<typeof WorkspaceGrantInputSchema>;

export const WorkspaceGrantSchema = z
  .object({
    id: boundedId,
    sessionId: boundedId.optional(),
    projectId: boundedId.optional(),
    taskId: boundedId.optional(),
    rootPath: absolutePathString,
    permissions: WorkspaceScopePermissionsSchema,
    scope: WorkspaceGrantScopeSchema,
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: timestamp.optional(),
    revokedAt: timestamp.optional(),
    revokedReason: nonEmptyString.max(500).optional(),
    source: WorkspaceGrantSourceSchema,
  })
  .strict()
  .superRefine((grant, ctx) => {
    if (grant.scope === "session" && !grant.sessionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "session grant 必须绑定 sessionId",
        path: ["sessionId"],
      });
    }
    if (grant.scope !== "session" && grant.sessionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${grant.scope} grant 不得携带 sessionId`,
        path: ["sessionId"],
      });
    }
    if (grant.scope === "project" && !grant.projectId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "project grant 必须绑定 projectId",
        path: ["projectId"],
      });
    }
    if (grant.scope !== "project" && grant.projectId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${grant.scope} grant 不得携带 projectId`,
        path: ["projectId"],
      });
    }
    if (Boolean(grant.revokedAt) !== Boolean(grant.revokedReason)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "revokedAt 与 revokedReason 必须同时存在或同时缺失",
        path: ["revokedAt"],
      });
    }
  });
export type WorkspaceGrant = z.infer<typeof WorkspaceGrantSchema>;

export const WorkspaceGrantFilterSchema = z
  .object({
    sessionId: boundedId.optional(),
    projectId: boundedId.optional(),
    includeExpired: z.boolean().optional(),
    includeRevoked: z.boolean().optional(),
  })
  .strict();
export type WorkspaceGrantFilter = z.infer<typeof WorkspaceGrantFilterSchema>;

export const WorkspaceScopeListQuerySchema = z
  .object({
    sessionId: boundedId.optional(),
    projectId: boundedId.optional(),
  })
  .strict();
export type WorkspaceScopeListQuery = z.infer<typeof WorkspaceScopeListQuerySchema>;

export const WorkspaceScopeAuditQuerySchema = z
  .object({
    sessionId: boundedId.optional(),
    runId: boundedId.optional(),
    limit: auditLimitQuery.optional(),
  })
  .strict();
export type WorkspaceScopeAuditQuery = z.infer<typeof WorkspaceScopeAuditQuerySchema>;

export const WorkspaceAccessAuditFilterSchema = z
  .object({
    sessionId: boundedId.optional(),
    runId: boundedId.optional(),
    limit: z.number().finite().int().min(1).max(500).optional(),
  })
  .strict();
export type WorkspaceAccessAuditFilter = z.infer<typeof WorkspaceAccessAuditFilterSchema>;

export const WorkspaceAccessDecisionSchema = z.enum([
  "allowed",
  "needs_confirmation",
  "denied",
]);

export const WorkspacePathRiskSchema = z.enum([
  "normal",
  "sensitive_file",
  "dangerous_path",
]);

export const WorkspacePathRiskTierSchema = z.enum([
  "low",
  "medium",
  "high",
  "critical",
]);

export const WorkspaceAccessAuditInputSchema = z
  .object({
    runId: boundedId.optional(),
    sessionId: boundedId.optional(),
    taskId: boundedId.optional(),
    toolCallId: boundedId.optional(),
    toolName: nonEmptyString.max(512),
    operation: WorkspaceScopePermissionSchema,
    normalizedPath: absolutePathString,
    matchedRoot: absolutePathString.optional(),
    workspaceScopeId: pathString.optional(),
    grantId: pathString.optional(),
    permissionSource: WorkspaceScopeSourceSchema.optional(),
    decision: WorkspaceAccessDecisionSchema,
    reason: nonEmptyString.max(2_048),
    crossWorkspace: z.boolean(),
    pathRisk: WorkspacePathRiskSchema,
    pathRiskTier: WorkspacePathRiskTierSchema,
  })
  .strict();
export type WorkspaceAccessAuditInput = z.infer<typeof WorkspaceAccessAuditInputSchema>;

export const WorkspaceAccessAuditRecordSchema = WorkspaceAccessAuditInputSchema.extend({
  id: boundedId,
  createdAt: timestamp,
}).strict();
export type WorkspaceAccessAuditRecord = z.infer<typeof WorkspaceAccessAuditRecordSchema>;

export const WorkspaceScopeSchema = z
  .object({
    id: boundedId,
    rootPath: absolutePathString,
    label: nonEmptyString.optional(),
    kind: WorkspaceScopeKindSchema,
    permissions: WorkspaceScopePermissionsSchema,
    grantScope: WorkspaceScopeGrantScopeSchema,
    expiresAt: timestamp.optional(),
    grantId: boundedId.optional(),
    source: WorkspaceScopeSourceSchema,
    grantVersion: nonEmptyString.optional(),
  })
  .strict();
export type WorkspaceScope = z.infer<typeof WorkspaceScopeSchema>;

export const WorkspaceGrantRevokeReasonSchema = nonEmptyString.max(500);
