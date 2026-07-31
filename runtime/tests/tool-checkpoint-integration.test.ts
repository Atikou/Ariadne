import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";

import {
  ToolExecutionGateway,
  defaultWorkflowRouteForTaskTool,
} from "../src/agent/ToolExecutionGateway.js";
import { DatabaseManager } from "../src/context/DatabaseManager.js";
import { RunAggregateRepository } from "../src/run/RunAggregateRepository.js";
import { RunToolCheckpointCoordinator } from "../src/run/RunToolCheckpointCoordinator.js";
import { WORKSPACE_READ_CONTRACT } from "../src/tools/contractProfiles.js";
import { ToolRegistry } from "../src/tools/ToolRegistry.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("tool checkpoint integration", () => {
  it("rearms a started resumable checkpoint and completes it exactly once after recovery", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ariadne-tool-retry-"));
    temporaryRoots.push(root);
    const database = new DatabaseManager(root);
    const runs = new RunAggregateRepository(database);
    runs.execute({ type: "run.create", runId: "run-retry", kind: "agent", goal: "Recover" });
    runs.execute({ type: "run.start", runId: "run-retry", expectedAggregateVersion: 1 });

    const coordinator = new RunToolCheckpointCoordinator(runs, "run-retry");
    const first = coordinator.intend({
      toolCallId: "call-retry",
      toolName: "echo",
      toolVersion: "1.0.0",
      input: { value: "ok" },
      effects: ["workspace_read"],
      resumable: true,
    });
    expect(first.kind).toBe("execute");
    if (first.kind !== "execute") throw new Error("expected executable checkpoint");
    coordinator.start(first.token);

    let current = runs.get("run-retry")!;
    runs.execute({
      type: "run.require_recovery",
      runId: current.id,
      expectedAggregateVersion: current.aggregateVersion,
      recoverable: true,
      reason: { code: "process_interrupted", message: "restart" },
    });
    current = runs.get("run-retry")!;
    runs.execute({
      type: "run.start",
      runId: current.id,
      expectedAggregateVersion: current.aggregateVersion,
    });

    const retried = coordinator.intend({
      toolCallId: "call-retry",
      toolName: "echo",
      toolVersion: "1.0.0",
      input: { value: "ok" },
      effects: ["workspace_read"],
      resumable: true,
    });
    expect(retried.kind).toBe("execute");
    if (retried.kind !== "execute") throw new Error("expected rearmed checkpoint");
    expect(runs.getToolLedgerEntry(retried.token.idempotencyKey)).toMatchObject({
      status: "intended",
    });

    coordinator.start(retried.token);
    coordinator.finish(retried.token, {
      tool: "echo",
      toolCallId: "call-retry",
      durationMs: 1,
      executed: true,
      outcomeClass: "observation_success",
      outcomeKind: "ok",
      message: "ok",
      recoverable: false,
      output: { value: "ok" },
      ok: true,
    });

    expect(runs.getToolLedgerEntry(retried.token.idempotencyKey)).toMatchObject({
      status: "succeeded",
      output: { value: "ok" },
    });
    expect(runs.listToolLedger("run-retry")).toHaveLength(1);
    expect(runs.get("run-retry")?.state.inFlightEffects).toEqual([]);
    database.close();
  });

  it("records intent and start before execution, then validates and records the result", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ariadne-tool-checkpoint-"));
    temporaryRoots.push(root);
    const database = new DatabaseManager(root);
    const runs = new RunAggregateRepository(database);
    runs.execute({ type: "run.create", runId: "run-1", kind: "agent", goal: "Echo" });
    runs.execute({
      type: "run.start",
      runId: "run-1",
      expectedAggregateVersion: 1,
    });

    const observedStages: string[] = [];
    let executionCount = 0;
    const inputSchema = z.object({ value: z.string() }).strict();
    const outputSchema = z.object({ value: z.string() }).strict();
    const registry = new ToolRegistry().register({
      ...WORKSPACE_READ_CONTRACT,
      name: "echo",
      description: "Echo",
      providerId: "test",
      inputSchema,
      outputSchema,
      execute: async (input) => {
        executionCount += 1;
        observedStages.push(runs.get("run-1")!.checkpointStage);
        return input;
      },
    });
    const gateway = new ToolExecutionGateway(
      registry,
      new RunToolCheckpointCoordinator(runs, "run-1"),
    );

    const result = await gateway.run({
      toolName: "echo",
      input: { value: "ok" },
      source: "agent_loop",
      budgetBucket: "main",
      workspaceRoot: root,
      requestId: "run-1",
      toolCallId: "call-1",
      allowedPermissions: ["read"],
      intent: "answer",
      permissionPolicy: "autoRun",
      mode: "task",
      workflowRoute: defaultWorkflowRouteForTaskTool("read"),
    });

    expect(result).toMatchObject({ ok: true, output: { value: "ok" } });
    expect(observedStages).toEqual(["tool_started"]);
    expect(runs.get("run-1")).toMatchObject({
      checkpointStage: "tool_succeeded",
      aggregateVersion: 5,
    });
    expect(runs.listToolLedger("run-1")).toEqual([
      expect.objectContaining({
        toolName: "echo",
        status: "succeeded",
        inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);

    const replayed = await gateway.run({
      toolName: "echo",
      input: { value: "ok" },
      source: "resume",
      budgetBucket: "resume",
      workspaceRoot: root,
      requestId: "run-1",
      toolCallId: "call-1",
      allowedPermissions: ["read"],
      intent: "answer",
      permissionPolicy: "autoRun",
      mode: "task",
      workflowRoute: defaultWorkflowRouteForTaskTool("read"),
    });

    expect(replayed).toMatchObject({
      ok: true,
      executed: true,
      toolCallId: "call-1",
      outcomeKind: "idempotent_replay",
      output: { value: "ok" },
    });
    expect(executionCount).toBe(1);
    expect(runs.get("run-1")).toMatchObject({
      checkpointStage: "tool_succeeded",
      aggregateVersion: 5,
    });
    expect(runs.listToolLedger("run-1")).toHaveLength(1);
    database.close();
  });
});
