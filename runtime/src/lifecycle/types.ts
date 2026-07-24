export type {
  CleanupAction,
  CleanupActionType,
  CleanupApplyRequest,
  CleanupApplyResult,
  CleanupHistoryResult,
  CleanupJournalEntry,
  CleanupPreviewReport,
  CleanupPreviewRequest,
  CleanupRisk,
  LargestFileEntry,
  StorageCategory,
  StorageCategoryUsage,
  StorageUsageReport,
} from "./StorageLifecycleContracts.js";

export interface LifecyclePolicy {
  version: number;
  mode: "local-first";
  cleanup: {
    autoEnabled: boolean;
    autoIntervalHours: number;
    requireDryRunBeforeApply: boolean;
    skipActiveRuns: boolean;
    lockTimeoutSeconds: number;
  };
  /** 保留天数：CleanupPlanner 按类别生成文件/DB/行级裁剪动作。 */
  retentionDays: {
    runRawEventsSuccess: number;
    runRawEventsFailed: number;
    traceRawSuccess: number;
    traceRawFailed: number;
    toolArgs: number;
    toolOutput: number;
    routeDetails: number;
    readNotifications: number;
    completedSchedulerJournal: number;
    reportCache: number;
    searchCache: number;
    fileCache: number;
    temp: number;
    softDeletedRows: number;
  };
  quotas: {
    tempBytes: number;
    cacheBytes: number;
    reportCacheBytes: number;
    traceRawBytes: number;
    timelineRawBytes: number;
    maxToolOutputBytes: number;
  };
  trace: {
    rotationMaxBytes: number;
    rotationMaxAgeHours: number;
    /** 轮转后将旧 segment gzip 为 `.jsonl.gz`（默认 false，opt-in）。 */
    compressOldSegments: boolean;
    compression: "gzip" | "zstd";
    keepIndex: boolean;
  };
  sqlite: {
    enableVacuum: boolean;
    vacuumAfterLargeCleanup: boolean;
    walCheckpointAfterCleanup: boolean;
  };
  privacy: {
    redactBeforeWrite: boolean;
    supportSessionPurge: boolean;
    purgeRewritesJsonlSegments: boolean;
    deleteActivityRunsOnSessionDelete: boolean;
  };
}

export interface TombstoneEntry {
  id: string;
  kind: "session_delete" | "session_purge" | "run_delete";
  sessionId?: string;
  runIds: string[];
  deletedAt: number;
  mode: "normal" | "purge";
}
