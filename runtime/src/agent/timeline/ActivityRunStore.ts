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

import type { ActivityAgentRun, ActivityRunManifest, AgentActivityEvent } from "./types.js";

export function activityRunDir(workspaceRoot: string, runId: string): string {
  return path.join(workspaceRoot, ".agent", "runs", runId);
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
  constructor(private readonly workspaceRoot: string) {}

  ensureDir(runId: string): string {
    const dir = activityRunDir(this.workspaceRoot, runId);
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
    const file = path.join(activityRunDir(this.workspaceRoot, runId), "manifest.json");
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf-8")) as ActivityRunManifest;
    } catch {
      return null;
    }
  }

  loadRun(runId: string): ActivityAgentRun | null {
    const file = path.join(activityRunDir(this.workspaceRoot, runId), "run.json");
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
    const file = path.join(activityRunDir(this.workspaceRoot, runId), "events.jsonl");
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

  /** 删除整个 timeline 目录。 */
  deleteRunDirectory(runId: string): boolean {
    const dir = activityRunDir(this.workspaceRoot, runId);
    if (!existsSync(dir)) return false;
    rmSync(dir, { recursive: true, force: true });
    return true;
  }

  /** 仅删除 raw events（保留 run.json / summary.md / manifest.json）。 */
  pruneRawEvents(runId: string): { removed: string[]; bytesFreed: number } {
    const dir = activityRunDir(this.workspaceRoot, runId);
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
    const root = path.join(this.workspaceRoot, ".agent", "runs");
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }
}
