import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import {
  runAgentReactLoop,
  type AgentReactLoopContext,
} from "../src/agent/AgentReactLoopRunner.js";
import type { AgentRunSession } from "../src/agent/AgentRunBootstrap.js";
import type { AgentRunFinalizeResult } from "../src/agent/AgentRunFinalizer.js";
import { BudgetManager } from "../src/agent/BudgetManager.js";
import { MODE_BASE_BUDGETS } from "../src/agent/runBudgetDefaults.js";
import type { AgentToolStep } from "../src/agent/toolStep.js";
import { ToolRegistry } from "../src/tools/ToolRegistry.js";

describe("Agent cost limit", () => {
  it("keeps the paid response but does not execute an unobservable tool after the cap", async () => {
    const registry = new ToolRegistry().register({
      name: "inspect",
      version: "1.0.0",
      description: "Inspect a value",
      inputSchema: z.object({ value: z.string() }).strict(),
      outputSchema: z.object({ value: z.string() }).strict(),
      permissions: ["read"],
      resourceScopes: ["workspace"],
      effects: ["workspace_read"],
      risk: "low",
      parallelism: "parallel_safe",
      idempotency: "idempotent",
      dataSensitivity: "workspace",
      egress: ["model"],
      timeoutMs: 1_000,
      supportsResume: true,
      providerId: "test",
      async execute(input) {
        return input;
      },
    });
    const budget = { ...MODE_BASE_BUDGETS.chat, maxModelTurns: 4 };
    const manager = new BudgetManager(budget, budget);
    manager.markRunStarted();
    const executeToolStep = vi.fn();
    const finishRun = vi.fn(async (input) => input as unknown as AgentRunFinalizeResult);
    const modelTurnMetrics: Array<{ costUsd?: number }> = [];
    const context = {
      chat: async () => ({
        content: JSON.stringify({
          action: "tool",
          tool: "inspect",
          input: { value: "must-not-run" },
        }),
        toolCalls: [],
        clientName: "test",
        modelName: "test",
        location: "local",
        latencyMs: 1,
        costUsd: 0.01,
      } as const),
      registry,
      workspaceRoot: "E:\\workspace",
      allowedToolNames: ["inspect"],
      maxCostUsdPerRun: 0.01,
      maxModelTurns: 4,
      budgetManager: manager,
      policy: { mode: "chat", requiredSideEffects: [] },
      capabilityEscalations: [],
      completionCriteria: [],
      getEffectiveIntent: () => "answer",
      getReconciledIntent: () => undefined,
      getModelTurnMetrics: () => modelTurnMetrics,
      recordModelTurn: (metric: { costUsd?: number }) => {
        modelTurnMetrics.push({ costUsd: metric.costUsd });
      },
      setRunRoutingMeta: () => undefined,
      getRunRoutingMeta: () => undefined,
      assertNotCancelled: () => undefined,
      isCancelledError: () => false,
      makeToolCallId: (iteration: number) => `call-${iteration}`,
      writeAgentDecisionTrace: () => undefined,
      createPlanHandoff: () => null,
      executeToolStep,
      recordToolBatchObservations: () => undefined,
      continueAfterRecordedToolBatch: async () => ({ kind: "continue" as const }),
      buildPartialAnswer: () => "Existing verified progress.",
      finishRun,
    } as AgentReactLoopContext;
    const session = {
      effectiveGoal: "Inspect once",
      messages: [{ role: "user", content: "Inspect once" }],
      steps: [] as AgentToolStep[],
      modelTurns: 0,
      consumedNotifications: [],
      injectNotifications: () => undefined,
    } satisfies AgentRunSession;

    const result = await runAgentReactLoop(context, session);

    expect(executeToolStep).not.toHaveBeenCalled();
    expect(finishRun).toHaveBeenCalledWith(expect.objectContaining({
      stopReason: "blocked_by_policy",
      reachedLimit: false,
      answer: expect.stringContaining("cost limit"),
    }));
    expect(result).toMatchObject({ stopReason: "blocked_by_policy" });
    expect(modelTurnMetrics).toEqual([{ costUsd: 0.01 }]);
  });
});
