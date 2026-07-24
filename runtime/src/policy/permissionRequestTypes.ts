import { z } from "zod";

/** 固定 JSON 权限申请协议（schemaVersion=1）。 */
export const PERMISSION_REQUEST_SCHEMA_VERSION = 1 as const;

const nonEmptyString = z.string().trim().min(1);
const timestamp = z.string().datetime();
const uniqueNonEmptyStrings = z
  .array(nonEmptyString)
  .min(1)
  .superRefine((items, ctx) => {
    if (new Set(items).size === items.length) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "列表项不得重复",
    });
  });

export const PermissionRequestItemTypeSchema = z.enum([
  "read_file",
  "write_file",
  "shell",
  "delete_file",
  "network",
  "dangerous",
]);
export type PermissionRequestItemType = z.infer<typeof PermissionRequestItemTypeSchema>;

export const PermissionRequestStatusSchema = z.enum([
  "pending",
  "approved",
  "denied",
  "expired",
]);
export type PermissionRequestStatus = z.infer<typeof PermissionRequestStatusSchema>;

export const PermissionRequestDecisionSchema = z.enum([
  "allow_once",
  "allow_session",
  "allow_project",
  "allow_workspace",
  "deny",
]);
export type PermissionRequestDecision = z.infer<typeof PermissionRequestDecisionSchema>;

export const PermissionRequestApprovalDecisionSchema = z.enum([
  "allow_once",
  "allow_session",
  "allow_project",
  "allow_workspace",
]);
export type PermissionRequestApprovalDecision = z.infer<
  typeof PermissionRequestApprovalDecisionSchema
>;

export const PermissionRequestPlanVariantSchema = z.enum([
  "plan_only",
  "plan_wait_approval",
  "plan_then_execute",
]);

const permissionRequestItemFields = {
  type: PermissionRequestItemTypeSchema,
  target: nonEmptyString,
  reason: nonEmptyString,
  tool: nonEmptyString.optional(),
  riskTier: z.enum(["low", "medium", "high", "critical"]).optional(),
  workspaceScope: nonEmptyString.optional(),
  grantScope: z.enum(["once", "session", "project", "workspace"]).optional(),
  rootPath: nonEmptyString.optional(),
  operation: z.enum(["read", "write", "shell"]).optional(),
  pathRisk: nonEmptyString.optional(),
  diffPreview: z.string().optional(),
  inputPreview: z.string().optional(),
  auditId: nonEmptyString.optional(),
};

/** 创建输入尚未拥有服务端签发的 item ID。 */
export const PermissionRequestItemInputSchema = z
  .object(permissionRequestItemFields)
  .strict();
export type PermissionRequestItemInput = z.infer<typeof PermissionRequestItemInputSchema>;

/** 持久化和公开响应中的每个权限项都必须拥有不可变 ID。 */
export const PermissionRequestItemSchema = z
  .object({ id: nonEmptyString, ...permissionRequestItemFields })
  .strict();
export type PermissionRequestItem = z.infer<typeof PermissionRequestItemSchema>;

const permissionTargets = z.array(nonEmptyString).min(1);
export const ScopedApprovedPermissionsSchema = z
  .object({
    read_file: permissionTargets.optional(),
    write_file: permissionTargets.optional(),
    shell: permissionTargets.optional(),
    delete_file: permissionTargets.optional(),
    network: permissionTargets.optional(),
    dangerous: permissionTargets.optional(),
  })
  .strict();
export type ScopedApprovedPermissions = z.infer<typeof ScopedApprovedPermissionsSchema>;

