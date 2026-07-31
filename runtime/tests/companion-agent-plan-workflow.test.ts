import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppContext } from "../src/app/createAppContext.js";
import { CompanionAgentPlanWorkflow } from "../src/application/CompanionAgentPlanWorkflow.js";
import { CompanionService } from "../src/companion/CompanionService.js";
import type { ModelResponse } from "../src/model/types.js";
import type { AgentStreamEvent } from "../src/orchestrator/AgentStream.js";
import type { AgentStopReason } from "../src/agent/RunPolicyTypes.js";
import { AgentPlanStore } from "../src/plan/AgentPlanStore.js";
import { createAgentPlanContract } from "../src/plan/AgentPlanContract.js";
import { PlanHandoffStore } from "../src/policy/PlanHandoffStore.js";

const roots: string[] = [];
const services: CompanionService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CompanionAgentPlanWorkflow", () => {
  it("persists one Chat turn while delegating policy and plan handoff to Agent", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ariadne-companion-plan-"));
    roots.push(root);
    const companionService = new CompanionService({
      projectRoot: root,
      defaultStorageRoot: path.join(root, "companion"),
      directChat: async (): Promise<ModelResponse> => modelResponse(),
    });
    services.push(companionService);
    const session = companionService.createSession({ title: "Plan session" }).session;
    let requestBody: Record<string, unknown> | undefined;
    const emittedMessages: string[] = [];
    const emittedHandoffs: string[] = [];
    const emittedRuns: string[] = [];
    const runId = "agent-plan-run";
    const agentPlanStore = new AgentPlanStore();
    const agentPlan = createReadyPlan(runId, session.id);
    const planHandoff = new PlanHandoffStore().create({
      runId,
      sessionId: session.id,
      plan: agentPlan,
      planVariant: "plan_wait_approval",
      message: "结构化计划已通过质量检查，等待确认。",
    });
    const app = {
      companionService,
      agentPlanStore,
      makeChatFn: () => vi.fn(),
      orchestrator: {
        runAgentStream: async (
          body: unknown,
          emit: (event: AgentStreamEvent) => void,
        ): Promise<void> => {
          requestBody = body as Record<string, unknown>;
          emit({ type: "run_start", runId, taskId: "task-1", sessionId: session.id });
          emit({
            type: "model_turn",
            turn: {
              iteration: 1,
              phase: "completed",
              action: "final",
              thought: "Inspected the constraints and prepared a safe plan.",
              clientName: "agent-model",
              modelName: "agent-model-v1",
            },
          });
          emit({
            type: "done",
            runId,
            taskId: "task-1",
            answer: planHandoff.planMarkdown,
            steps: [],
            iterations: 1,
            reachedLimit: false,
            awaitingPlanHandoff: true,
            planHandoff,
            agentPlan,
            executionMeta: {
              stopReason: "awaiting_plan_handoff",
            },
          } as AgentStreamEvent);
        },
      },
    } as unknown as AppContext;
    const workflow = new CompanionAgentPlanWorkflow(app, {
      onMessage: (message) => emittedMessages.push(message.id),
      onPlanHandoff: (handoff) => emittedHandoffs.push(handoff.id),
      onRunChanged: (changedRunId) => emittedRuns.push(changedRunId),
    }, "confirmBeforeRun");

    const started = workflow.start({
      sessionId: session.id,
      workspaceKey: "primary",
      message: "Create a safe implementation plan",
      userMessageId: "user-plan-message",
      clientName: "agent-model",
      inference: { reasoningMode: "on", reasoningEffort: "high" },
    });

    await expect(started.started).resolves.toEqual({ runId, sessionId: session.id });
    await expect(started.completion).resolves.toBeUndefined();
    expect(requestBody).toMatchObject({
      mode: "plan",
      forceMode: true,
      permissionPolicy: "confirmBeforeRun",
      autoConfirm: false,
      persist: true,
      skipPlanHandoff: false,
      streamTokens: false,
    });
    const messages = companionService.listMessages({ sessionId: session.id, limit: 20 })?.messages;
    expect(messages).toHaveLength(2);
    expect(messages?.[0]).toMatchObject({
      id: "user-plan-message",
      role: "user",
      content: "Create a safe implementation plan",
      status: "completed",
    });
    expect(messages?.[1]).toMatchObject({
      role: "assistant",
      content: "",
      status: "streaming",
      clientName: "agent-model",
      modelName: "agent-model-v1",
      reasoning: {
        content: expect.stringContaining(planHandoff.planMarkdown),
        status: "streaming",
        source: "summary",
      },
      metadata: {
        agentMode: "plan",
        runId,
        sourceMessageId: "user-plan-message",
        planHandoffId: planHandoff.id,
        reasoningSegments: [
          expect.objectContaining({
            kind: "thought",
            content: "Inspected the constraints and prepared a safe plan.",
          }),
          expect.objectContaining({
            kind: "intermediate_response",
            content: planHandoff.planMarkdown,
          }),
        ],
      },
    });
    expect(emittedMessages).toHaveLength(4);
    expect(emittedHandoffs).toEqual([planHandoff.id]);
    expect(emittedRuns).toEqual([runId, runId]);
    expect(workflow.sourceMessageId(runId, session.id)).toBe("user-plan-message");

    workflow.recordModelTurn(runId, session.id, {
      iteration: 2,
      phase: "completed",
      action: "tool",
      tool: "read_file",
      thought: "Approved execution is now checking the target.",
    });
    expect(companionService.listMessages({
      sessionId: session.id,
      limit: 20,
    })?.messages[1]?.metadata?.reasoningSegments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "thought",
        content: "Approved execution is now checking the target.",
        iteration: 2,
      }),
    ]));

    workflow.recordIntermediateResult(runId, session.id, {
      status: 200,
      body: { answer: "Execution paused before a permission-gated tool." },
    }, "3");
    expect(companionService.listMessages({
      sessionId: session.id,
      limit: 20,
    })?.messages[1]).toMatchObject({
      content: "",
      status: "streaming",
      metadata: {
        reasoningSegments: expect.arrayContaining([
          expect.objectContaining({
            kind: "intermediate_response",
            content: "Execution paused before a permission-gated tool.",
          }),
        ]),
      },
    });

    workflow.recordTerminalResult(runId, session.id, {
      status: 200,
      body: { answer: "Implementation completed." },
    }, {
      status: "completed",
      processingDurationMs: 3_200,
    });
    workflow.recordTerminalResult(runId, session.id, {
      status: 200,
      body: { answer: "Implementation completed." },
    }, {
      status: "completed",
      processingDurationMs: 3_200,
    });
    const finalMessage = companionService.listMessages({
      sessionId: session.id,
      limit: 20,
    })?.messages[1];
    expect(finalMessage).toMatchObject({
      content: "Implementation completed.",
      status: "completed",
      reasoning: {
        status: "completed",
      },
      metadata: {
        planExecutionRecorded: true,
        processingDurationMs: 3_200,
      },
    });
    expect(finalMessage?.content).not.toContain(planHandoff.planMarkdown);
  });

  it("finishes a clarification turn without creating an executable handoff", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ariadne-companion-plan-clarify-"));
    roots.push(root);
    const companionService = new CompanionService({
      projectRoot: root,
      defaultStorageRoot: path.join(root, "companion"),
      directChat: async (): Promise<ModelResponse> => modelResponse(),
    });
    services.push(companionService);
    const session = companionService.createSession({ title: "Plan clarification" }).session;
    const runId = "agent-plan-clarification";
    const agentPlanStore = new AgentPlanStore();
    const agentPlan = agentPlanStore.createFromModel({
      runId,
      sessionId: session.id,
      draft: {
        title: "Todo 页面计划",
        goal: "创建可持久化的 Todo 页面。",
        facts: [{ id: "fact-1", statement: "工作区为空。", evidence: "目录只读检查结果。" }],
        constraints: [],
        clarifications: [{
          id: "decision-1",
          question: "是否需要移动端适配？",
          impact: "会改变布局和验收范围。",
        }],
        steps: [],
        completionCriteria: [],
      },
    });
    let requestBody: Record<string, unknown> | undefined;
    const app = {
      companionService,
      agentPlanStore,
      makeChatFn: () => vi.fn(),
      orchestrator: {
        runAgentStream: async (
          body: unknown,
          emit: (event: AgentStreamEvent) => void,
        ): Promise<void> => {
          requestBody = body as Record<string, unknown>;
          emit({ type: "run_start", runId, taskId: "task-1", sessionId: session.id });
          emit({
            type: "done",
            runId,
            taskId: "task-1",
            answer: "",
            steps: [],
            iterations: 1,
            reachedLimit: false,
            agentPlan,
            executionMeta: { stopReason: "completed" },
          } as AgentStreamEvent);
        },
      },
    } as unknown as AppContext;
    const emittedHandoffs: string[] = [];
    const workflow = new CompanionAgentPlanWorkflow(app, {
      onMessage: () => undefined,
      onPlanHandoff: (handoff) => emittedHandoffs.push(handoff.id),
      onRunChanged: () => undefined,
    }, "confirmBeforeRun");

    const started = workflow.start({
      sessionId: session.id,
      workspaceKey: "primary",
      message: "创建 Todo 页面",
      userMessageId: "clarification-user",
    });
    await started.started;
    await started.completion;

    const assistant = companionService.listMessages({
      sessionId: session.id,
      limit: 20,
    })?.messages[1];
    expect(assistant).toMatchObject({
      role: "assistant",
      status: "completed",
      metadata: {
        planId: agentPlan.planId,
        planVersion: 1,
        planState: "needs_clarification",
        planCompleteness: "incomplete",
      },
    });
    expect(assistant?.content).toContain("是否需要移动端适配");
    expect(emittedHandoffs).toEqual([]);
    expect(requestBody?.system).toEqual(expect.stringContaining(
      `basePlanId=${JSON.stringify(agentPlan.planId)}、baseVersion=1`,
    ));
  });

  it("keeps a budget-paused plan in the same streaming Chat turn", async () => {
    const result = await runWithoutPlanHandoff("budget_exhausted");

    expect(result.message).toMatchObject({
      role: "assistant",
      content: "",
      status: "streaming",
    });
    expect(result.emittedHandoffs).toEqual([]);
  });

  it("does not present a terminal response without a durable plan handoff as completed", async () => {
    const result = await runWithoutPlanHandoff("completed");

    expect(result.message).toMatchObject({
      role: "assistant",
      status: "interrupted",
      metadata: {
        errorCode: "AGENT_PLAN_DID_NOT_HANDOFF",
        agentStopReason: "completed",
      },
    });
    expect(result.message?.content).toContain("模型给出了文本但没有计划交接");
    expect(result.message?.content).not.toContain("计划已生成");
    expect(result.emittedHandoffs).toEqual([]);
  });
});

