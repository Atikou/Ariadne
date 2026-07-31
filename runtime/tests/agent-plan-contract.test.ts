import { describe, expect, it } from "vitest";

import {
  evaluateAgentPlanDraft,
  evaluateAgentPlanExecutionReport,
  type AgentPlanModelDraft,
} from "../src/plan/AgentPlanContract.js";
import { AgentPlanStore } from "../src/plan/AgentPlanStore.js";

describe("AgentPlanContract", () => {
  it("accepts a six-region plan with verifiable milestones", () => {
    const evaluation = evaluateAgentPlanDraft(readyDraft());

    expect(evaluation.acceptable).toBe(true);
    expect(evaluation.needsClarification).toBe(false);
    expect(evaluation.draft?.steps).toHaveLength(3);
    expect(evaluation.issues.every((issue) => issue.severity !== "critical")).toBe(true);
  });

  it("keeps critical ambiguity as clarification instead of an executable handoff", () => {
    const draft = readyDraft();
    draft.clarifications = [{
      id: "decision-mobile",
      question: "是否需要移动端适配？",
      impact: "会改变布局实现和验收范围。",
    }];
    draft.steps = [];
    draft.completionCriteria = [];

    const evaluation = evaluateAgentPlanDraft(draft);

    expect(evaluation.acceptable).toBe(true);
    expect(evaluation.needsClarification).toBe(true);
  });

  it("does not freeze execution steps while a critical decision is unresolved", () => {
    const draft = readyDraft();
    draft.clarifications = [{
      id: "decision-mobile",
      question: "是否需要移动端适配？",
      impact: "会改变布局实现和验收范围。",
    }];

    const evaluation = evaluateAgentPlanDraft(draft);

    expect(evaluation.acceptable).toBe(false);
    expect(evaluation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "critical_ambiguity_with_steps", severity: "critical" }),
    ]));
  });

  it("rejects facts-as-steps, invented limits, optional verification and vague done criteria", () => {
    const draft = readyDraft();
    draft.steps[0] = {
      ...draft.steps[0]!,
      title: "检查当前工作区",
      action: "检查当前工作区并控制在 200 行以内",
      verification: "如有时间可选验证",
    };
    draft.completionCriteria = [{
      id: "done-vague",
      behavior: "优化",
      verification: "测试通过",
    }];

    const evaluation = evaluateAgentPlanDraft(draft);
    const codes = evaluation.issues.map((issue) => issue.code);

    expect(evaluation.acceptable).toBe(false);
    expect(codes).toEqual(expect.arrayContaining([
      "context_check_is_execution_step",
      "unfounded_limit",
      "optional_verification",
      "vague_completion_criterion",
    ]));
  });

  it("creates immutable versions and supersedes the exact prior version", () => {
    const store = new AgentPlanStore();
    const v1 = store.createFromModel({
      runId: "run-v1",
      sessionId: "session-1",
      draft: readyDraft(),
    });
    const v2 = store.createFromModel({
      runId: "run-v2",
      sessionId: "session-1",
      draft: {
        ...readyDraft(),
        basePlanId: v1.planId,
        baseVersion: v1.version,
        constraints: [{
          id: "constraint-mobile",
          kind: "constraint",
          statement: "必须适配移动端宽度。",
        }],
      },
    });

    expect(v1.version).toBe(1);
    expect(v2).toMatchObject({
      planId: v1.planId,
      version: 2,
      supersedesVersion: 1,
      planState: "ready_for_confirmation",
    });
    expect(store.get(v1.planId, 1)?.planState).toBe("superseded");
    expect(store.getLatestForSession("session-1")?.version).toBe(2);
  });

  it("rolls back a new version when its handoff cannot be persisted", () => {
    const store = new AgentPlanStore();
    const v1 = store.createFromModel({
      runId: "run-v1",
      sessionId: "session-rollback",
      draft: readyDraft(),
    });

    expect(() => store.transactionalCreateFromModel({
      runId: "run-v2",
      sessionId: "session-rollback",
      draft: {
        ...readyDraft(),
        basePlanId: v1.planId,
        baseVersion: v1.version,
      },
    }, () => {
      throw new Error("handoff persistence failed");
    })).toThrow("handoff persistence failed");

    expect(store.get(v1.planId, 1)?.planState).toBe("ready_for_confirmation");
    expect(store.getLatestForSession("session-rollback")?.version).toBe(1);
  });

  it("settles execution only from a complete evidence report for the approved version", () => {
    const store = new AgentPlanStore();
    const ready = store.createFromModel({
      runId: "run-execution",
      sessionId: "session-execution",
      draft: readyDraft(),
    });
    const approved = store.markApproved(ready.planId, ready.version);
    const report = {
      planId: approved.planId,
      version: approved.version,
      steps: approved.steps.map((step) => ({
        stepId: step.id,
        status: "completed" as const,
        actualScope: step.scope,
        evidence: [`${step.id} 验收通过`],
        deviations: [],
      })),
    };

    expect(evaluateAgentPlanExecutionReport(approved, report).acceptable).toBe(true);
    const completed = store.applyExecutionReport(approved.planId, approved.version, report);
    expect(completed.executionState).toBe("completed");
    expect(completed.steps.every((step) =>
      step.status === "completed" && step.evidence.length > 0)).toBe(true);
  });
});

function readyDraft(): AgentPlanModelDraft {
  return {
    title: "Todo 页面执行计划",
    goal: "实现一个刷新后仍保留任务的原生 Todo 页面。",
    facts: [{
      id: "fact-empty",
      statement: "当前工作区为空。",
      evidence: "只读目录检查未发现现有项目文件。",
    }],
    constraints: [{
      id: "non-goal-server",
      kind: "non_goal",
      statement: "不实现账号和服务器同步。",
    }],
    clarifications: [],
    steps: [
      step("step-1", "创建页面结构", [], ["index.html"]),
      step("step-2", "实现响应式样式", ["step-1"], ["style.css"]),
      step("step-3", "实现状态和持久化", ["step-1"], ["script.js"]),
    ],
    completionCriteria: [{
      id: "done-persist",
      behavior: "添加任务并刷新页面后，任务内容和完成状态仍然存在。",
      verification: "浏览器添加并完成一项任务，刷新后比较任务文本与完成状态。",
    }],
  };
}

function step(id: string, title: string, dependsOn: string[], scope: string[]) {
  return {
    id,
    title,
    dependsOn,
    action: title,
    scope,
    expectedOutcome: `${title}对应的用户行为可以使用。`,
    verification: `在浏览器中重复验证“${title}”对应行为并记录结果。`,
  };
}
