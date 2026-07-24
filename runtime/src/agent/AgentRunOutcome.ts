import type { RunStatus } from "../core/runTypes.js";
import type { AgentStopReason } from "./RunPolicyTypes.js";

export type AgentTaskPersistenceStatus = "done" | "failed" | "blocked" | "cancelled";
export type AgentTimelineOutcome = "success" | "partial" | "failed" | "cancelled" | "waiting";

export interface AgentRunOutcome {
  taskStatus: AgentTaskPersistenceStatus;
  runStatus: RunStatus;
  timelineOutcome: AgentTimelineOutcome;
  /** 只有真实完成才从会话释放；失败/暂停必须保留任务上下文供恢复或审计。 */
  releaseTaskFromSession: boolean;
}

/**
 * AgentStopReason 是 Agent 执行结果的唯一状态真相。
 * 所有持久化层和展示层必须通过此映射，禁止再用 reachedLimit 猜测成功与否。
 */
export function resolveAgentRunOutcome(stopReason: AgentStopReason): AgentRunOutcome {
  switch (stopReason) {
    case "completed":
      return {
        taskStatus: "done",
        runStatus: "completed",
        timelineOutcome: "success",
        releaseTaskFromSession: true,
      };
    case "awaiting_permission":
      return {
        taskStatus: "blocked",
        runStatus: "waiting_confirmation",
        timelineOutcome: "waiting",
        releaseTaskFromSession: false,
      };
    case "awaiting_plan_handoff":
      return {
        taskStatus: "blocked",
        runStatus: "waiting_plan_handoff",
        timelineOutcome: "waiting",
        releaseTaskFromSession: false,
      };
    case "blocked_by_policy":
      return {
        taskStatus: "blocked",
        runStatus: "blocked",
        timelineOutcome: "partial",
        releaseTaskFromSession: false,
      };
    case "user_cancelled":
      return {
        taskStatus: "cancelled",
        runStatus: "cancelled",
        timelineOutcome: "cancelled",
        releaseTaskFromSession: false,
      };
    case "completed_partial":
    case "recovery_partial":
    case "misleading_completion":
    case "budget_exhausted":
    case "historical_reference":
      return {
        taskStatus: "failed",
        runStatus: "failed",
        timelineOutcome: "partial",
        releaseTaskFromSession: false,
      };
    case "error":
      return {
        taskStatus: "failed",
        runStatus: "failed",
        timelineOutcome: "failed",
        releaseTaskFromSession: false,
      };
  }
}
