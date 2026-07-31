import { describe, expect, it } from "vitest";

import { RunPolicyManager } from "../src/agent/RunPolicyManager.js";
import { MODE_BASE_BUDGETS } from "../src/agent/runBudgetDefaults.js";
import { resolveSuggestedToolCalls } from "../src/agent/taskComplexity.js";

describe("Run policy budget sizing", () => {
  it("keeps Plan tools read-only while preserving the desktop policy for approved execution", () => {
    const manager = new RunPolicyManager();
    const plan = manager.resolve({
      requestedMode: "plan",
      forceMode: true,
      requestedPermissionPolicy: "confirmBeforeRun",
      message: "Implement the requested feature after planning it",
    });
    const implementation = manager.resolve({
      requestedMode: "implement",
      forceMode: true,
      requestedPermissionPolicy: plan.permissionPolicy,
      message: "Implement the requested feature after planning it",
    });

    expect(plan).toMatchObject({
      mode: "plan",
      permissionPolicy: "confirmBeforeRun",
      allowedPermissions: ["read"],
    });
    expect(implementation.allowedPermissions).toEqual(
      expect.arrayContaining(["read", "write"]),
    );
  });

  it("sizes a high-complexity run before execution instead of waiting for an avoidable stop", () => {
    const policy = new RunPolicyManager().resolve({
      requestedMode: "implement",
      forceMode: true,
      message: "全项目端到端排查多模块架构问题，修复后运行完整回归测试",
    });

    expect(policy.complexityTier).toBe("high");
    expect(policy.budget.maxModelTurns)
      .toBeGreaterThan(MODE_BASE_BUDGETS.implement.maxModelTurns);
    expect(policy.budget.maxToolCalls)
      .toBeGreaterThan(MODE_BASE_BUDGETS.implement.maxToolCalls);
    expect(policy.budget.maxReadCalls)
      .toBeGreaterThan(MODE_BASE_BUDGETS.implement.maxReadCalls);
  });

  it("keeps an explicit user budget authoritative", () => {
    const policy = new RunPolicyManager().resolve({
      requestedMode: "implement",
      forceMode: true,
      message: "全项目端到端排查多模块架构问题",
      budget: {
        maxModelTurns: 10,
        maxToolCalls: 12,
        maxReadCalls: 8,
      },
    });

    expect(policy.budget).toMatchObject({
      maxModelTurns: 10,
      maxToolCalls: 12,
      maxReadCalls: 8,
    });
  });

  it("adds a small progress margin after tool exhaustion instead of blindly doubling", () => {
    const resolved = resolveSuggestedToolCalls({
      goal: "修复一个模块中的错误",
      mode: "implement",
      budgetExhausted: "maxToolCalls",
      currentBudget: { ...MODE_BASE_BUDGETS.implement, maxToolCalls: 40 },
      modeSuggestedToolCalls: 40,
      usedToolCalls: 40,
    });

    expect(resolved.suggestedToolCalls).toBe(44);
  });
});
