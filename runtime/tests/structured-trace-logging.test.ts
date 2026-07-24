import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { projectTraceEvent } from "../src/application/publicProjection.js";
import {
  normalizeTraceEvent,
  prepareTraceEvent,
  TraceLogger,
  type PersistedTraceEvent,
} from "../src/trace/TraceLogger.js";

describe("structured runtime logging", () => {
  it("normalizes legacy error and warning events into an explicit log contract", () => {
    expect(normalizeTraceEvent({
      type: "provider_retry_warning",
      error: "temporary failure",
    })).toMatchObject({
      level: "warning",
      category: "provider_retry_warning",
      message: "temporary failure",
    });

    expect(normalizeTraceEvent({
      type: "companion_turn_failed",
      error: "proposal invalid",
    })).toMatchObject({
      level: "error",
      category: "companion_turn_failed",
      message: "proposal invalid",
    });
  });

  it("redacts structured metadata and projects it to the Logs panel contract", () => {
    const prepared = prepareTraceEvent({
      type: "companion.proposal.protocol.error",
      level: "error",
      category: "companion.proposal.protocol",
      message: "Agent 提案自动修复后仍无效",
      metadata: {
        lifecycleStage: "schema_validation",
        fieldPaths: ["risk"],
        token: "secret-token-value",
      },
    });
    const projected = projectTraceEvent({
      time: prepared.time,
      eventId: prepared.eventId,
      ...prepared.payload,
    }, "fallback");

    expect(projected).toMatchObject({
      level: "error",
      category: "companion.proposal.protocol",
      message: "Agent 提案自动修复后仍无效",
      metadata: {
        lifecycleStage: "schema_validation",
        fieldPaths: ["risk"],
        token: "[REDACTED]",
      },
    });
  });

  it("publishes the same redacted event after a durable Trace write", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ariadne-live-trace-"));
    const traceFile = path.join(root, "trace.jsonl");
    const logger = new TraceLogger(traceFile);
    const received: PersistedTraceEvent[] = [];
    const remove = logger.subscribe((event) => received.push(event));

    try {
      logger.write({
        type: "companion.turn.error",
        level: "error",
        category: "companion.turn.error",
        message: "协议校验失败",
        metadata: { token: "secret-token-value", lifecycleStage: "protocol_parse" },
      });
      remove();
      logger.write({ type: "ignored_after_unsubscribe" });
      await logger.close();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        type: "companion.turn.error",
        level: "error",
        message: "协议校验失败",
        metadata: {
          token: "[REDACTED]",
          lifecycleStage: "protocol_parse",
        },
      });
      expect(received[0]?.eventId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(readFileSync(traceFile, "utf8")).toContain(received[0]!.eventId);
    } finally {
      await logger.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
