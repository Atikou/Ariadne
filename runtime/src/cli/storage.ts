/**
 * 本地存储 CLI：`storage status` / `storage cleanup --dry-run` / `storage cleanup --apply`
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ContextManager } from "../context/ContextManager.js";
import { InMemoryVectorStore } from "../context/VectorStore.js";
import { DataLifecycleService } from "../lifecycle/DataLifecycleService.js";
import { loadConfig } from "../config/loadConfig.js";
import { TraceIndexStore } from "../trace/TraceIndexStore.js";
import { resolveTracePaths } from "../trace/tracePaths.js";
import { loadEnvFile } from "../util/env.js";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function buildService(): DataLifecycleService {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(moduleDir, "..", "..");
  const { workspaceRoot } = loadConfig();
  const dataDir = path.join(projectRoot, "data");
  const tracesDir = path.join(dataDir, "traces");
  const layout = resolveTracePaths(tracesDir);
  mkdirSync(path.dirname(layout.activeFile), { recursive: true });
  mkdirSync(layout.segmentsDir, { recursive: true });
  const index = new TraceIndexStore(layout.indexDbPath);
  const contextManager = new ContextManager({
    dataDir,
    useLanceDb: false,
    vectorStore: new InMemoryVectorStore(),
  });
  return new DataLifecycleService({
    dataDir,
    workspaceRoot,
    traceFile: layout.activeFile,
    tracesDir,
    traceCatalog: { tracesDir, index },
    notificationFile: path.join(dataDir, "notifications", "notifications.jsonl"),
    schedulerJournalFile: path.join(dataDir, "scheduler", "triggers.jsonl"),
    memoryDb: contextManager.db,
    toolsDbPath: path.join(dataDir, "agent_data", "tools.db"),
    getActiveRunIds: () => [],
  });
}

function printUsage(): void {
  console.log(`用法:
  npm run storage:status
  npm run storage:cleanup -- --dry-run
  npm run storage:cleanup -- --apply --cleanup-run-id <id>

  或: tsx src/cli/storage.ts status | cleanup [--dry-run] [--apply --cleanup-run-id <id>]`);
}

export async function runStorageCli(args: string[]): Promise<void> {
  loadEnvFile();
  const cmd = args[0];
  if (!cmd || cmd === "--help" || cmd === "-h") {
    printUsage();
    return;
  }

  const service = buildService();

  if (cmd === "status") {
    const usage = service.getUsage();
    const policy = service.getPolicy();
    console.log(`总占用: ${formatBytes(usage.totalBytes)}`);
    console.log(`生成时间: ${new Date(usage.generatedAt).toISOString()}`);
    console.log(`自动清理: ${policy.cleanup.autoEnabled ? "开启" : "关闭"}（间隔 ${policy.cleanup.autoIntervalHours}h）`);
    console.log("\n分类占用:");
    for (const c of usage.categories) {
      console.log(`  ${c.name.padEnd(16)} ${formatBytes(c.bytes).padStart(10)}  (${c.files} 文件)`);
    }
    if (usage.largestFiles?.length) {
      console.log("\n最大文件:");
      for (const f of usage.largestFiles.slice(0, 5)) {
        console.log(`  ${formatBytes(f.bytes).padStart(10)}  ${f.path}`);
      }
    }
    return;
  }

  if (cmd === "cleanup") {
    const dryRun = args.includes("--dry-run");
    const apply = args.includes("--apply");
    const idIdx = args.indexOf("--cleanup-run-id");
    const cleanupRunId = idIdx >= 0 ? args[idIdx + 1] : undefined;

    if (dryRun && !apply) {
      const report = service.preview({ scope: "safe" });
      console.log(`cleanupRunId: ${report.cleanupRunId}`);
      console.log(`预计释放: ${formatBytes(report.summary.estimatedBytesToFree)}`);
      console.log(`候选动作: ${report.actions.filter((a) => a.canDelete).length}`);
      for (const a of report.actions.filter((x) => x.canDelete).slice(0, 20)) {
        console.log(`  [${a.risk}] ${a.type} ${a.path} (${formatBytes(a.bytes)})`);
      }
      if (report.actions.filter((a) => a.canDelete).length > 20) {
        console.log("  ...");
      }
      return;
    }

    if (apply) {
      if (!cleanupRunId) {
        console.error("apply 需要 --cleanup-run-id（先执行 --dry-run 获取）");
        process.exitCode = 1;
        return;
      }
      const result = service.apply({ cleanupRunId, confirm: true });
      if ("error" in result) {
        console.error(`清理失败: ${result.error}`);
        process.exitCode = 1;
        return;
      }
      console.log(`已释放: ${formatBytes(result.bytesFreed)}`);
      console.log(`成功动作: ${result.applied}，跳过: ${result.skipped}，失败: ${result.failed}`);
      return;
    }

    console.error("cleanup 需要 --dry-run 或 --apply");
    process.exitCode = 1;
    return;
  }

  console.error(`未知子命令: ${cmd}`);
  printUsage();
  process.exitCode = 1;
}

runStorageCli(process.argv.slice(2)).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
