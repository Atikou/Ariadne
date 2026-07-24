import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DatabaseManager } from "../src/context/DatabaseManager.js";
import {
  ConcurrentRunModificationError,
  IllegalRunTransitionError,
  RunAggregateRepository,
} from "../src/run/RunAggregateRepository.js";
import { PlanAgentStepBindingStore } from "../src/plan/PlanAgentStepBindingStore.js";

const temporaryRoots: string[] = [];

describe("RunAggregateRepository", () => {
  let database: DatabaseManager;
  let repository: RunAggregateRepository;

  beforeEach(() => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ariadne-run-aggregate-"));
    temporaryRoots.push(root);
    database = new DatabaseManager(root);
    repository = new RunAggregateRepository(database);
  });

  afterEach(() => {
    database.close();
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates versioned state, its checkpoint, and its domain event atomically", () => {
    const created = repository.execute({
      type: "run.create",
      runId: "run-1",
      kind: "agent",
      goal: "Inspect the workspace",
      correlationId: "correlation-1",
    });

    expect(created).toMatchObject({
      id: "run-1",
      status: "pending",
      aggregateVersion: 1,
      checkpointStage: "created",
      recoveryStatus: "none",
    });
    expect(repository.listCheckpoints("run-1")).toEqual([
      expect.objectContaining({
        runId: "run-1",
        aggregateVersion: 1,
        stage: "created",
      }),
    ]);
    expect(repository.replayEvents({ afterCursor: 0, limit: 100 })).toEqual([
      expect.objectContaining({
        cursor: 1,
        schemaVersion: "2.0",
        aggregateType: "run",
        aggregateId: "run-1",
        aggregateVersion: 1,
        correlationId: "correlation-1",
        event: expect.objectContaining({ kind: "run.created" }),
      }),
    ]);
  });

  it("rejects stale commands instead of overwriting a newer aggregate", () => {
    repository.execute({
      type: "run.create",
      runId: "run-1",
      kind: "agent",
      goal: "Inspect the workspace",
    });
    repository.execute({
      type: "run.start",
      runId: "run-1",
      expectedAggregateVersion: 1,
    });

    expect(() =>
      repository.execute({
        type: "run.complete",
        runId: "run-1",
        expectedAggregateVersion: 1,
        result: { summary: "stale result" },
      }),
    ).toThrow(ConcurrentRunModificationError);

    expect(repository.get("run-1")).toMatchObject({
      status: "running",
      aggregateVersion: 2,
    });
    expect(repository.replayEvents({ afterCursor: 0, limit: 100 })).toHaveLength(2);
  });

  it("rejects illegal terminal-state transitions without writing a checkpoint or event", () => {
    repository.execute({
      type: "run.create",
      runId: "run-1",
      kind: "agent",
      goal: "Inspect the workspace",
    });
    repository.execute({
      type: "run.start",
      runId: "run-1",
      expectedAggregateVersion: 1,
    });
    repository.execute({
      type: "run.complete",
      runId: "run-1",
      expectedAggregateVersion: 2,
      result: { summary: "done" },
    });

    expect(() =>
      repository.execute({
        type: "run.start",
        runId: "run-1",
        expectedAggregateVersion: 3,
      }),
    ).toThrow(IllegalRunTransitionError);

    expect(repository.get("run-1")).toMatchObject({
      status: "completed",
      aggregateVersion: 3,
    });
    expect(repository.listCheckpoints("run-1")).toHaveLength(3);
    expect(repository.replayEvents({ afterCursor: 0, limit: 100 })).toHaveLength(3);
  });

  it("replays a stable cursor in pages and records consumer progress monotonically", () => {
    repository.execute({
      type: "run.create",
      runId: "run-1",
      kind: "agent",
      goal: "Inspect the workspace",
    });
    repository.execute({
      type: "run.start",
      runId: "run-1",
      expectedAggregateVersion: 1,
    });
    repository.execute({
      type: "run.pause",
      runId: "run-1",
      expectedAggregateVersion: 2,
      reason: { code: "budget_exhausted", message: "Token budget exhausted" },
    });

    const firstPage = repository.replayEvents({ afterCursor: 0, limit: 2 });
    const secondPage = repository.replayEvents({
      afterCursor: firstPage.at(-1)!.cursor,
      limit: 2,
    });

    expect(firstPage.map((event) => event.cursor)).toEqual([1, 2]);
    expect(secondPage.map((event) => event.cursor)).toEqual([3]);

    repository.acknowledgeConsumer("renderer", 3);
    repository.acknowledgeConsumer("renderer", 2);
    expect(repository.getConsumerCursor("renderer")).toBe(3);
  });

  it("cuts run state and child-plan foreign keys over to run_aggregates", () => {
    repository.execute({
      type: "run.create",
      runId: "parent-run",
      kind: "plan",
      goal: "Parent plan",
    });
    repository.execute({
      type: "run.create",
      runId: "child-run",
      kind: "agent",
      goal: "Child step",
      parentRunId: "parent-run",
    });

    const now = new Date().toISOString();
    database.connection.prepare(
      `INSERT INTO run_states(
        run_id, mode, goal, status, state_json, created_at, updated_at
      ) VALUES (?, 'task', ?, 'resumable', '{}', ?, ?)`,
    ).run("child-run", "Child step", now, now);

    const binding = new PlanAgentStepBindingStore(database.connection).createWaiting({
      planId: "plan-1",
      planVersion: 1,
      planRunId: "parent-run",
      parentRunId: "parent-run",
      parentTaskId: "task-1",
      stepId: "step-1",
      stepRowId: "row-1",
      childRunId: "child-run",
      payload: {
        schemaVersion: 1,
        executionMode: "agent_loop",
        rollbackOnFailure: true,
        fallbackToPlanOnUncertainty: true,
      },
    });

    expect(binding.childRunId).toBe("child-run");
    expect(database.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      database.connection
        .prepare("PRAGMA foreign_key_list(run_states)")
        .all(),
    ).toContainEqual(expect.objectContaining({ table: "run_aggregates" }));
    expect(
      database.connection
        .prepare("PRAGMA foreign_key_list(plan_agent_step_bindings)")
        .all(),
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "run_aggregates", from: "parent_run_id" }),
      expect.objectContaining({ table: "run_aggregates", from: "child_run_id" }),
    ]));
  });

  it("commits tool intent, start, result, checkpoints, ledger, and events atomically", () => {
    repository.execute({
      type: "run.create",
      runId: "run-tools",
      kind: "agent",
      goal: "Read files",
    });
    repository.execute({
      type: "run.start",
      runId: "run-tools",
      expectedAggregateVersion: 1,
    });
    repository.execute({
      type: "run.tool_intent",
      runId: "run-tools",
      expectedAggregateVersion: 2,
      idempotencyKey: "run-tools:read-file:1",
      toolName: "read_file",
      toolVersion: "1.0.0",
      inputHash: "abc123",
      effects: ["workspace_read"],
      resumable: true,
    });
    repository.execute({
      type: "run.tool_start",
      runId: "run-tools",
      expectedAggregateVersion: 3,
      idempotencyKey: "run-tools:read-file:1",
    });
    const completed = repository.execute({
      type: "run.tool_result",
      runId: "run-tools",
      expectedAggregateVersion: 4,
      idempotencyKey: "run-tools:read-file:1",
      status: "succeeded",
      output: { path: "README.md", sha256: "def456" },
      verification: { kind: "output_schema", passed: true },
    });

    expect(completed).toMatchObject({
      aggregateVersion: 5,
      checkpointStage: "tool_succeeded",
      state: { inFlightEffects: [] },
    });
    expect(repository.listToolLedger("run-tools")).toEqual([
      expect.objectContaining({
        idempotencyKey: "run-tools:read-file:1",
        status: "succeeded",
        aggregateVersion: 5,
        output: { path: "README.md", sha256: "def456" },
      }),
    ]);
    expect(repository.listCheckpoints("run-tools").map((checkpoint) => checkpoint.stage))
      .toEqual(["created", "running", "tool_intended", "tool_started", "tool_succeeded"]);
    expect(repository.replayEvents({ afterCursor: 0, limit: 20 }).map((event) => event.event.kind))
      .toEqual([
        "run.created",
        "run.started",
        "run.tool_intended",
        "run.tool_started",
        "run.tool_succeeded",
      ]);

    expect(() =>
      repository.execute({
        type: "run.tool_intent",
        runId: "run-tools",
        expectedAggregateVersion: 5,
        idempotencyKey: "run-tools:read-file:1",
        toolName: "read_file",
        toolVersion: "1.0.0",
        inputHash: "different",
        effects: ["workspace_read"],
        resumable: true,
      }),
    ).toThrow("tool_idempotency_conflict");
    expect(repository.get("run-tools")?.aggregateVersion).toBe(5);
  });
});
