import { z } from "zod";

export const CleanupRiskSchema = z.enum(["low", "medium", "high"]);

export const CleanupActionTypeSchema = z.enum([
  "delete_file",
  "delete_directory",
  "rewrite_file",
  "compact_jsonl",
  "delete_db_rows",
  "vacuum_db",
]);

export const StorageCategorySchema = z.enum([
  "trace",
  "timeline",
  "sqlite_memory",
  "sqlite_tools",
  "cache",
  "temp",
  "reportCache",
  "notifications",
  "scheduler",
  "routing",
  "vector",
  "lifecycle",
  "other",
]);

export const CLEANUP_RUN_ID_PATTERN = /^cleanup_\d{8}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const CleanupRunIdSchema = z
  .string()
  .regex(CLEANUP_RUN_ID_PATTERN, "cleanupRunId 格式无效");

const nonNegativeInteger = z.number().int().nonnegative();
const lifecyclePath = z.string().trim().min(1).max(4_096);
const lifecycleText = z.string().max(4_096);

export const StorageCategoryUsageSchema = z
  .object({
    name: StorageCategorySchema,
    bytes: nonNegativeInteger,
    files: nonNegativeInteger,
  })
  .strict();

export const LargestFileEntrySchema = z
  .object({
    path: lifecyclePath,
    bytes: nonNegativeInteger,
    category: StorageCategorySchema,
  })
  .strict();

export const StorageUsageResultSchema = z
  .object({
    totalBytes: nonNegativeInteger,
    categories: z.array(StorageCategoryUsageSchema).max(StorageCategorySchema.options.length),
    largestFiles: z.array(LargestFileEntrySchema).max(10),
    generatedAt: nonNegativeInteger,
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.categories.map((item) => item.name)).size !== value.categories.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["categories"],
        message: "storage categories 不得重复",
      });
    }
    const categoryBytes = value.categories.reduce((sum, item) => sum + item.bytes, 0);
    if (categoryBytes !== value.totalBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["totalBytes"],
        message: "totalBytes 必须等于 categories 字节总和",
      });
    }
  });

export const CleanupPreviewRequestSchema = z
  .object({
    scope: z.enum(["safe", "all"]).optional(),
    include: z
      .array(StorageCategorySchema)
      .min(1)
      .max(StorageCategorySchema.options.length)
      .refine((items) => new Set(items).size === items.length, "include 不得重复")
      .optional(),
    olderThanDays: z.number().finite().min(0).max(36_500).nullable().optional(),
    maxRisk: CleanupRiskSchema.optional(),
  })
  .strict();

export const CleanupApplyRequestSchema = z
  .object({
    cleanupRunId: CleanupRunIdSchema,
    confirm: z.literal(true),
  })
  .strict();

export const CleanupActionSchema = z
  .object({
    actionId: z.string().regex(/^action_[0-9a-f]{8}$/i),
    type: CleanupActionTypeSchema,
    path: lifecyclePath,
    reason: lifecycleText,
    bytes: nonNegativeInteger,
    risk: CleanupRiskSchema,
    category: StorageCategorySchema,
    canDelete: z.boolean(),
    blockedReason: lifecycleText.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.canDelete && !value.blockedReason) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["blockedReason"],
        message: "不可执行动作必须说明阻塞原因",
      });
    }
    if (value.canDelete && value.blockedReason) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["blockedReason"],
        message: "可执行动作不得携带阻塞原因",
      });
    }
  });

