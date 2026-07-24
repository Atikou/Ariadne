import { existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";

import { atomicWriteFile } from "./fsUtils.js";
import type { TraceIndexStore } from "../trace/TraceIndexStore.js";
import {
  listSegmentFiles,
  type TraceCatalog,
} from "../trace/traceCatalog.js";
import { resolveTracePaths } from "../trace/tracePaths.js";
import { isGzipTraceSegment, readTraceSegmentUtf8 } from "../util/traceSegmentIo.js";

export interface TracePurgeResult {
  segmentsRewritten: number;
  eventsRemoved: number;
  indexEntriesRemoved: number;
}

function eventMatchesSession(
  parsed: Record<string, unknown>,
  sessionId: string,
  runIds: Set<string>,
): boolean {
  if (parsed.sessionId === sessionId) return true;
  const runId = parsed.runId;
  return typeof runId === "string" && runIds.has(runId);
}

function rewriteTraceFile(
  filePath: string,
  sessionId: string,
  runIds: Set<string>,
): { removed: number; rewritten: boolean } {
  if (!existsSync(filePath)) return { removed: 0, rewritten: false };
  // 同时支持明文 .jsonl 与压缩 .jsonl.gz 段，避免对 gzip 段静默跳过隐私清除。
  const gz = isGzipTraceSegment(filePath);
  const text = readTraceSegmentUtf8(filePath);
  const lines = text.split("\n").filter((l) => l.trim());
  const kept: string[] = [];
  let removed = 0;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (eventMatchesSession(parsed, sessionId, runIds)) {
        removed += 1;
        continue;
      }
    } catch {
      // keep corrupt lines
    }
    kept.push(line);
  }
  if (removed === 0) return { removed: 0, rewritten: false };
  const outText = kept.length > 0 ? `${kept.join("\n")}\n` : "";
  atomicWriteFile(filePath, gz ? gzipSync(Buffer.from(outText, "utf-8")) : outText);
  return { removed, rewritten: true };
}

/** 从 trace segments（及 legacy）重写并移除指定 session/run 事件。调用前应已 rotate active。 */
export function purgeSessionFromTraceSegments(opts: {
  catalog: TraceCatalog;
  sessionId: string;
  runIds: string[];
}): TracePurgeResult {
  const runIdSet = new Set(opts.runIds);
  const layout = resolveTracePaths(opts.catalog.tracesDir);
  const files = new Set<string>();

  if (opts.catalog.index) {
    for (const rel of opts.catalog.index.findSegmentPathsBySessionId(opts.sessionId)) {
      files.add(path.join(opts.catalog.tracesDir, rel));
    }
    for (const runId of opts.runIds) {
      for (const rel of opts.catalog.index.findSegmentPathsByRunId(runId)) {
        files.add(path.join(opts.catalog.tracesDir, rel));
      }
    }
  }
  for (const seg of listSegmentFiles(opts.catalog.tracesDir)) {
    files.add(seg);
  }
  if (existsSync(layout.legacyFile)) files.add(layout.legacyFile);

  let segmentsRewritten = 0;
  let eventsRemoved = 0;

  for (const file of files) {
    const { removed, rewritten } = rewriteTraceFile(file, opts.sessionId, runIdSet);
    if (rewritten) segmentsRewritten += 1;
    eventsRemoved += removed;
  }

  let indexEntriesRemoved = 0;
  if (opts.catalog.index) {
    indexEntriesRemoved += opts.catalog.index.deleteBySessionId(opts.sessionId);
    if (opts.runIds.length > 0) {
      indexEntriesRemoved += opts.catalog.index.deleteByRunIds(opts.runIds);
    }
  }

  return { segmentsRewritten, eventsRemoved, indexEntriesRemoved };
}
