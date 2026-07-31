import { describe, expect, it } from "vitest";

import type { AgentExecutionMeta, RunBudgetUsage } from "../src/agent/RunPolicyTypes.js";
import { renderResumeCheckpoint } from "../src/agent/AgentRunBootstrap.js";
import { MODE_BASE_BUDGETS } from "../src/agent/runBudgetDefaults.js";
import {
  buildRunStateFromAgentRun,
  type RunState,
} from "../src/orchestrator/runStateTypes.js";

describe("budget checkpoint", () => {
  it("persists a resumable checkpoint even when no fixed workflow has pending steps", () => {
    const state = buildRunStateFromAgentRun({
      runId: "run-answer-budget",
      goal: "Explain the current architecture",
      mode: "chat",
      steps: [],
      executionMeta: executionMeta(usage({ modelTurns: 8 })),
    });

    expect(state).toMatchObject({
      checkpointVersion: 1,
      runId: "run-answer-budget",
      status: "resumable",
      completedSteps: [],
      pendingSteps: [],
      budgetExhausted: "maxModelTurns",
      suggestedBudget: MODE_BASE_BUDGETS.chat,
    });
  });

  it("keeps lifetime model/runtime usage while a resumed slice reuses prior tool steps", () => {
    const prior = {
      budgetUsage: usage({
        modelTurns: 8,
        runtimeMs: 10_000,
        toolCalls: 3,
        readCalls: 3,
      }),
    } as RunState;
    const state = buildRunStateFromAgentRun({
      runId: "run-resumed-budget",
      goal: "Continue the edit",
      mode: "implement",
      steps: [],
      priorState: prior,
      executionMeta: executionMeta(usage({
        modelTurns: 4,
        runtimeMs: 5_000,
        toolCalls: 3,
        readCalls: 3,
      })),
    });

    expect(state?.budgetUsage).toMatchObject({
      modelTurns: 12,
      mainModelTurns: 12,
      runtimeMs: 15_000,
      toolCalls: 3,
      readCalls: 3,
    });
  });

  it("persists exact file ranges and hashes so resume does not reread unchanged content", () => {
    const state = buildRunStateFromAgentRun({
      runId: "run-range-checkpoint",
      goal: "Inspect a large source file",
      mode: "review",
      steps: [{
        tool: "read_file",
        input: { path: "src/large.ts", startLine: 201, lineCount: 50 },
        output: {
          path: "src/large.ts",
          startLine: 201,
          endLine: 250,
          sha256: "sha-large",
          eof: false,
        },
        iteration: 1,
        ok: true,
        executed: true,
      }],
      executionMeta: executionMeta(usage({
        modelTurns: 8,
        toolCalls: 1,
        readCalls: 1,
      })),
    });

    expect(state?.readRanges).toEqual([{
      path: "src/large.ts",
      startLine: 201,
      endLine: 250,
      sha256: "sha-large",
      eof: false,
    }]);
    expect(renderResumeCheckpoint(state ?? undefined)).toContain(
      '"path":"src/large.ts","sha256":"sha-large","startLine":201,"endLine":250',
    );
    expect(renderResumeCheckpoint(state ?? undefined)).toContain(
      "Do not repeat an unchanged file range",
    );
  });
});

function executionMeta(value: RunBudgetUsage): AgentExecutionMeta {
  return {
    mode: "chat",
    executionStage: "analyze",
    modeSource: "explicit",
    intent: "answer",
    workflowType: "answerWorkflow",
    permissionPolicy: "readOnly",
    permissionPolicySource: "explicit",
    intentDecisionSource: "explicit",
    budget: MODE_BASE_BUDGETS.chat,
    usage: value,
    stopReason: "budget_exhausted",
    budgetExhausted: "maxModelTurns",
    needsMoreBudget: true,
    suggestedBudget: MODE_BASE_BUDGETS.chat,
  } as AgentExecutionMeta;
}

function usage(overrides: Partial<RunBudgetUsage>): RunBudgetUsage {
  return {
    modelTurns: 0,
    mainModelTurns: overrides.modelTurns ?? 0,
    toolCalls: 0,
    readCalls: 0,
    writeCalls: 0,
    shellCalls: 0,
    runtimeMs: 0,
    ...overrides,
  };
}
