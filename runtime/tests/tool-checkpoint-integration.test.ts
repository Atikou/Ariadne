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
    database.close();
  });
});
