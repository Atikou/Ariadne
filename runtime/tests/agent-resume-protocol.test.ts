import { describe, expect, it, vi } from "vitest";

import { resumeApprovedToolAction } from "../src/agent/AgentApprovedToolResume.js";
import { AgentToolExecutionCoordinator } from "../src/agent/AgentToolExecutionCoordinator.js";
import type { AgentToolStep } from "../src/agent/toolStep.js";
import type { ChatMessage } from "../src/model/types.js";

describe("Agent permission resume protocol", () => {
  it("reuses the provider tool call id from a legacy paused snapshot", async () => {
    const pendingInput = { path: "index.html", search: "blue", replace: "black" };
    const messages: ChatMessage[] = [{
      role: "assistant",
      content: "apply the approved change",
      toolCalls: [{
        id: "call-original",
        name: "apply_patch",
        arguments: pendingInput,
      }],
    }];
    const makeToolCallId = vi.fn(() => "generated-id");
    const executeToolStep = vi.fn(async (input: {
      toolCallId: string;
      action: { tool: string; input?: Record<string, unknown> };
    }) => ({
      kind: "step" as const,
      step: {
        iteration: 4,
        toolCallId: input.toolCallId,
        tool: input.action.tool,
        input: input.action.input ?? {},
        ok: true,
      },
    }));
    const continueAfterToolStep = vi.fn(async () => ({ kind: "continue" as const }));

    await expect(resumeApprovedToolAction({
      makeToolCallId,
      executeToolStep,
      continueAfterToolStep,
      finalizePermissionPause: vi.fn(),
      finishRun: vi.fn(),
    }, {
      pendingAction: { tool: "apply_patch", input: pendingInput },
      messages,
      steps: [],
      modelTurns: 4,
      goal: "fix rendering",
      consumedNotifications: [],
      injectNotifications: vi.fn(),
    })).resolves.toBeNull();

    expect(makeToolCallId).toHaveBeenCalledWith(4, "apply_patch");
    expect(executeToolStep).toHaveBeenCalledWith(expect.objectContaining({
      toolCallId: "generated-id",
    }));
    expect(continueAfterToolStep).toHaveBeenCalledWith(expect.objectContaining({
      step: expect.objectContaining({ toolCallId: "call-original" }),
    }));
  });

  it("uses one provider call id for both execution and protocol in new snapshots", async () => {
    const makeToolCallId = vi.fn(() => "generated-id");
    const executeToolStep = vi.fn(async (input: { toolCallId: string }) => ({
      kind: "step" as const,
      step: {
        iteration: 2,
        toolCallId: input.toolCallId,
        tool: "apply_patch",
        input: {},
        ok: true,
      },
    }));

    await resumeApprovedToolAction({
      makeToolCallId,
      executeToolStep,
      continueAfterToolStep: async () => ({ kind: "continue" }),
      finalizePermissionPause: vi.fn(),
      finishRun: vi.fn(),
    }, {
      pendingAction: {
        toolCallId: "call-persisted",
        tool: "apply_patch",
        input: {},
      },
      messages: [],
      steps: [],
      modelTurns: 2,
      goal: "fix rendering",
      consumedNotifications: [],
      injectNotifications: vi.fn(),
    });

    expect(makeToolCallId).not.toHaveBeenCalled();
    expect(executeToolStep).toHaveBeenCalledWith(expect.objectContaining({
      toolCallId: "call-persisted",
    }));
  });

  it("keeps all tool results contiguous before workflow follow-up messages", async () => {
    const messages: ChatMessage[] = [{
      role: "assistant",
      content: "inspect both files",
      toolCalls: [
        { id: "call-a", name: "read_file", arguments: { path: "a.ts" } },
        { id: "call-b", name: "read_file", arguments: { path: "b.ts" } },
      ],
    }];
    const steps: AgentToolStep[] = [];
    const coordinator = new AgentToolExecutionCoordinator({
      registry: { get: () => undefined },
      workspaceRoot: "E:\\workspace",
      allowedPermissions: ["read"],
      policy: { intent: "edit" },
      budgetManager: { findRuntimeExhaustion: () => undefined },
      state: {
        getEffectiveIntent: () => "edit",
        pendingWritePhaseContext: undefined,
      },
      finalizer: {},
      pauseOnPermissionRequest: true,
      sessionPermissionGrants: { get: () => undefined },
    } as never);
    const inputFor = (toolCallId: string): Parameters<
      AgentToolExecutionCoordinator["continueAfterToolBatch"]
    >[0][number] => ({
      step: {
        iteration: 1,
        toolCallId,
        tool: "read_file",
        input: { path: `${toolCallId}.ts` },
        ok: false,
        blocked: true,
        workflowPhaseBlocked: true,
        error: "workflow blocked",
      },
      allowPermissionRepause: false,
      messages,
      steps,
      goal: "inspect files",
      iteration: 1,
      modelTurns: 1,
      consumedNotifications: [],
      injectNotifications: vi.fn(),
    });

    await expect(coordinator.continueAfterToolBatch([
      inputFor("call-a"),
      inputFor("call-b"),
    ])).resolves.toEqual({ kind: "continue" });

    const appended = messages.slice(1);
    expect(appended.slice(0, 2)).toEqual([
      expect.objectContaining({ role: "tool", toolCallId: "call-a" }),
      expect.objectContaining({ role: "tool", toolCallId: "call-b" }),
    ]);
    expect(appended.findIndex((message) => message.role === "system")).toBeGreaterThanOrEqual(2);
  });
});
