import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

import { redactValue } from "../util/redact.js";
import { createTraceSegmentReadStream } from "../util/traceSegmentIo.js";
import { resolveFilesForFilter, type TraceCatalog } from "./traceCatalog.js";
import { readRecentTraceEvents } from "./traceReader.js";
import {
  REPLAY_EVENT_TYPES,
  TRACE_CATEGORY_TYPES,
  type TraceQueryFilter,
  type TraceReplayCategory,
} from "./traceReplayTypes.js";
import type { TraceEvent } from "./TraceLogger.js";

export {
  REPLAY_EVENT_TYPES,
  TRACE_CATEGORY_TYPES,
} from "./traceReplayTypes.js";
export type { TraceReplayCategory, TraceQueryFilter } from "./traceReplayTypes.js";

export interface ScanTraceOptions {
  limit?: number;
  maxScanLines?: number;
  redact?: boolean;
  filter?: TraceQueryFilter;
  catalog?: TraceCatalog;
}

export interface TraceQuerySummary {
  types: Record<string, number>;
  toolCallIds: string[];
  runIds: string[];
  sessionIds: string[];
}

const DEFAULT_MAX_SCAN_LINES = 20_000;

export function serializeTraceQueryFilter(filter: TraceQueryFilter): Record<string, string | boolean | string[]> {
  const out: Record<string, string | boolean | string[]> = {};
  if (filter.runId) out.runId = filter.runId;
  if (filter.sessionId) out.sessionId = filter.sessionId;
  if (filter.taskId) out.taskId = filter.taskId;
  if (filter.toolCallId) out.toolCallId = filter.toolCallId;
  if (filter.type) out.type = filter.type;
  if (filter.types?.length) out.types = filter.types;
  if (filter.category) out.category = filter.category;
  if (filter.replayOnly === false) out.replayOnly = false;
  return out;
}

function hasScopedFilter(filter?: TraceQueryFilter): boolean {
  if (!filter) return false;
  return !!(filter.runId || filter.sessionId || filter.taskId || filter.toolCallId || filter.type || filter.types?.length || filter.category);
}

function allowedTypes(filter?: TraceQueryFilter): Set<string> | undefined {
  const sets: Set<string>[] = [];
  if (filter?.type) sets.push(new Set([filter.type]));
  if (filter?.types?.length) sets.push(new Set(filter.types));
  if (filter?.category) sets.push(new Set(TRACE_CATEGORY_TYPES[filter.category]));
  if (filter?.replayOnly !== false) sets.push(REPLAY_EVENT_TYPES);
  if (sets.length === 0) return undefined;
  let result = sets[0]!;
  for (let i = 1; i < sets.length; i++) {
    result = new Set([...result].filter((t) => sets[i]!.has(t)));
  }
  return result;
}

export function matchesTraceFilter(event: TraceEvent, filter?: TraceQueryFilter): boolean {
  if (!filter) return true;
  const e = event as Record<string, unknown>;
  if (filter.runId && e.runId !== filter.runId) return false;
  if (filter.sessionId && e.sessionId !== filter.sessionId) return false;
  if (filter.taskId && e.taskId !== filter.taskId) return false;
  if (filter.toolCallId && e.toolCallId !== filter.toolCallId) return false;

  const type = String(e.type ?? "");
  const allowed = allowedTypes(filter);
  if (allowed && !allowed.has(type)) return false;
  return true;
}

export function summarizeTraceEvents(events: TraceEvent[]): TraceQuerySummary {
  const types: Record<string, number> = {};
  const toolCallIds = new Set<string>();
  const runIds = new Set<string>();
  const sessionIds = new Set<string>();

  for (const event of events) {
    const e = event as Record<string, unknown>;
    const type = String(e.type ?? "unknown");
    types[type] = (types[type] ?? 0) + 1;
    if (typeof e.toolCallId === "string" && e.toolCallId) toolCallIds.add(e.toolCallId);
    if (typeof e.runId === "string" && e.runId) runIds.add(e.runId);
    if (typeof e.sessionId === "string" && e.sessionId) sessionIds.add(e.sessionId);
  }

  return {
    types,
    toolCallIds: [...toolCallIds],
    runIds: [...runIds],
    sessionIds: [...sessionIds],
  };
}

/** 扫描 trace 文件并按过滤条件收集事件；有 scope 过滤时优先索引定位 segment。 */
export async function scanTraceEvents(
  traceFileOrDir: string,
  options: ScanTraceOptions = {},
): Promise<TraceEvent[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 2000);
  const redact = options.redact !== false;
  const filter = options.filter;
  const maxScanLines = options.maxScanLines ?? DEFAULT_MAX_SCAN_LINES;

  const catalog: TraceCatalog = options.catalog ?? resolveCatalogFromPath(traceFileOrDir);

  if (!hasScopedFilter(filter)) {
    const raw = readRecentTraceEvents(traceFileOrDir, {
      limit: filter?.replayOnly === false ? limit : limit * 3,
      redact: false,
      catalog,
    });
    const matched = raw.filter((e) => matchesTraceFilter(e, filter));
    const sliced = matched.slice(-limit);
    return redact ? sliced.map((e) => redactValue(e)) : sliced;
  }

  const files = resolveFilesForFilter(catalog, filter);
  if (files.length === 0 && !existsSync(traceFileOrDir)) return [];

  const matched: TraceEvent[] = [];
  let scanned = 0;

  const scanFile = async (file: string): Promise<void> => {
    const rl = createInterface({ input: createTraceSegmentReadStream(file) });
    for await (const line of rl) {
      scanned += 1;
      if (scanned > maxScanLines) return;
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as TraceEvent;
        if (!matchesTraceFilter(parsed, filter)) continue;
        matched.push(redact ? redactValue(parsed) : parsed);
        if (matched.length > limit * 4) matched.splice(0, matched.length - limit * 2);
      } catch {
        // skip corrupt line
      }
    }
  };

  const targets = files.length > 0 ? files : [traceFileOrDir];
  for (const file of targets) {
    if (!existsSync(file)) continue;
    await scanFile(file);
    if (scanned > maxScanLines) break;
  }

  return matched.slice(-limit);
}

function resolveCatalogFromPath(traceFileOrDir: string): TraceCatalog {
  const base = path.basename(traceFileOrDir);
  const dir = path.dirname(traceFileOrDir);
  if (base === "trace-current.jsonl") return { tracesDir: path.dirname(dir) };
  if (base === "trace.jsonl") return { tracesDir: dir };
  return { tracesDir: traceFileOrDir };
}
