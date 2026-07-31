import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ContextManager,
  createLlmSummarize,
} from "../src/context/ContextManager.js";

const temporaryRoots: string[] = [];
const managers: ContextManager[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.close();
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

async function manager(options: ConstructorParameters<typeof ContextManager>[0] = {
  dataDir: "",
}): Promise<ContextManager> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ariadne-context-governance-"));
  temporaryRoots.push(root);
  const value = new ContextManager({
    ...options,
    dataDir: root,
    useLanceDb: false,
  });
  managers.push(value);
  return value;
}

describe("summary and memory governance", () => {
  it("does not publish a compression lifecycle below the confirmed threshold", async () => {
    const context = await manager({ dataDir: "", messageThreshold: 2 });
    const session = context.createSession("no compression");
    context.saveUserMessage(session.id, "one");
    context.saveUserMessage(session.id, "two");
    const events: string[] = [];

    const result = await context.finalizeTurn(session.id, undefined, {
      onStarted: () => events.push("started"),
      onCompleted: () => events.push("completed"),
      onFailed: () => events.push("failed"),
    });

    expect(result.compressed).toBeNull();
    expect(events).toEqual([]);
  });

  it("publishes exactly one start and one terminal event for recursive compression", async () => {
    const context = await manager({ dataDir: "", messageThreshold: 1 });
    const session = context.createSession("compression");
    context.saveUserMessage(session.id, "one");
    context.saveUserMessage(session.id, "two");
    context.saveUserMessage(session.id, "three");
    const events: string[] = [];

    const result = await context.finalizeTurn(session.id, undefined, {
      onStarted: () => events.push("started"),
      onCompleted: ({ before, after }) => {
        events.push(`completed:${before.pendingMessages}:${after.pendingMessages}`);
      },
      onFailed: () => events.push("failed"),
    });

    expect(result.compressed).not.toBeNull();
    expect(events).toEqual(["started", "completed:3:0"]);
  });

  it("records schema version, source range, and explicit degraded summary state", async () => {
    const context = await manager({ dataDir: "", messageThreshold: 1 });
    const session = context.createSession("summary");
    const first = context.saveUserMessage(session.id, "目标：修复登录错误");
    const last = context.saveUserMessage(session.id, "仍需补充回归测试");
    const summary = await context.summaryManager.compressIfNeeded(session.id);

    expect(summary).toMatchObject({
      schemaVersion: 1,
      generationState: "degraded",
      degradedReason: "rule_slice_no_model_summarizer",
      startMessageId: first.id,
      endMessageId: last.id,
    });
  });

  it("marks an invalid model summary as degraded instead of accepting loose JSON", async () => {
    const summarize = createLlmSummarize(async () =>
      JSON.stringify({ current_goal: "goal", unknown: "not allowed" }));
    const context = await manager({ dataDir: "", messageThreshold: 1, summarize });
    const session = context.createSession("summary");
    context.saveUserMessage(session.id, "goal");
    context.saveUserMessage(session.id, "more");
    const summary = await context.summaryManager.compressIfNeeded(session.id);

    expect(summary).toMatchObject({
      schemaVersion: 1,
      generationState: "degraded",
      degradedReason: "model_summary_schema_invalid",
    });
    expect(summary?.content).not.toHaveProperty("unknown");
  });

  it("governs candidate, active, superseded, expired, secret, and delete lifecycles", async () => {
    const context = await manager();
    const candidate = context.upsertMemory({
      scope: "global",
      memoryType: "fact",
      key: "editor",
      value: "VS Code",
      lifecycleState: "candidate",
      provenance: { origin: "model_summary", sourceId: "summary-1" },
    });
    expect(candidate.lifecycleState).toBe("candidate");
    expect(context.listMemories("global")).toEqual([]);

    const active = context.confirmMemory(candidate.id);
    expect(active.lifecycleState).toBe("active");

    const replacement = context.upsertMemory({
      scope: "global",
      memoryType: "fact",
      key: "editor",
      value: "Codex",
      provenance: { origin: "user", evidence: "explicit_edit" },
    });
    expect(context.getMemory(active.id)?.lifecycleState).toBe("superseded");
    expect(replacement).toMatchObject({
      lifecycleState: "active",
      supersedesId: active.id,
    });

    const expired = context.upsertMemory({
      scope: "global",
      memoryType: "recent_state",
      value: "temporary",
      retentionUntil: new Date(Date.now() - 1_000).toISOString(),
      provenance: { origin: "user" },
    });
    expect(context.listMemories("global").some((item) => item.id === expired.id)).toBe(false);

    expect(() => context.upsertMemory({
      scope: "global",
      memoryType: "fact",
      value: "API_KEY=secret",
      sensitivity: "secret",
      provenance: { origin: "user" },
    })).toThrow("secret_memory_persistence_denied");

    expect(context.deleteMemory(replacement.id)).toBe(true);
    expect(context.getMemory(replacement.id)).toBeNull();
  });

  it("creates an auditable replacement for a user edit and lists terminal history", async () => {
    const context = await manager();
    const original = context.upsertMemory({
      scope: "project",
      scopeId: "project-1",
      memoryType: "decision",
      key: "database",
      value: "Use SQLite",
      provenance: { origin: "workspace", sourceId: "architecture-1" },
    });

    const edited = context.memoryManager.update(original.id, {
      value: "Use SQLite with WAL",
      summary: "Persistence decision",
      importance: 0.9,
    });

    expect(context.getMemory(original.id)?.lifecycleState).toBe("superseded");
    expect(edited).toMatchObject({
      value: "Use SQLite with WAL",
      lifecycleState: "active",
      supersedesId: original.id,
      provenance: {
        origin: "user",
        sourceId: original.id,
        evidence: "user_edit",
      },
    });
    expect(new Set(context.memoryManager.list({
      scope: "project",
      scopeId: "project-1",
    }).map((memory) => memory.lifecycleState))).toEqual(new Set(["active", "superseded"]));
  });
});
