import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import {
  buildWorkingMessages,
  runAgentReactLoop,
  type AgentReactLoopContext,
} from "../src/agent/AgentReactLoopRunner.js";
import type { AgentRunSession } from "../src/agent/AgentRunBootstrap.js";
import type { AgentRunFinalizeResult } from "../src/agent/AgentRunFinalizer.js";
import { BudgetManager } from "../src/agent/BudgetManager.js";
import { MODE_BASE_BUDGETS } from "../src/agent/runBudgetDefaults.js";
import type { AgentToolStep } from "../src/agent/toolStep.js";
import type { ChatMessage, ChatRequest } from "../src/model/types.js";
import { ToolRegistry } from "../src/tools/ToolRegistry.js";

describe("Agent finalization reserve", () => {
  it("bounds model working context without breaking an assistant/tool protocol block", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "system ".repeat(3_000) },
      { role: "user", content: "Inspect the project and continue from evidence." },
      {
        role: "assistant",
        content: "assistant-action ".repeat(2_000),
        toolCalls: [{ id: "call-1", name: "inspect", arguments: { value: "one" } }],
      },
      {
        role: "tool",
        name: "inspect",
        toolCallId: "call-1",
        content: "tool-observation ".repeat(2_000),
      },
      { role: "assistant", content: "recent conclusion" },
    ];
    const original = structuredClone(messages);

    const working = buildWorkingMessages(messages, [{
      tool: "read_file",
      input: { path: "src/large.ts", startLine: 101, lineCount: 20 },
      output: {
        path: "src/large.ts",
        startLine: 101,
        endLine: 120,
        sha256: "abc123",
      },
      iteration: 1,
      ok: true,
      executed: true,
    }], "Inspect the project and continue from evidence.");

    expect(messages).toEqual(original);
    expect(working.reduce((sum, message) => sum + message.content.length, 0))
      .toBeLessThanOrEqual(48_000);
    expect(working[0]?.role).toBe("system");
    expect(working[1]?.content).toContain("bounded working-context summary");
    expect(working[1]?.content).toContain('"startLine":101');
    const firstProtocolIndex = working.findIndex((message) => message.toolCallId === "call-1");
    expect(firstProtocolIndex).toBeGreaterThan(0);
    expect(working[firstProtocolIndex - 1]?.role).toBe("assistant");
    expect(working[firstProtocolIndex - 1]?.toolCalls?.[0]?.id).toBe("call-1");
  });

  it("does not execute a tool requested inside the reserved finalization turns", async () => {
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
    const budget = {
      ...MODE_BASE_BUDGETS.chat,
      maxModelTurns: 4,
      maxToolCalls: 8,
      maxReadCalls: 8,
    };
    const manager = new BudgetManager(budget, budget);
    manager.markRunStarted();
    const requests: ChatRequest[] = [];
    const actions = [
      { action: "tool", tool: "inspect", input: { value: "one" } },
      { action: "tool", tool: "inspect", input: { value: "two" } },
      { action: "tool", tool: "inspect", input: { value: "must-not-run" } },
      { action: "final", answer: "Stopped before an unobservable tool call." },
    ];
    let actionIndex = 0;
    const executeToolStep = vi.fn(async (input: {
      steps: AgentToolStep[];
      iteration: number;
      toolCallId: string;
    }) => {
      const step = {
        tool: "inspect",
        input: {},
        output: { value: "ok" },
        iteration: input.iteration,
        toolCallId: input.toolCallId,
        permission: "read",
        ok: true,
        executed: true,
      } as AgentToolStep;
      input.steps.push(step);
      return { kind: "step" as const, step };
    });
    const finishRun = vi.fn(async (input) => input as unknown as AgentRunFinalizeResult);
    const context = {
      chat: async (request: ChatRequest) => {
        requests.push(request);
        return {
          content: JSON.stringify(actions[actionIndex++]),
          toolCalls: [],
          clientName: "test",
          modelName: "test",
          location: "local",
          latencyMs: 1,
        } as const;
      },
      registry,
      workspaceRoot: "E:\\workspace",
      allowedToolNames: ["inspect"],
      maxModelTurns: 4,
      budgetManager: manager,
      policy: {
        mode: "chat",
        requiredSideEffects: [],
      },
      capabilityEscalations: [],
      completionCriteria: [],
      getEffectiveIntent: () => "answer",
      getReconciledIntent: () => undefined,
      getModelTurnMetrics: () => [],
      recordModelTurn: () => undefined,
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
      buildPartialAnswer: () => "partial",
      finishRun,
    } as AgentReactLoopContext;
    const session = {
      effectiveGoal: "Inspect twice, then summarize",
      messages: [{ role: "user", content: "Inspect twice, then summarize" }],
      steps: [],
      modelTurns: 0,
      consumedNotifications: [],
      injectNotifications: () => undefined,
    } satisfies AgentRunSession;

    await runAgentReactLoop(context, session);

    expect(executeToolStep).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(4);
    expect(requests[0]?.tools).toHaveLength(1);
    expect(requests[1]?.tools).toHaveLength(1);
    expect(requests[2]?.tools).toEqual([]);
    expect(requests[3]?.tools).toEqual([]);
    expect(requests[2]?.messages.at(-1)?.content).toContain("Finalization-only phase");
  });
});