export const CleanupPreviewResultSchema = z
  .object({
    cleanupRunId: CleanupRunIdSchema,
    mode: z.literal("dry-run"),
    startedAt: nonNegativeInteger,
    expiresAt: nonNegativeInteger,
    summary: z
      .object({
        candidateFiles: nonNegativeInteger,
        candidateDbRows: nonNegativeInteger,
        estimatedBytesToFree: nonNegativeInteger,
      })
      .strict(),
    actions: z.array(CleanupActionSchema),
    warnings: z.array(lifecycleText),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.expiresAt <= value.startedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "expiresAt 必须晚于 startedAt",
      });
    }
    if (new Set(value.actions.map((item) => item.actionId)).size !== value.actions.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actions"],
        message: "actionId 不得重复",
      });
    }
    const deletable = value.actions.filter((item) => item.canDelete);
    const expectedFiles = deletable.filter(
      (item) => item.type === "delete_file" || item.type === "delete_directory",
    ).length;
    const expectedDbRows = deletable
      .filter((item) => item.type === "delete_db_rows")
      .reduce((sum, item) => sum + Math.max(1, Math.round(item.bytes / 384)), 0);
    const expectedBytes = deletable.reduce((sum, item) => sum + item.bytes, 0);
    if (value.summary.candidateFiles !== expectedFiles) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["summary", "candidateFiles"],
        message: "candidateFiles 与可执行文件动作不一致",
      });
    }
    if (value.summary.candidateDbRows !== expectedDbRows) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["summary", "candidateDbRows"],
        message: "candidateDbRows 与可执行数据库动作不一致",
      });
    }
    if (value.summary.estimatedBytesToFree !== expectedBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["summary", "estimatedBytesToFree"],
        message: "estimatedBytesToFree 与可执行动作不一致",
      });
    }
    if (value.warnings.length !== value.actions.filter((item) => !item.canDelete).length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["warnings"],
        message: "warnings 必须覆盖每个阻塞动作",
      });
    }
  });

export const CleanupApplyActionResultSchema = z
  .object({
    actionId: z.string().regex(/^action_[0-9a-f]{8}$/i),
    type: CleanupActionTypeSchema,
    target: lifecyclePath,
    status: z.enum(["success", "skipped", "failed"]),
    bytesFreed: nonNegativeInteger,
    error: lifecycleText.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "success" && value.error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error"],
        message: "成功动作不得携带错误",
      });
    }
    if (value.status !== "success" && !value.error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error"],
        message: "跳过或失败动作必须说明原因",
      });
    }
    if (value.status !== "success" && value.bytesFreed !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bytesFreed"],
        message: "未成功动作不得声明释放空间",
      });
    }
  });

export const CleanupApplyResultSchema = z
  .object({
    cleanupRunId: CleanupRunIdSchema,
    mode: z.literal("apply"),
    startedAt: nonNegativeInteger,
    endedAt: nonNegativeInteger,
    applied: nonNegativeInteger,
    skipped: nonNegativeInteger,
    failed: nonNegativeInteger,
    bytesFreed: nonNegativeInteger,
    actions: z.array(CleanupApplyActionResultSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.actions.map((action) => action.actionId)).size !== value.actions.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actions"],
        message: "actionId 不得重复",
      });
    }
    if (value.endedAt < value.startedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endedAt"],
        message: "endedAt 不得早于 startedAt",
      });
    }
    const counts = { success: 0, skipped: 0, failed: 0 };
    for (const action of value.actions) counts[action.status] += 1;
    if (value.applied !== counts.success) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["applied"], message: "applied 计数不一致" });
    }
    if (value.skipped !== counts.skipped) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["skipped"], message: "skipped 计数不一致" });
    }
    if (value.failed !== counts.failed) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["failed"], message: "failed 计数不一致" });
    }
    const bytesFreed = value.actions.reduce((sum, action) => sum + action.bytesFreed, 0);
    if (value.bytesFreed !== bytesFreed) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bytesFreed"],
        message: "bytesFreed 与动作结果不一致",
      });
    }
  });

export const CleanupJournalEntrySchema = z
  .object({
    cleanupRunId: CleanupRunIdSchema,
    actionId: z.string().regex(/^action_[0-9a-f]{8}$/i),
    type: CleanupActionTypeSchema,
    target: lifecyclePath,
    status: z.enum(["success", "skipped", "failed"]),
    bytesFreed: nonNegativeInteger,
    startedAt: nonNegativeInteger,
    endedAt: nonNegativeInteger,
    error: lifecycleText.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const action = CleanupApplyActionResultSchema.safeParse({
      actionId: value.actionId,
      type: value.type,
      target: value.target,
      status: value.status,
      bytesFreed: value.bytesFreed,
      ...(value.error ? { error: value.error } : {}),
    });
    if (!action.success) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "journal 动作结果无效" });
    }
    if (value.endedAt < value.startedAt) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["endedAt"], message: "endedAt 不得早于 startedAt" });
    }
  });

