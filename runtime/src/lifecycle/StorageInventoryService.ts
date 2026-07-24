import path from "node:path";

import { dirTotalBytes, fileSizeIfExists, walkFiles } from "./fsUtils.js";
import type { LargestFileEntry, StorageCategory, StorageCategoryUsage, StorageUsageReport } from "./types.js";

export interface StorageInventoryPaths {
  dataDir: string;
  workspaceRoot: string;
  traceFile: string;
  notificationFile: string;
  schedulerJournalFile: string;
  memoryDbPath: string;
  toolsDbPath?: string;
}

export class StorageInventoryService {
  constructor(private readonly paths: StorageInventoryPaths) {}

  scan(): StorageUsageReport {
    const categories = new Map<StorageCategory, StorageCategoryUsage>();
    const bump = (name: StorageCategory, bytes: number, files: number): void => {
      const existing = categories.get(name) ?? { name, bytes: 0, files: 0 };
      existing.bytes += bytes;
      existing.files += files;
      categories.set(name, existing);
    };

    const tempDir = path.join(this.paths.dataDir, "temp");
    const cacheDir = path.join(this.paths.dataDir, "cache");
    const reportCacheDir = path.join(this.paths.dataDir, "reports", "cache");
    const tracesDir = path.join(this.paths.dataDir, "traces");
    const timelineDir = path.join(this.paths.workspaceRoot, ".agent", "runs");
    const dataRunsDir = path.join(this.paths.dataDir, "runs");
    const lifecycleMetaDir = path.join(this.paths.dataDir, "lifecycle");
    const vectorsDir = path.join(this.paths.dataDir, "vectors");

    for (const f of walkFiles(tempDir)) bump("temp", f.size, 1);
    for (const f of walkFiles(cacheDir)) bump("cache", f.size, 1);
    for (const f of walkFiles(reportCacheDir)) bump("reportCache", f.size, 1);

    const traceFiles = walkFiles(tracesDir);
    if (traceFiles.length === 0) {
      const legacy = fileSizeIfExists(this.paths.traceFile);
      if (legacy > 0) bump("trace", legacy, 1);
    } else {
      for (const f of traceFiles) bump("trace", f.size, 1);
    }

    for (const f of walkFiles(timelineDir)) bump("timeline", f.size, 1);
    for (const f of walkFiles(dataRunsDir)) bump("timeline", f.size, 1);

    bump("sqlite_memory", fileSizeIfExists(this.paths.memoryDbPath), existsDb(this.paths.memoryDbPath) ? 1 : 0);
    if (this.paths.toolsDbPath) {
      bump("sqlite_tools", fileSizeIfExists(this.paths.toolsDbPath), existsDb(this.paths.toolsDbPath) ? 1 : 0);
    }

    bump("notifications", fileSizeIfExists(this.paths.notificationFile), existsDb(this.paths.notificationFile) ? 1 : 0);
    bump(
      "scheduler",
      fileSizeIfExists(this.paths.schedulerJournalFile),
      existsDb(this.paths.schedulerJournalFile) ? 1 : 0,
    );

    for (const f of walkFiles(vectorsDir)) bump("vector", f.size, 1);
    for (const f of walkFiles(lifecycleMetaDir)) bump("lifecycle", f.size, 1);

    const allFiles: LargestFileEntry[] = [];
    const collectLargest = (category: StorageCategory, root: string): void => {
      for (const f of walkFiles(root)) {
        allFiles.push({ path: f.path, bytes: f.size, category });
      }
    };
    collectLargest("temp", tempDir);
    collectLargest("cache", cacheDir);
    collectLargest("reportCache", reportCacheDir);
    collectLargest("trace", tracesDir);
    if (traceFiles.length === 0 && fileSizeIfExists(this.paths.traceFile) > 0) {
      allFiles.push({ path: this.paths.traceFile, bytes: fileSizeIfExists(this.paths.traceFile), category: "trace" });
    }
    collectLargest("timeline", timelineDir);
    collectLargest("notifications", path.dirname(this.paths.notificationFile));

    allFiles.sort((a, b) => b.bytes - a.bytes);
    const largestFiles = allFiles.slice(0, 10);

    const categoryList = [...categories.values()].sort((a, b) => b.bytes - a.bytes);
    const totalBytes = categoryList.reduce((sum, c) => sum + c.bytes, 0);

    return {
      totalBytes,
      categories: categoryList,
      largestFiles,
      generatedAt: Date.now(),
    };
  }
}

function existsDb(p: string): boolean {
  try {
    return fileSizeIfExists(p) > 0;
  } catch {
    return false;
  }
}
