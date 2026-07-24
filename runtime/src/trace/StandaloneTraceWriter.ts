import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { TraceIndexStore } from "./TraceIndexStore.js";
import { prepareTraceEvent, type TraceEvent } from "./TraceLogger.js";
import { resolveTracePaths } from "./tracePaths.js";

export interface StandaloneTraceWriteResult {
  eventId: string;
  segmentPath: string;
}

/** 为独立 CLI 写入不可变单事件 segment，避免与服务进程共同持有或轮转 active 文件。 */
export function writeStandaloneTraceEvent(
  tracesDir: string,
  event: TraceEvent,
): StandaloneTraceWriteResult {
  const prepared = prepareTraceEvent(event, true);
  const instant = new Date(prepared.time);
  const year = String(instant.getUTCFullYear());
  const month = String(instant.getUTCMonth() + 1).padStart(2, "0");
  const day = String(instant.getUTCDate()).padStart(2, "0");
  const segmentPath = path.join(
    "segments",
    year,
    month,
    `trace-maintenance-${year}${month}${day}-${prepared.eventId}.jsonl`,
  ).replace(/\\/g, "/");
  const layout = resolveTracePaths(tracesDir);
  const absolutePath = path.join(tracesDir, segmentPath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, prepared.line, { encoding: "utf8", flag: "wx" });

  let index: TraceIndexStore | undefined;
  try {
    index = new TraceIndexStore(layout.indexDbPath);
    const payload = prepared.payload as Record<string, unknown>;
    index.insert({
      eventId: prepared.eventId,
      ts: Date.parse(prepared.time),
      runId: typeof payload.runId === "string" ? payload.runId : undefined,
      sessionId: typeof payload.sessionId === "string" ? payload.sessionId : undefined,
      eventType: String(payload.type ?? "unknown"),
      status: typeof payload.status === "string" ? payload.status : undefined,
      segmentPath,
      redacted: true,
    });
  } finally {
    index?.close();
  }
  return { eventId: prepared.eventId, segmentPath };
}
