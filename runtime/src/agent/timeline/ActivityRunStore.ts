import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import path from "node:path";

import type { RunActivityDetail } from "@ariadne/protocol/public";
import type { ActivityAgentRun, ActivityRunManifest, AgentActivityEvent } from "./types.js";

export function activityRunDir(storageRoot: string, runId: string): string {
  return path.join(storageRoot, ".agent", "runs", runId);
}

export function buildActivityRunManifest(
  run: ActivityAgentRun,
  opts: { workspaceRoot: string; sessionId?: string },
): ActivityRunManifest {
  return {
    runId: run.id,
    sessionId: opts.sessionId,
    projectPath: opts.workspaceRoot,
    status: run.status,
    createdAt: run.createdAt,
    completedAt: run.endedAt,
    summaryPath: "summary.md",
    eventsPath: "events.jsonl",
    artifactPaths: [],
    pinned: false,
    retentionClass: "default",
  };
}

/** 落盘 Activity Run：`run.json` / `events.jsonl` / `summary.md` / `manifest.json` / `raw-tool-calls.jsonl`。 */
export class ActivityRunStore {
  constructor(private readonly storageRoot: string) {}

  ensureDir(runId: string): string {
    const dir = activityRunDir(this.storageRoot, runId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  saveRun(run: ActivityAgentRun): void {
    const dir = this.ensureDir(run.id);
    writeFileSync(path.join(dir, "run.json"), JSON.stringify(run, null, 2), "utf-8");
  }

  saveManifest(manifest: ActivityRunManifest): void {
    const dir = this.ensureDir(manifest.runId);
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
  }

  loadManifest(runId: string): ActivityRunManifest | null {
    const file = path.join(activityRunDir(this.storageRoot, runId), "manifest.json");
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf-8")) as ActivityRunManifest;
    } catch {
      return null;
    }
  }

  loadRun(runId: string): ActivityAgentRun | null {
    const file = path.join(activityRunDir(this.storageRoot, runId), "run.json");
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf-8")) as ActivityAgentRun;
    } catch {
      return null;
    }
  }

  appendEvent(runId: string, event: AgentActivityEvent): void {
    const dir = this.ensureDir(runId);
    appendFileSync(path.join(dir, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf-8");
  }

  listEvents(runId: string): AgentActivityEvent[] {
    const file = path.join(activityRunDir(this.storageRoot, runId), "events.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf-8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as AgentActivityEvent);
  }

  saveSummary(runId: string, markdown: string): void {
    const dir = this.ensureDir(runId);
    writeFileSync(path.join(dir, "summary.md"), markdown, "utf-8");
  }

  appendRawToolCall(runId: string, record: Record<string, unknown>): void {
    const dir = this.ensureDir(runId);
    appendFileSync(path.join(dir, "raw-tool-calls.jsonl"), `${JSON.stringify(record)}\n`, "utf-8");
  }

  saveActivityDetail(runId: string, detail: RunActivityDetail): string {
    const dir = path.join(this.ensureDir(runId), "activity-details");
    mkdirSync(dir, { recursive: true });
    const relative = path.join("activity-details", `${safeArtifactId(detail.activityId)}.json`);
    const existingDiffBytes = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .reduce((sum, entry) => {
        try {
          const current = JSON.parse(
            readFileSync(path.join(dir, entry.name), "utf-8"),
          ) as RunActivityDetail;
          return sum + current.fileChanges.reduce(
            (bytes, change) => bytes + Buffer.byteLength(change.diff ?? "", "utf8"),
            0,
          );
        } catch {
          return sum;
        }
      }, 0);
    const requestedDiffBytes = detail.fileChanges.reduce(
      (sum, change) => sum + Buffer.byteLength(change.diff ?? "", "utf8"),
      0,
    );
    const bounded = existingDiffBytes + requestedDiffBytes > 20 * 1024 * 1024
      ? {
          ...detail,
          outputTruncated: true,
          fileChanges: detail.fileChanges.map((change) => ({
            ...change,
            diff: undefined,
            diffTruncated: change.diffTruncated || Boolean(change.diff),
          })),
        }
      : detail;
    writeFileSync(
      path.join(this.ensureDir(runId), relative),
      JSON.stringify(bounded, null, 2),
      "utf-8",
    );
    return relative.replace(/\\/gu, "/");
  }

  loadActivityDetail(runId: string, activityId: string): RunActivityDetail | null {
    const file = path.join(
      activityRunDir(this.storageRoot, runId),
      "activity-details",
      `${safeArtifactId(activityId)}.json`,
    );
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf-8")) as RunActivityDetail;
    } catch {
      return null;
    }
  }

  /** 删除整个 timeline 目录。 */
  deleteRunDirectory(runId: string): boolean {
    const dir = activityRunDir(this.storageRoot, runId);
    if (!existsSync(dir)) return false;
    rmSync(dir, { recursive: true, force: true });
    return true;
  }

  deleteRunsForSessions(sessionIds: readonly string[]): string[] {
    const targets = new Set(sessionIds.map((value) => value.trim()).filter(Boolean));
    if (targets.size === 0) return [];
    const deleted: string[] = [];
    for (const runId of this.listRunIds()) {
      const manifest = this.loadManifest(runId);
      if (!manifest?.sessionId || !targets.has(manifest.sessionId)) continue;
      if (this.deleteRunDirectory(runId)) deleted.push(runId);
    }
    return deleted;
  }

  /** 仅删除 raw events（保留 run.json / summary.md / manifest.json）。 */
  pruneRawEvents(runId: string): { removed: string[]; bytesFreed: number } {
    const dir = activityRunDir(this.storageRoot, runId);
    const removed: string[] = [];
    let bytesFreed = 0;
    for (const name of ["events.jsonl", "raw-tool-calls.jsonl"]) {
      const file = path.join(dir, name);
      if (!existsSync(file)) continue;
      bytesFreed += statSync(file).size;
      unlinkSync(file);
      removed.push(file);
    }
    return { removed, bytesFreed };
  }

  /** 列出所有 timeline run 目录 id。 */
  listRunIds(): string[] {
    const root = path.join(this.storageRoot, ".agent", "runs");
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }
}

function safeArtifactId(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,512}$/u.test(value)) {
    throw new Error("invalid_activity_artifact_id");
  }
  return value;
}