export const PermissionRequestCreateInputSchema = z
  .object({
    runId: nonEmptyString,
    sessionId: nonEmptyString.optional(),
    projectId: nonEmptyString.optional(),
    title: nonEmptyString,
    summary: nonEmptyString,
    requiredPermissions: z.array(PermissionRequestItemInputSchema).min(1),
    planMarkdown: z.string().optional(),
    intent: nonEmptyString.optional(),
    executionStage: nonEmptyString.optional(),
    planVariant: PermissionRequestPlanVariantSchema.optional(),
    blockedTool: z
      .object({
        name: nonEmptyString,
        input: z.record(z.unknown()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PermissionRequestCreateInput = z.infer<
  typeof PermissionRequestCreateInputSchema
>;

const permissionRequestPayloadObjectSchema = z
  .object({
    schemaVersion: z.literal(PERMISSION_REQUEST_SCHEMA_VERSION),
    id: nonEmptyString,
    runId: nonEmptyString,
    sessionId: nonEmptyString.optional(),
    projectId: nonEmptyString.optional(),
    status: PermissionRequestStatusSchema,
    title: nonEmptyString,
    summary: nonEmptyString,
    planMarkdown: z.string().optional(),
    intent: nonEmptyString.optional(),
    executionStage: nonEmptyString.optional(),
    planVariant: PermissionRequestPlanVariantSchema.optional(),
    requiredPermissions: z.array(PermissionRequestItemSchema).min(1),
    blockedTool: z
      .object({
        name: nonEmptyString,
        input: z.record(z.unknown()).optional(),
      })
      .strict()
      .optional(),
    createdAt: timestamp,
    respondedAt: timestamp.optional(),
    decision: PermissionRequestDecisionSchema.optional(),
    approvalVersion: nonEmptyString,
    approvedItemIds: uniqueNonEmptyStrings.optional(),
    approvedPermissions: ScopedApprovedPermissionsSchema.optional(),
    consumedAt: timestamp.optional(),
  })
  .strict();

export const PermissionRequestPayloadSchema = permissionRequestPayloadObjectSchema.superRefine(
  (payload, ctx) => {
    const requiredIds = payload.requiredPermissions.map((item) => item.id);
    if (new Set(requiredIds).size !== requiredIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "requiredPermissions item ID 不得重复",
        path: ["requiredPermissions"],
      });
    }

    if (payload.status === "pending") {
      rejectStateFields(payload, ctx, [
        "respondedAt",
        "decision",
        "approvedItemIds",
        "approvedPermissions",
        "consumedAt",
      ]);
      return;
    }

    if (payload.status === "approved") {
      requireStateField(payload.respondedAt, ctx, "respondedAt");
      if (!payload.decision || payload.decision === "deny") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "approved 申请必须携带允许决定",
          path: ["decision"],
        });
      }
      if (!payload.approvedItemIds) {
        requireStateField(payload.approvedItemIds, ctx, "approvedItemIds");
      } else {
        const allowed = new Set(requiredIds);
        for (const itemId of payload.approvedItemIds) {
          if (allowed.has(itemId)) continue;
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "approvedItemIds 必须属于原申请",
            path: ["approvedItemIds"],
          });
          break;
        }
      }
      requireStateField(payload.approvedPermissions, ctx, "approvedPermissions");
      if (payload.decision === "allow_session" && !payload.sessionId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "allow_session 必须绑定 sessionId",
          path: ["sessionId"],
        });
      }
      if (payload.decision === "allow_project" && !payload.projectId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "allow_project 必须绑定 projectId",
          path: ["projectId"],
        });
      }
      if (
        payload.decision === "allow_workspace"
        && payload.requiredPermissions.some((item) => item.type === "shell")
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "shell 权限不能长期授权到 workspace",
          path: ["decision"],
        });
      }
      assertApprovedProjection(payload, ctx);
      return;
    }

    if (payload.status === "denied") {
      requireStateField(payload.respondedAt, ctx, "respondedAt");
      if (payload.decision !== "deny") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "denied 申请必须携带 deny 决定",
          path: ["decision"],
        });
      }
      rejectStateFields(payload, ctx, [
        "approvedItemIds",
        "approvedPermissions",
        "consumedAt",
      ]);
      return;
    }

    rejectStateFields(payload, ctx, [
      "decision",
      "approvedItemIds",
      "approvedPermissions",
      "consumedAt",
    ]);
  },
);
export type PermissionRequestPayload = z.infer<typeof PermissionRequestPayloadSchema>;