export const CleanupHistoryResultSchema = z
  .object({
    runs: z.array(CleanupApplyResultSchema),
    count: nonNegativeInteger,
    invalidEntries: nonNegativeInteger,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.count !== value.runs.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["count"], message: "count 必须等于 runs 长度" });
    }
    if (new Set(value.runs.map((run) => run.cleanupRunId)).size !== value.runs.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["runs"], message: "cleanupRunId 不得重复" });
    }
  });

export const StorageNoQuerySchema = z.object({}).strict();

export const StorageCleanupRunsQuerySchema = z
  .object({
    limit: z
      .string()
      .regex(/^[1-9][0-9]*$/, "limit 必须是正整数")
      .transform(Number)
      .pipe(z.number().int().min(1).max(200))
      .optional()
      .transform((value) => value ?? 50),
  })
  .strict();

export const StorageQueryErrorResultSchema = z
  .object({
    error: z.string(),
    code: z.literal("STORAGE_QUERY_INVALID"),
  })
  .strict();

export const StorageRequestErrorResultSchema = z
  .object({
    error: z.string(),
    code: z.literal("invalid_request"),
  })
  .strict();

export const StorageUsageErrorResultSchema = operationError("STORAGE_USAGE_FAILED");
export const StorageCleanupPreviewErrorResultSchema = operationError("STORAGE_CLEANUP_PREVIEW_FAILED");
export const StorageCleanupHistoryErrorResultSchema = operationError("STORAGE_CLEANUP_HISTORY_FAILED");
const CleanupConfirmRequiredResultSchema = operationError("CLEANUP_CONFIRM_REQUIRED");
const CleanupRunIdInvalidResultSchema = operationError("CLEANUP_RUN_ID_INVALID");
export const StorageCleanupPreviewNotFoundResultSchema = operationError("CLEANUP_PREVIEW_NOT_FOUND");
export const StorageCleanupPreviewExpiredResultSchema = operationError("CLEANUP_PREVIEW_EXPIRED");
export const StorageCleanupLockedResultSchema = operationError("CLEANUP_LOCKED");
export const StorageCleanupApplyErrorResultSchema = operationError("STORAGE_CLEANUP_APPLY_FAILED");
export const StorageCleanupApplyFailureResultSchema = z.union([
  CleanupConfirmRequiredResultSchema,
  CleanupRunIdInvalidResultSchema,
  StorageCleanupPreviewNotFoundResultSchema,
  StorageCleanupPreviewExpiredResultSchema,
  StorageCleanupLockedResultSchema,
  StorageCleanupApplyErrorResultSchema,
]);

function operationError<T extends string>(code: T) {
  return z.object({ error: z.string(), code: z.literal(code) }).strict();
}

export type CleanupRisk = z.infer<typeof CleanupRiskSchema>;
export type CleanupActionType = z.infer<typeof CleanupActionTypeSchema>;
export type StorageCategory = z.infer<typeof StorageCategorySchema>;
export type StorageCategoryUsage = z.infer<typeof StorageCategoryUsageSchema>;
export type LargestFileEntry = z.infer<typeof LargestFileEntrySchema>;
export type StorageUsageReport = z.infer<typeof StorageUsageResultSchema>;
export type CleanupPreviewRequest = z.infer<typeof CleanupPreviewRequestSchema>;
export type CleanupApplyRequest = z.infer<typeof CleanupApplyRequestSchema>;
export type CleanupAction = z.infer<typeof CleanupActionSchema>;
export type CleanupPreviewReport = z.infer<typeof CleanupPreviewResultSchema>;
export type CleanupApplyResult = z.infer<typeof CleanupApplyResultSchema>;
export type CleanupJournalEntry = z.infer<typeof CleanupJournalEntrySchema>;
export type CleanupHistoryResult = z.infer<typeof CleanupHistoryResultSchema>;
export type CleanupApplyFailure = z.infer<typeof StorageCleanupApplyFailureResultSchema> & {
  status: 400 | 404 | 409 | 410 | 500;
};