async function runWithoutPlanHandoff(stopReason: AgentStopReason) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ariadne-companion-plan-failure-"));
  roots.push(root);
  const companionService = new CompanionService({
    projectRoot: root,
    defaultStorageRoot: path.join(root, "companion"),
    directChat: async (): Promise<ModelResponse> => modelResponse(),
  });
  services.push(companionService);
  const session = companionService.createSession({ title: "Plan failure" }).session;
  const runId = `agent-plan-${stopReason}`;
  const emittedHandoffs: string[] = [];
  const agentPlanStore = new AgentPlanStore();
  const app = {
    companionService,
    agentPlanStore,
    makeChatFn: () => vi.fn(),
    orchestrator: {
      runAgentStream: async (
        _body: unknown,
        emit: (event: AgentStreamEvent) => void,
      ): Promise<void> => {
        emit({ type: "run_start", runId, taskId: "task-1", sessionId: session.id });
        emit({
          type: "done",
          runId,
          taskId: "task-1",
          answer: stopReason === "budget_exhausted"
            ? ""
            : "模型给出了文本但没有计划交接",
          steps: [],
          iterations: 1,
          reachedLimit: stopReason === "budget_exhausted",
          executionMeta: { stopReason },
        } as AgentStreamEvent);
      },
    },
  } as unknown as AppContext;
  const workflow = new CompanionAgentPlanWorkflow(app, {
    onMessage: () => undefined,
    onPlanHandoff: (handoff) => emittedHandoffs.push(handoff.id),
    onRunChanged: () => undefined,
  }, "confirmBeforeRun");

  const started = workflow.start({
    sessionId: session.id,
    workspaceKey: "primary",
    message: "Create a plan",
    userMessageId: `user-${stopReason}`,
  });
  await started.started;
  await started.completion;

  return {
    message: companionService.listMessages({ sessionId: session.id, limit: 20 })?.messages[1],
    emittedHandoffs,
  };
}

