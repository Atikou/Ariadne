import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { recoverOnStartup } from "../src/app/startupRecovery.js";
import { NotificationQueue } from "../src/background/NotificationQueue.js";
import { DatabaseManager } from "../src/context/DatabaseManager.js";
import { RunAggregateRepository } from "../src/run/RunAggregateRepository.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("startup recovery", () => {
  it("restores a pending permission pause instead of converting it to generic recovery", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ariadne-startup-permission-"));
    temporaryRoots.push(root);
    const database = new DatabaseManager(root);
    const runs = new RunAggregateRepository(database);

    createRunningRun(runs, "permission-run");

    recoverOnStartup({
      runs,
      notificationQueue: new NotificationQueue(path.join(root, "notifications.jsonl")),
      pausedRunStore: {
        get: (runId: string) => runId === "permission-run"
          ? {
              runId,
              goal: "write a file",
              messages: [],
              steps: [],
              modelTurns: 1,
              pendingAction: { toolCallId: "call-1", tool: "write_file", input: { path: "a.txt" } },
              mode: "implement",
              permissionPolicy: "confirmBeforeWrite",
              createdAt: new Date().toISOString(),
            }
          : null,
      } as never,
      permissionRequestStore: {
        getPendingByRunId: (runId: string) => runId === "permission-run"
          ? { id: "permission-1", runId, status: "pending" }
          : null,
      } as never,
      planHandoffStore: {
        getPendingByRunId: () => null,
      } as never,
    });

    expect(runs.get("permission-run")).toMatchObject({
      status: "waiting_confirmation",
      recoveryStatus: "none",
      waitReason: { code: "permission_pause_interrupted" },
    });
    database.close();
  });

  it("resumes unstarted intents but requires a decision for uncertain non-resumable effects", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ariadne-startup-recovery-"));
    temporaryRoots.push(root);
    const database = new DatabaseManager(root);
    const runs = new RunAggregateRepository(database);

    createRunningRun(runs, "safe-run");
    runs.execute({
      type: "run.tool_intent",
      runId: "safe-run",
      expectedAggregateVersion: 2,
      idempotencyKey: "safe-key",
      toolName: "read_file",
      toolVersion: "1.0.0",
      inputHash: "safe-hash",
      effects: ["workspace_read"],
      resumable: true,
    });

    createRunningRun(runs, "unsafe-run");
    runs.execute({
      type: "run.tool_intent",
      runId: "unsafe-run",
      expectedAggregateVersion: 2,
      idempotencyKey: "unsafe-key",
      toolName: "shell_run",
      toolVersion: "1.0.0",
      inputHash: "unsafe-hash",
      effects: ["process", "unknown"],
      resumable: false,
    });
    runs.execute({
      type: "run.tool_start",
      runId: "unsafe-run",
      expectedAggregateVersion: 3,
      idempotencyKey: "unsafe-key",
    });

    recoverOnStartup({
      runs,
      notificationQueue: new NotificationQueue(path.join(root, "notifications.jsonl")),
    });

    expect(runs.get("safe-run")).toMatchObject({
      status: "recovery_required",
      recoveryStatus: "recoverable",
      waitReason: { code: "safe_checkpoint_interrupted" },
    });
    expect(runs.get("unsafe-run")).toMatchObject({
      status: "recovery_required",
      recoveryStatus: "decision_required",
      waitReason: {
        code: "uncertain_side_effect",
        details: { idempotencyKeys: ["unsafe-key"], tools: ["shell_run"] },
      },
    });
    expect(runs.getToolLedgerEntry("unsafe-key")).toMatchObject({
      status: "recovery_required",
    });
    database.close();
  });
});

function createRunningRun(runs: RunAggregateRepository, runId: string): void {
  runs.execute({ type: "run.create", runId, kind: "agent", goal: runId });
  runs.execute({ type: "run.start", runId, expectedAggregateVersion: 1 });
}
