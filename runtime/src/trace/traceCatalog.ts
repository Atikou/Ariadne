import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
} from "node:fs";
import path from "node:path";

import { readTraceSegmentUtf8 } from "../util/traceSegmentIo.js";
import type { TraceQueryFilter } from "./traceReplayTypes.js";
import { ACTIVE_REL, resolveTracePaths, toAbsoluteSegment } from "./tracePaths.js";
import type { TraceIndexStore } from "./TraceIndexStore.js";
import type { TraceEvent } from "./TraceLogger.js";

export interface TraceCatalog {
  tracesDir: string;
  index?: TraceIndexStore;
}

/** 将 legacy trace.jsonl 迁移到 segments 并建立索引（同步）。 */
export function migrateLegacyTraceFile(catalog: TraceCatalog): boolean {
  const layout = resolveTracePaths(catalog.tracesDir);
  if (!existsSync(layout.legacyFile)) return false;
  const size = statSync(layout.legacyFile).size;
  if (size === 0) return false;

  mkdirSync(path.dirname(layout.activeFile), { recursive: true });
  mkdirSync(layout.segmentsDir, { recursive: true });

  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const segRel = path.join("segments", String(y), m, `trace-migrated-${y}${m}${d}.jsonl`);
  const segAbs = path.join(catalog.tracesDir, segRel);
  mkdirSync(path.dirname(segAbs), { recursive: true });
  renameSync(layout.legacyFile, segAbs);

  if (catalog.index) {
    indexSegmentFileSync(catalog, segAbs, segRel.replace(/\\/g, "/"));
  }
  return true;
}

export function indexSegmentFileSync(
  catalog: TraceCatalog,
  absPath: string,
  segmentRel: string,
): number {
  if (!catalog.index || !existsSync(absPath)) return 0;
  const text = readTraceSegmentUtf8(absPath);
  const lines = text.split("\n").filter((l) => l.trim());
  let count = 0;
  for (const trimmed of lines) {
    try {
      const parsed = JSON.parse(trimmed) as TraceEvent & {
        eventId?: string;
        runId?: string;
        sessionId?: string;
        time?: string;
      };
      const eventId =
        typeof parsed.eventId === "string" ? parsed.eventId : `legacy-${count}-${segmentRel}`;
      const ts = Date.parse(String(parsed.time ?? "")) || Date.now();
      catalog.index.insert({
        eventId,
        ts,
        runId: typeof parsed.runId === "string" ? parsed.runId : undefined,
        sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
        eventType: String(parsed.type ?? "unknown"),
        segmentPath: segmentRel,
        redacted: true,
      });
      count += 1;
    } catch {
      // skip
    }
  }
  return count;
}

/** 按修改时间列出 segment 绝对路径（旧→新）。 */
export function listSegmentFiles(tracesDir: string): string[] {
  const layout = resolveTracePaths(tracesDir);
  if (!existsSync(layout.segmentsDir)) return [];
  const files: Array<{ path: string; mtime: number }> = [];

  const walk = (dir: string): void => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, name.name);
      if (name.isDirectory()) walk(full);
      else if (name.isFile() && (name.name.endsWith(".jsonl.gz") || name.name.endsWith(".jsonl"))) {
        files.push({ path: full, mtime: statSync(full).mtimeMs });
      }
    }
  };
  walk(layout.segmentsDir);
  files.sort((a, b) => a.mtime - b.mtime);
  return files.map((f) => f.path);
}

/** 尾部读取顺序：active → 最新 segments（新→旧）。 */
export function listFilesForTailRead(catalog: TraceCatalog, maxSegments = 8): string[] {
  const layout = resolveTracePaths(catalog.tracesDir);
  const out: string[] = [];
  if (existsSync(layout.activeFile)) out.push(layout.activeFile);
  const segments = listSegmentFiles(catalog.tracesDir);
  for (let i = segments.length - 1; i >= 0 && out.length < maxSegments + 1; i -= 1) {
    out.push(segments[i]!);
  }
  if (out.length === 0 && existsSync(layout.legacyFile)) out.push(layout.legacyFile);
  return out;
}

/** 带 scope 过滤时优先走索引定位 segment。 */
export function resolveFilesForFilter(catalog: TraceCatalog, filter?: TraceQueryFilter): string[] {
  const layout = resolveTracePaths(catalog.tracesDir);
  const indexed: string[] = [];

  if (catalog.index && filter?.runId) {
    indexed.push(...catalog.index.findSegmentPathsByRunId(filter.runId).map((rel) => toAbsoluteSegment(catalog.tracesDir, rel)));
  } else if (catalog.index && filter?.sessionId) {
    indexed.push(
      ...catalog.index
        .findSegmentPathsBySessionId(filter.sessionId)
        .map((rel) => toAbsoluteSegment(catalog.tracesDir, rel)),
    );
  }

  if (indexed.length > 0) {
    const uniq = [...new Set(indexed)].filter((f) => existsSync(f));
    if (existsSync(layout.activeFile)) {
      const activeRel = ACTIVE_REL.replace(/\\/g, "/");
      const needsActive = catalog.index && filter?.runId
        ? catalog.index.findSegmentPathsByRunId(filter.runId).includes(activeRel)
        : catalog.index && filter?.sessionId
          ? catalog.index.findSegmentPathsBySessionId(filter.sessionId).includes(activeRel)
          : true;
      if (needsActive) uniq.push(layout.activeFile);
    }
    return uniq.length > 0 ? uniq : listFilesForTailRead(catalog, 32);
  }

  if (filter?.runId || filter?.sessionId || filter?.taskId || filter?.toolCallId) {
    const all = [...listSegmentFiles(catalog.tracesDir)];
    if (existsSync(layout.activeFile)) all.push(layout.activeFile);
    if (existsSync(layout.legacyFile)) all.push(layout.legacyFile);
    return all.length > 0 ? all : [];
  }

  return listFilesForTailRead(catalog, 8);
}
