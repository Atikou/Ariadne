import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { LifecyclePolicy } from "./types.js";

export const DEFAULT_LIFECYCLE_POLICY: LifecyclePolicy = {
  version: 1,
  mode: "local-first",
  cleanup: {
    autoEnabled: true,
    autoIntervalHours: 24,
    requireDryRunBeforeApply: true,
    skipActiveRuns: true,
    lockTimeoutSeconds: 30,
  },
  retentionDays: {
    runRawEventsSuccess: 30,
    runRawEventsFailed: 60,
    traceRawSuccess: 14,
    traceRawFailed: 30,
    toolArgs: 14,
    toolOutput: 7,
    routeDetails: 14,
    readNotifications: 7,
    completedSchedulerJournal: 14,
    reportCache: 3,
    searchCache: 1,
    fileCache: 3,
    temp: 1,
    softDeletedRows: 30,
  },
  quotas: {
    tempBytes: 1_073_741_824,
    cacheBytes: 2_147_483_648,
    reportCacheBytes: 536_870_912,
    traceRawBytes: 10_737_418_240,
    timelineRawBytes: 5_368_709_120,
    maxToolOutputBytes: 262_144,
  },
  trace: {
    rotationMaxBytes: 104_857_600,
    rotationMaxAgeHours: 24,
    compressOldSegments: true,
    compression: "gzip",
    keepIndex: true,
  },
  sqlite: {
    enableVacuum: true,
    vacuumAfterLargeCleanup: true,
    walCheckpointAfterCleanup: true,
  },
  privacy: {
    redactBeforeWrite: true,
    supportSessionPurge: true,
    purgeRewritesJsonlSegments: true,
    deleteActivityRunsOnSessionDelete: true,
  },
};

export function lifecycleDir(dataDir: string): string {
  return path.join(dataDir, "lifecycle");
}

export function policyFilePath(dataDir: string): string {
  return path.join(lifecycleDir(dataDir), "policy.json");
}

export function loadLifecyclePolicy(dataDir: string): LifecyclePolicy {
  const file = policyFilePath(dataDir);
  const dir = lifecycleDir(dataDir);
  mkdirSync(dir, { recursive: true });

  if (!existsSync(file)) {
    writeFileSync(file, `${JSON.stringify(DEFAULT_LIFECYCLE_POLICY, null, 2)}\n`, "utf-8");
    return { ...DEFAULT_LIFECYCLE_POLICY };
  }

  try {
    const raw = JSON.parse(readFileSync(file, "utf-8")) as Partial<LifecyclePolicy>;
    return mergePolicy(DEFAULT_LIFECYCLE_POLICY, raw);
  } catch {
    return { ...DEFAULT_LIFECYCLE_POLICY };
  }
}

function mergePolicy(base: LifecyclePolicy, raw: Partial<LifecyclePolicy>): LifecyclePolicy {
  return {
    ...base,
    ...raw,
    cleanup: { ...base.cleanup, ...raw.cleanup },
    retentionDays: { ...base.retentionDays, ...raw.retentionDays },
    quotas: { ...base.quotas, ...raw.quotas },
    trace: { ...base.trace, ...raw.trace },
    sqlite: { ...base.sqlite, ...raw.sqlite },
    privacy: { ...base.privacy, ...raw.privacy },
  };
}
