import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AgentEvalHarness,
  DEFAULT_AGENT_EVAL_SCENARIOS,
  type AgentEvalExecution,
} from "../src/eval/index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe("AgentEvalHarness", () => {
  it("covers every required P0 scenario in isolated temporary workspaces", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "ariadne-eval-test-"));
    temporaryRoots.push(base);
    const observedRoots: string[] = [];
    const harness = new AgentEvalHarness(async ({ scenario, workspaceRoots }) => {
      observedRoots.push(...workspaceRoots);
      const execution: AgentEvalExecution = {
        status: scenario.expected.mustRecover ? "recovery_required" : "completed",
        changedFiles: scenario.expected.mayWrite ? [path.join(workspaceRoots[0]!, "changed.ts")] : [],
        toolCalls: 2,
        cost: 0.01,
        permissionRequested: scenario.expected.mustRequestPermission,
        recoveryObserved: scenario.expected.mustRecover,
        injectedInstructionFollowed: false,
        conflictDetected: scenario.expected.mustDetectConflict,
      };
      return execution;
    }, base);

    const result = await harness.run(DEFAULT_AGENT_EVAL_SCENARIOS, {
      commit: "test-commit",
      provider: "fixture",
      model: "fixture-model",
      config: { b: 2, a: 1 },
    });

    expect(result.cases).toHaveLength(11);
    expect(new Set(result.cases.map((item) => item.category)).size).toBe(11);
    expect(result.successRate).toBe(1);
    expect(result.totalToolCalls).toBe(22);
    expect(result.totalCost).toBeCloseTo(0.11);
    expect(result.configFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    for (const root of observedRoots) {
      await expect(access(root)).rejects.toThrow();
    }
  });

  it("fails a case when a changed file escapes the isolated workspace", async () => {
    const harness = new AgentEvalHarness(async () => ({
      status: "completed",
      changedFiles: [path.resolve(os.tmpdir(), "outside.ts")],
      toolCalls: 1,
    }));
    const result = await harness.run([DEFAULT_AGENT_EVAL_SCENARIOS[0]!], {
      commit: "test",
      provider: "fixture",
      model: "fixture",
      config: {},
    });
    expect(result.cases[0]?.success).toBe(false);
    expect(result.cases[0]?.verifierResults).toContainEqual(
      expect.objectContaining({ name: "workspace_isolation", passed: false }),
    );
  });
});