export const PermissionRequestPendingPayloadSchema = PermissionRequestPayloadSchema.refine(
  (payload) => payload.status === "pending",
  { message: "权限申请必须处于 pending", path: ["status"] },
);

export const PermissionRequestApprovedPayloadSchema = PermissionRequestPayloadSchema.refine(
  (payload) => payload.status === "approved",
  { message: "权限申请必须处于 approved", path: ["status"] },
);

export const PermissionRequestDeniedPayloadSchema = PermissionRequestPayloadSchema.refine(
  (payload) => payload.status === "denied",
  { message: "权限申请必须处于 denied", path: ["status"] },
);

function permissionApprovalInputSchema<T extends PermissionRequestApprovalDecision>(
  decision: T,
) {
  return z
    .object({
      decision: z.literal(decision),
      approvalVersion: nonEmptyString,
      approvedItemIds: uniqueNonEmptyStrings,
    })
    .strict();
}

export const PermissionRequestRespondInputSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("deny"),
      approvalVersion: nonEmptyString,
    })
    .strict(),
  permissionApprovalInputSchema("allow_once"),
  permissionApprovalInputSchema("allow_session"),
  permissionApprovalInputSchema("allow_project"),
  permissionApprovalInputSchema("allow_workspace"),
]);
export type PermissionRequestRespondInput = z.infer<
  typeof PermissionRequestRespondInputSchema
>;

export const PermissionRequestListFilterSchema = z
  .object({
    sessionId: nonEmptyString.optional(),
    runId: nonEmptyString.optional(),
  })
  .strict();
export type PermissionRequestListFilter = z.infer<
  typeof PermissionRequestListFilterSchema
>;

export function toScopedApprovedPermissions(
  items: readonly PermissionRequestItem[] | undefined,
): ScopedApprovedPermissions {
  const scoped: ScopedApprovedPermissions = {};
  for (const item of items ?? []) {
    const bucket = item.type;
    if (!scoped[bucket]) scoped[bucket] = [];
    scoped[bucket]!.push(item.target);
  }
  return scoped;
}

export function approvedPermissionItems(
  payload: PermissionRequestPayload,
): PermissionRequestItem[] {
  if (!payload.approvedItemIds?.length) return [];
  const approved = new Set(payload.approvedItemIds);
  return payload.requiredPermissions.filter((item) => approved.has(item.id));
}

function assertApprovedProjection(
  payload: z.infer<typeof permissionRequestPayloadObjectSchema>,
  ctx: z.RefinementCtx,
): void {
  if (!payload.approvedItemIds || !payload.approvedPermissions) return;
  const approved = new Set(payload.approvedItemIds);
  const expected = toScopedApprovedPermissions(
    payload.requiredPermissions.filter((item) => approved.has(item.id)),
  );
  for (const type of PermissionRequestItemTypeSchema.options) {
    const actualTargets = payload.approvedPermissions[type] ?? [];
    const expectedTargets = expected[type] ?? [];
    if (
      actualTargets.length === expectedTargets.length
      && actualTargets.every((target, index) => target === expectedTargets[index])
    ) {
      continue;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "approvedPermissions 必须由 approvedItemIds 精确投影",
      path: ["approvedPermissions", type],
    });
  }
}

function rejectStateFields(
  payload: z.infer<typeof permissionRequestPayloadObjectSchema>,
  ctx: z.RefinementCtx,
  fields: Array<keyof z.infer<typeof permissionRequestPayloadObjectSchema>>,
): void {
  for (const field of fields) {
    if (payload[field] === undefined) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${payload.status} 申请不得携带 ${field}`,
      path: [field],
    });
  }
}

function requireStateField(
  value: unknown,
  ctx: z.RefinementCtx,
  field: string,
): void {
  if (value !== undefined) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: `状态字段 ${field} 不能为空`,
    path: [field],
  });
}

export function normalizePermissionTarget(target: string): string {
  return target.replace(/\\/g, "/").trim();
}
