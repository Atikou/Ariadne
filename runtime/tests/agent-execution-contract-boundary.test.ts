import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { AgentLoop } from "../src/agent/AgentLoop.js";
import type { AgentRunnerPort } from "../src/agent/AgentRunResultContracts.js";
import {
  AgentExecutionEngineRegistry,
  type AgentExecutionEngineFactory,
} from "../src/orchestrator/AgentExecutionEngine.js";
import { AgentLoopFactory } from "../src/orchestrator/AgentLoopFactory.js";
import type { AgentLoopCreationRequest } from "../src/orchestrator/AgentLoopCreationContracts.js";
import { SubAgentWorkflow } from "../src/subagent/SubAgentWorkflow.js";
import type { SubAgentWorkflowPort } from "../src/subagent/SubAgentWorkflowContracts.js";

describe("agent execution contract boundary", () => {
  it("keeps concrete implementations assignable to their one-way ports", () => {
    expectTypeOf<AgentLoop>().toMatchTypeOf<AgentRunnerPort>();
    expectTypeOf<AgentLoopFactory>().toMatchTypeOf<AgentExecutionEngineFactory>();
    expectTypeOf<SubAgentWorkflow>().toMatchTypeOf<SubAgentWorkflowPort>();
  });

  it("selects engines through contracts without importing Loop or Factory implementations", async () => {
    const run = vi.fn(async () => ({ answer: "ok" }));
    const factory: AgentExecutionEngineFactory = {
      kind: "graph",
      create: () => ({ run: run as AgentRunnerPort["run"] }),
    };
    const registry = new AgentExecutionEngineRegistry([factory], "graph");
    const engine = registry.create({} as AgentLoopCreationRequest);

    await engine.run("hello");

    expect(run).toHaveBeenCalledWith("hello");
  });

  it("keeps the former feedback edges pointed at neutral contracts", () => {
    expect(readSource("tools/types.ts")).not.toContain("subagent/SubAgentWorkflow.js");
    expect(readSource("orchestrator/runStateTypes.ts")).not.toContain("AgentExecutionEngine.js");

    const engineSource = readSource("orchestrator/AgentExecutionEngine.ts");
    expect(engineSource).not.toContain("agent/AgentLoop.js");
    expect(engineSource).not.toContain("AgentLoopFactory.js");

    const factorySource = readSource("orchestrator/AgentLoopFactory.ts");
    expect(factorySource).not.toContain('from "./AgentExecutionEngine.js"');

    for (const relativePath of [
      "subagent/SubAgentRunner.ts",
      "subagent/SubAgentCoordinator.ts",
      "subagent/SubAgentArbitrator.ts",
      "subagent/singleShot.ts",
    ]) {
      expect(readSource(relativePath), relativePath).not.toContain("agent/AgentLoop.js");
    }
  });

  it("keeps concrete AgentLoop construction in the composition root", () => {
    expect(readSource("app/createAppContext.ts")).toContain("new AgentLoop(request)");
    expect(readSource("subagent/SubAgentRunner.ts")).not.toContain("new AgentLoop(");
  });
});

function readSource(relativePath: string): string {
  const absolutePath = fileURLToPath(new URL(`../src/${relativePath}`, import.meta.url));
  return readFileSync(absolutePath, "utf8");
}
