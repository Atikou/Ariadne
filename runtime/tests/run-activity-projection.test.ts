import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentToolActivityTracker } from "../src/agent/AgentToolActivityTracker.js";
import { ActivityRunStore } from "../src/agent/timeline/ActivityRunStore.js";
import { AgentTimelineService } from "../src/agent/timeline/AgentTimelineService.js";
import { projectRunActivityGraph } from "../src/application/runActivityProjection.js";

const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("run activity graph", () => {
  it("keeps parallel tools in one batch and creates sequence and verification edges", () => {
    const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "ariadne-activity-"));
    roots.push(workspaceRoot);
    const timeline = new AgentTimelineService({ projectRoot: workspaceRoot, storageRoot: workspaceRoot });
    timeline.createRun({ id: "run-1", goal: "edit", sessionId: "session-1" });

    const first = new AgentToolActivityTracker(timeline, "run-1");
    first.startTool({
      tool: "read_file",
      toolInput: { path: "a.ts" },
      iteration: 1,
      toolCallId: "read-a",
      batchId: "batch-1",
    });
    first.ok("read a");
    const parallel = new AgentToolActivityTracker(timeline, "run-1");
    parallel.startTool({
      tool: "read_file",
      toolInput: { path: "b.ts" },
      iteration: 1,
      toolCallId: "read-b",
      batchId: "batch-1",
    });
    parallel.ok("read b");
    const write = new AgentToolActivityTracker(timeline, "run-1");
    write.startTool({
      tool: "write_file",
      toolInput: { path: "a.ts", content: "next" },
      iteration: 2,
      toolCallId: "write-a",
      batchId: "batch-2",
      dependsOnToolCallIds: ["read-a", "read-b"],
    });
    write.ok("wrote a", { output: { path: "a.ts", diff: "-old\n+next" } });
    const verify = new AgentToolActivityTracker(timeline, "run-1");
    verify.startTool({
      tool: "read_file",
      toolInput: { path: "a.ts" },
      iteration: 2,
      toolCallId: "verify-a",
      batchId: "verification",
      dependsOnToolCallIds: ["write-a"],
      verifiesToolCallId: "write-a",
    });
    verify.ok("verified");
    const dispatch = new AgentToolActivityTracker(timeline, "run-1");
    dispatch.startTool({
      tool: "dispatch_subagent",
      toolInput: { tasks: [{ goal: "inspect child" }] },
      iteration: 3,
      toolCallId: "dispatch-child",
      batchId: "batch-3",
    });
    dispatch.ok("dispatched");
    const child = new AgentToolActivityTracker(timeline, "run-1");
    child.startTool({
      tool: "read_file",
      toolInput: { path: "child.ts" },
      iteration: 1,
      toolCallId: "child:read",
      batchId: "child-batch-1",
      laneId: "subagent:child-1",
      parentActivityId: dispatch.activityId,
    });
    child.ok("child read");

    const graph = projectRunActivityGraph({
      run: timeline.getRun()!,
      sessionId: "session-1",
      status: "running",
    });

    expect(graph.nodes.filter((node) => node.batchId === "batch-1")).toHaveLength(2);
    expect(graph.edges.filter((edge) => edge.kind === "sequence")).toHaveLength(3);
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "verification" }),
      expect.objectContaining({
        sourceActivityId: dispatch.activityId,
        targetActivityId: child.activityId,
        kind: "delegation",
      }),
    ]));
    const firstDetail = new ActivityRunStore(workspaceRoot)
      .loadActivityDetail("run-1", first.activityId!);
    expect(firstDetail?.fileChanges).toEqual([]);
  });

  it("writes only redacted bounded tool details", () => {
    const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "ariadne-activity-redact-"));
    roots.push(workspaceRoot);
    const timeline = new AgentTimelineService({ projectRoot: workspaceRoot, storageRoot: workspaceRoot });
    timeline.createRun({ id: "run-2", goal: "run", sessionId: "session-2" });
    const tracker = new AgentToolActivityTracker(timeline, "run-2");
    tracker.startTool({
      tool: "shell_run",
      toolInput: {
        command: "TOKEN=secret tool --auth Bearer abcdef",
        apiKey: "secret-value",
      },
      iteration: 1,
      toolCallId: "shell-1",
    });
    tracker.ok("done", {
      output: { stdout: "Bearer raw-secret" },
      workspaceAccess: {
        crossWorkspace: false,
        pathRisk: "normal",
        pathRiskTier: "low",
        normalizedPath: workspaceRoot,
        operation: "shell",
      },
    });

    const step = timeline.getRun()!.steps.find((candidate) => candidate.metadata?.toolCallId === "shell-1")!;
    const detail = new ActivityRunStore(workspaceRoot).loadActivityDetail("run-2", step.id)!;
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain("raw-secret");
    expect(detail.redacted).toBe(true);
    expect(detail.permissionAudit).toMatchObject({
      crossWorkspace: false,
      operation: "shell",
    });
    expect(readFileSync(
      path.join(workspaceRoot, ".agent", "runs", "run-2", "raw-tool-calls.jsonl"),
      "utf8",
    )).not.toContain("secret-value");
  });

  it("pauses active timing while waiting and resumes the same accumulated clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T08:00:00.000Z"));
    const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "ariadne-activity-timing-"));
    roots.push(workspaceRoot);
    const timeline = new AgentTimelineService({ projectRoot: workspaceRoot, storageRoot: workspaceRoot });
    timeline.createRun({ id: "run-timing", goal: "wait", sessionId: "session-timing" });

    vi.advanceTimersByTime(5_000);
    timeline.pauseRun("waiting for permission");
    expect(timeline.getRun()).toMatchObject({
      status: "waiting",
      activeDurationMs: 5_000,
    });
    expect(timeline.getRun()?.activeSince).toBeUndefined();

    vi.advanceTimersByTime(20_000);
    timeline.resumeRun({ id: "run-timing", goal: "wait", sessionId: "session-timing" });
    expect(timeline.getRun()?.activeDurationMs).toBe(5_000);
    vi.advanceTimersByTime(3_000);
    timeline.completeRun("done");
    expect(timeline.getRun()).toMatchObject({
      status: "success",
      activeDurationMs: 8_000,
    });
    expect(timeline.getRun()?.activeSince).toBeUndefined();
  });

  it("converts Timeline v1 to a read-only linear graph", () => {
    const graph = projectRunActivityGraph({
      run: {
        schemaVersion: 1,
        id: "legacy-run",
        title: "legacy",
        goal: "legacy",
        status: "success",
        createdAt: 1_000,
        updatedAt: 3_000,
        endedAt: 3_000,
        steps: [
          {
            id: "legacy-a",
            runId: "legacy-run",
            type: "file_read",
            title: "read",
            status: "success",
            startedAt: 1_000,
            endedAt: 2_000,
            metadata: { toolName: "read_file" },
          },
          {
            id: "legacy-b",
            runId: "legacy-run",
            type: "shell",
            title: "test",
            status: "success",
            startedAt: 2_000,
            endedAt: 3_000,
            metadata: { toolName: "shell_run" },
          },
        ],
      },
      sessionId: "legacy-session",
      status: "completed",
    });

    expect(graph.nodes.map((node) => node.toolCallId)).toEqual([
      "legacy:legacy-a",
      "legacy:legacy-b",
    ]);
    expect(graph.nodes.every((node) => !node.detailAvailable)).toBe(true);
    expect(graph.edges).toEqual([
      expect.objectContaining({
        sourceActivityId: "legacy-a",
        targetActivityId: "legacy-b",
        kind: "sequence",
      }),
    ]);
  });

  it("deletes all activity artifacts owned by a deleted session", () => {
    const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "ariadne-activity-delete-"));
    roots.push(workspaceRoot);
    const first = new AgentTimelineService({ projectRoot: workspaceRoot, storageRoot: workspaceRoot });
    first.createRun({ id: "delete-run", goal: "delete", sessionId: "delete-session" });
    const retained = new AgentTimelineService({ projectRoot: workspaceRoot, storageRoot: workspaceRoot });
    retained.createRun({ id: "retain-run", goal: "retain", sessionId: "retain-session" });
    const store = new ActivityRunStore(workspaceRoot);

    expect(store.deleteRunsForSessions(["delete-session"])).toEqual(["delete-run"]);
    expect(store.loadRun("delete-run")).toBeNull();
    expect(store.loadRun("retain-run")).not.toBeNull();
  });

  it("projects the real compression lifecycle as running then completed history", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T08:00:00.000Z"));
    const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "ariadne-activity-system-"));
    roots.push(workspaceRoot);
    const timeline = new AgentTimelineService({ projectRoot: workspaceRoot, storageRoot: workspaceRoot });
    timeline.createRun({ id: "run-system", goal: "compact", sessionId: "session-system" });
    const activity = timeline.startSystemActivity({
      kind: "context_compaction",
      title: "正在自动压缩上下文",
      beforeChars: 2_000,
    });
    let graph = projectRunActivityGraph({
      run: timeline.getRun()!,
      status: "running",
    });
    expect(graph.systemActivities).toEqual([
      expect.objectContaining({
        activityId: activity.id,
        status: "running",
        title: "正在自动压缩上下文",
      }),
    ]);

    vi.advanceTimersByTime(1_200);
    timeline.completeSystemActivity(activity.id, {
      processedMessages: 8,
      beforeChars: 2_000,
      afterChars: 500,
      summaryType: "session_summary",
    });
    graph = projectRunActivityGraph({
      run: timeline.getRun()!,
      status: "running",
    });
    expect(graph.systemActivities).toEqual([
      expect.objectContaining({
        status: "completed",
        title: "已自动压缩上下文",
        durationMs: 1_200,
        processedMessages: 8,
        beforeChars: 2_000,
        afterChars: 500,
        summaryType: "session_summary",
      }),
    ]);
  });
});
