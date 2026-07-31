import { describe, expect, it } from "vitest";

import { PlanSchema } from "../src/agent/types.js";
import { resolvePlanExecutionMode } from "../src/orchestrator/PlanExecutionService.js";
import { bindPlanTools } from "../src/plan/planToolBinder.js";
import { ToolRegistry } from "../src/tools/ToolRegistry.js";

describe("Plan tool binding safety", () => {
  it("never fabricates write content or an empty patch for an ambiguous side-effect step", () => {
    const plan = PlanSchema.parse({
      goal: "Modify an existing file",
      steps: [{
        id: "write-1",
        title: "修改 src/index.ts",
        requiredPermissions: ["write"],
      }],
    });

    expect(() => bindPlanTools(plan, { registry: new ToolRegistry() }))
      .toThrow("unsafe_inferred_side_effect_binding:write-1");
  });

  it("binds a read-only fallback to an explicit bounded range", () => {
    const plan = PlanSchema.parse({
      goal: "Inspect a file",
      steps: [{
        id: "read-1",
        title: "Inspect src/index.ts",
        requiredPermissions: ["read"],
        requiredContext: ["src/index.ts"],
      }],
    });

    const bound = bindPlanTools(plan, { registry: new ToolRegistry() });

    expect(bound.steps[0]).toMatchObject({
      tool: "read_file",
      toolInput: {
        path: "src/index.ts",
        startLine: 1,
        lineCount: 200,
      },
    });
  });

  it("defaults side-effect plans to Agent-loop execution while preserving explicit overrides", () => {
    const writePlan = PlanSchema.parse({
      goal: "Create a file",
      steps: [{
        id: "write-1",
        title: "Create src/new.ts",
        requiredPermissions: ["write"],
        tool: "write_file",
        toolInput: { path: "src/new.ts", content: "export {};" },
      }],
    });
    const readPlan = PlanSchema.parse({
      goal: "Inspect a file",
      steps: [{
        id: "read-1",
        title: "Inspect package.json",
        requiredPermissions: ["read"],
        tool: "read_file",
        toolInput: { path: "package.json", startLine: 1, lineCount: 200 },
      }],
    });

    expect(resolvePlanExecutionMode(writePlan)).toBe("agent_loop");
    expect(resolvePlanExecutionMode(readPlan)).toBe("static");
    expect(resolvePlanExecutionMode(writePlan, "static")).toBe("static");
  });
});
