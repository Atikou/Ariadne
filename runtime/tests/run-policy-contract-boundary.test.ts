import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  parseRunModeValue,
  parseUserPermissionPolicyValue,
} from "../src/agent/RunPolicyPrimitives.js";
import { WORKFLOW_TOOL_NAMES as plannerToolNames } from "../src/agent/WorkflowPlanner.js";
import { WORKFLOW_TOOL_NAMES as contractToolNames } from "../src/agent/WorkflowPlanningContracts.js";

const NEUTRAL_CONTRACT_FILES = [
  "agent/AgentExecutionMetaContracts.ts",
  "agent/CapabilityEscalationContracts.ts",
  "agent/RunPolicyContracts.ts",
  "agent/RunPolicyPrimitives.ts",
  "agent/ToolStepContracts.ts",
  "agent/WorkflowExecutionContracts.ts",
  "agent/WorkflowPlanningContracts.ts",
  "agent/WorkflowStateContracts.ts",
  "agent/completion/CompletionContracts.ts",
  "agent/completion/ToolLedgerContracts.ts",
  "agent/presentation/ExecutionPresentationContracts.ts",
  "agent/routing/IntentDecisionContracts.ts",
] as const;

describe("Run policy contract boundary", () => {
  it("uses canonical parser and workflow-planning values", () => {
    expect(plannerToolNames).toBe(contractToolNames);
    expect(parseRunModeValue(" IMPLEMENT ")).toBe("implement");
    expect(parseUserPermissionPolicyValue("autoRun")).toBe("autoRun");
  });

  it("keeps neutral contracts independent from former implementation owners", () => {
    const forbiddenImplementationImports = [
      "WorkflowStateCenter.js",
      "WorkflowPlanner.js",
      "CapabilityEscalation.js",
      "completion/CompletionEvidence.js",
      "completion/CompletionFinalGuard.js",
      "completion/TaskCompletionContract.js",
      "completion/ToolLedger.js",
      "presentation/ExecutionStatePresenter.js",
      "routing/IntentDecision.js",
      "toolStep.js",
    ];

    for (const relativePath of NEUTRAL_CONTRACT_FILES) {
      const source = readSource(relativePath);
      for (const forbidden of forbiddenImplementationImports) {
        expect(source, `${relativePath} -> ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("keeps the RunPolicy public API explicit and owned", () => {
    const source = readSource("agent/RunPolicy.ts");
    expect(source).toContain('from "./RunPolicyContracts.js"');
    expect(source).toContain('from "./RunPolicyPrimitives.js"');
    expect(source).not.toMatch(/export\s+(?:type\s+)?\*/u);
  });
});

function readSource(relativePath: string): string {
  const absolutePath = fileURLToPath(new URL(`../src/${relativePath}`, import.meta.url));
  return readFileSync(absolutePath, "utf8");
}
