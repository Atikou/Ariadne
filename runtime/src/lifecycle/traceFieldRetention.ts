import { existsSync } from "node:fs";

import { atomicWriteFile } from "./fsUtils.js";
import {
  eventAgeDaysFromIso,
  isFailedTraceEvent,
} from "./dbRowCleanup.js";
import type { LifecyclePolicy } from "./types.js";
import {
  gzipTraceSegmentInPlace,
  isGzipTraceSegment,
  readTraceSegmentUtf8,
} from "../util/traceSegmentIo.js";

export interface TraceFieldPruneResult {
  rewritten: boolean;
  linesTouched: number;
  bytesSaved: number;
}

const TOOL_ARG_TYPES = new Set(["agent_decision", "tool_audit"]);
const RAW_VERBOSE_TYPES = new Set(["agent_tool", "agent_decision"]);

function stripFields(obj: Record<string, unknown>, fields: string[]): number {
  let saved = 0;
  for (const field of fields) {
    if (!(field in obj)) continue;
    const before = JSON.stringify(obj[field] ?? null).length;
    delete obj[field];
    saved += before;
  }
  return saved;
}

function pruneTraceEvent(
  event: Record<string, unknown>,
  policy: LifecyclePolicy,
  now: number,
): { event: Record<string, unknown>; saved: number } {
  const age = eventAgeDaysFromIso(typeof event.time === "string" ? event.time : undefined, now);
  if (age == null) return { event, saved: 0 };

  const out = { ...event };
  let saved = 0;
  const type = String(out.type ?? "");

  if (TOOL_ARG_TYPES.has(type) && age >= policy.retentionDays.toolArgs) {
    saved += stripFields(out, ["inputPreview"]);
  }
  if (type === "tool_audit" && age >= policy.retentionDays.toolOutput) {
    saved += stripFields(out, ["outputPreview"]);
  }

  if (RAW_VERBOSE_TYPES.has(type)) {
    const ttl = isFailedTraceEvent(out)
      ? policy.retentionDays.traceRawFailed
      : policy.retentionDays.traceRawSuccess;
    if (age >= ttl) {
      saved += stripFields(out, ["rawOutput", "userDisplay", "rawPreview", "thought"]);
    }
  }

  return { event: out, saved };
}

/** 按 retention 策略裁剪 trace segment 内过期 verbose 字段（保留事件骨架）。 */
export function pruneTraceSegmentFields(
  filePath: string,
  policy: LifecyclePolicy,
  now = Date.now(),
): TraceFieldPruneResult {
  if (!existsSync(filePath)) {
    return { rewritten: false, linesTouched: 0, bytesSaved: 0 };
  }

  const wasGzip = isGzipTraceSegment(filePath);
  const text = readTraceSegmentUtf8(filePath);
  const lines = text.split("\n");
  const nextLines: string[] = [];
  let linesTouched = 0;
  let bytesSaved = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      nextLines.push(line);
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const { event, saved } = pruneTraceEvent(parsed, policy, now);
      if (saved > 0) {
        linesTouched += 1;
        bytesSaved += saved;
        nextLines.push(JSON.stringify(event));
      } else {
        nextLines.push(trimmed);
      }
    } catch {
      nextLines.push(trimmed);
    }
  }

  if (bytesSaved === 0) {
    return { rewritten: false, linesTouched: 0, bytesSaved: 0 };
  }

  const nextText = nextLines.join("\n");
  const payload = nextText.length > 0 ? `${nextText.endsWith("\n") ? nextText : `${nextText}\n`}` : "";
  const beforeBytes = Buffer.byteLength(text, "utf-8");
  if (wasGzip) {
    const plainPath = filePath.replace(/\.gz$/i, "");
    atomicWriteFile(plainPath, payload);
    gzipTraceSegmentInPlace(plainPath);
  } else {
    atomicWriteFile(filePath, payload);
  }
  const afterBytes = Buffer.byteLength(readTraceSegmentUtf8(filePath), "utf-8");
  return {
    rewritten: true,
    linesTouched,
    bytesSaved: Math.max(bytesSaved, beforeBytes - afterBytes),
  };
}