function createReadyPlan(runId: string, sessionId: string) {
  return createAgentPlanContract({
    runId,
    sessionId,
    issues: [],
    draft: {
      title: "Todo 页面执行计划",
      goal: "实现一个可持久化的原生 Todo 页面。",
      facts: [{ id: "fact-1", statement: "工作区为空。", evidence: "目录只读检查结果。" }],
      constraints: [{
        id: "constraint-1",
        kind: "non_goal",
        statement: "不实现服务器同步。",
      }],
      clarifications: [],
      steps: [
        planStep("step-1", "创建页面结构", [], ["index.html"]),
        planStep("step-2", "实现样式与布局", ["step-1"], ["style.css"]),
        planStep("step-3", "实现状态和持久化", ["step-1"], ["script.js"]),
      ],
      completionCriteria: [{
        id: "done-1",
        behavior: "刷新页面后任务仍然存在。",
        verification: "添加任务后刷新浏览器并确认任务内容保持。",
      }],
    },
  });
}

function planStep(id: string, title: string, dependsOn: string[], scope: string[]) {
  return {
    id,
    title,
    dependsOn,
    action: title,
    scope,
    expectedOutcome: `${title}完成并可观察。`,
    verification: `打开页面并验证“${title}”对应行为。`,
  };
}

function modelResponse(): ModelResponse {
  return {
    content: "",
    toolCalls: [],
    clientName: "unused",
    modelName: "unused",
    location: "local",
    latencyMs: 0,
  };
}
