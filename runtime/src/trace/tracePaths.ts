import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

export const ACTIVE_REL = path.join("active", "trace-current.jsonl");
export const LEGACY_FILE = "trace.jsonl";

export interface TracePathLayout {
  tracesDir: string;
  activeFile: string;
  legacyFile: string;
  segmentsDir: string;
  indexDbPath: string;
}

export function resolveTracePaths(tracesDir: string): TracePathLayout {
  return {
    tracesDir,
    activeFile: path.join(tracesDir, ACTIVE_REL),
    legacyFile: path.join(tracesDir, LEGACY_FILE),
    segmentsDir: path.join(tracesDir, "segments"),
    indexDbPath: path.join(tracesDir, "index.db"),
  };
}

/** 生成新 segment 相对路径（相对于 tracesDir）。 */
export function nextSegmentRelPath(tracesDir: string, now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const dayKey = `${y}${m}${d}`;
  const segDir = path.join("segments", String(y), m);
  const absDir = path.join(tracesDir, segDir);
  mkdirSync(absDir, { recursive: true });
  let seq = 1;
  if (existsSync(absDir)) {
    const existing = readdirSync(absDir).filter((f) => f.startsWith(`trace-${dayKey}-`));
    seq = existing.length + 1;
  }
  return path.join(segDir, `trace-${dayKey}-${String(seq).padStart(4, "0")}.jsonl`);
}

export function toRelativeSegment(tracesDir: string, absOrRel: string): string {
  if (!path.isAbsolute(absOrRel)) return absOrRel.replace(/\\/g, "/");
  return path.relative(tracesDir, absOrRel).replace(/\\/g, "/");
}

export function toAbsoluteSegment(tracesDir: string, rel: string): string {
  return path.isAbsolute(rel) ? rel : path.join(tracesDir, rel);
}
