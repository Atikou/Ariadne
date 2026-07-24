import { existsSync } from "node:fs";
import path from "node:path";
import { redactValue } from "../util/redact.js";
import { readTraceTailLines } from "../util/traceSegmentIo.js";
import { listFilesForTailRead, type TraceCatalog } from "./traceCatalog.js";
import type { TraceEvent } from "./TraceLogger.js";
import { REPLAY_EVENT_TYPES } from "./traceReplayTypes.js";

export { REPLAY_EVENT_TYPES } from "./traceReplayTypes.js";

export interface TraceReadOptions {
  limit?: number;
  redact?: boolean;
  catalog?: TraceCatalog;
}

function parseTraceLines(lines: string[], redact: boolean): TraceEvent[] {
  const events: TraceEvent[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as TraceEvent;
      events.push(redact ? redactValue(parsed) : parsed);
    } catch {
      // 跳过损坏行
    }
  }
  return events;
}

function resolveCatalog(traceFileOrDir: string, catalog?: TraceCatalog): TraceCatalog {
  if (catalog) return catalog;
  const base = path.basename(traceFileOrDir);
  const dir = path.dirname(traceFileOrDir);
  if (base === "trace-current.jsonl") return { tracesDir: path.dirname(dir) };
  if (base === "trace.jsonl") return { tracesDir: dir };
  return { tracesDir: traceFileOrDir };
}

/** 读取 trace JSONL 尾部事件（支持 active + segments + legacy）。 */
export function readRecentTraceEvents(
  traceFileOrDir: string,
  options: TraceReadOptions = {},
): TraceEvent[] {
  const limit = options.limit ?? 50;
  const redact = options.redact !== false;
  const catalog = resolveCatalog(traceFileOrDir, options.catalog);
  const files = listFilesForTailRead(catalog);
  if (files.length === 0) {
    if (existsSync(traceFileOrDir)) {
      return parseTraceLines(readTraceTailLines(traceFileOrDir, limit), redact);
    }
    return [];
  }

  const collected: string[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const need = limit - collected.length;
    if (need <= 0) break;
    const lines = readTraceTailLines(file, need);
    collected.unshift(...lines);
    if (collected.length >= limit) break;
  }
  return parseTraceLines(collected.slice(-limit), redact);
}

/** 读取可回放审计链路（过滤 model_call 等噪声事件）。 */
export function readReplayTraceEvents(
  traceFileOrDir: string,
  options: TraceReadOptions = {},
): TraceEvent[] {
  const limit = options.limit ?? 100;
  const events = readRecentTraceEvents(traceFileOrDir, { ...options, limit: limit * 3 });
  const filtered = events.filter((e) => REPLAY_EVENT_TYPES.has(String(e.type)));
  return filtered.slice(-limit);
}
