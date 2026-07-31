import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DatabaseManager } from "../src/context/DatabaseManager.js";
import { AgentRunLifecycle } from "../src/orchestrator/AgentRunLifecycle.js";
import { RunStateStore } from "../src/orchestrator/RunStateStore.js";
import { RunAggregateRepository } from "../src/run/RunAggregateRepository.js";

const roots: string[] = [];

describe("AgentRunLifecycle resume failure", () => {
  let database: DatabaseManager;
  let runs: RunAggregateRepository;

  beforeEach(() => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ariadne-resume-lifecycle-"));
    roots.push(root);
    database = new DatabaseManager(root);
    runs = new RunAggregateRepository(database);
  });

  afterEach(() => {
    database.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("moves a safe resume error to recoverable instead of requesting permission again", () => {
    startRun("safe-run");
    const lifecycle = createLifecycle();

    const result = lifecycle.finalizeResumeFailure(
      context("safe-run"),
      new Error("provider unavailable"),
    );

    expect(result).toMatchObject({
      retryable: true,
      recoveryStatus: "recoverable",
    });
    expect(runs.get("safe-run")).toMatchObject({
      status: "recovery_required",
      recoveryStatus: "recoverable",
      waitReason: expect.objectContaining({ message: "provider unavailable" }),
    });
  });

  it("requires a user disposition when a non-resumable effect may have started", () => {
    startRun("unsafe-run");
    let current = runs.get("unsafe-run")!;
    runs.execute({
      type: "run.tool_intent",
      runId: current.id,
      expectedAggregateVersion: current.aggregateVersion,
      idempotencyKey: "unsafe-effect",
      toolName: "shell_run",
      toolVersion: "1.0.0",
      inputHash: "hash",
      effects: ["process"],
      resumable: false,
    });
    current = runs.get("unsafe-run")!;
    runs.execute({
      type: "run.tool_start",
      runId: current.id,
      expectedAggregateVersion: current.aggregateVersion,
      idempotencyKey: "unsafe-effect",
    });

    const result = createLifecycle().finalizeResumeFailure(
      context("unsafe-run"),
      new Error("transport interrupted"),
    );

    expect(result).toMatchObject({
      retryable: false,
      recoveryStatus: "decision_required",
    });
    expect(runs.get("unsafe-run")).toMatchObject({
      status: "recovery_required",
      recoveryStatus: "decision_required",
    });
  });

  function startRun(runId: string): void {
    const created = runs.execute({
      type: "run.create",
      runId,
      kind: "agent",
      goal: "test resume",
    });
    runs.execute({
      type: "run.start",
      runId,
      expectedAggregateVersion: created.aggregateVersion,
    });
  }

  function createLifecycle(): AgentRunLifecycle {
    return new AgentRunLifecycle({
      runs,
      runStateStore: new RunStateStore(database),
      taskService: { applyStateTransition: vi.fn() },
    });
  }
});

function context(runId: string) {
  return {
    run: { id: runId },
    task: {
      id: `task-${runId}`,
      title: "test",
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  } as Parameters<AgentRunLifecycle["finalizeResumeFailure"]>[0];
}
