import type { AgentExecutionMeta, AgentStopReason } from "../RunPolicyTypes.js";

export type UserFacingExecutionState =
  | "answering"
  | "analyzing"
  | "planning"
  | "waiting_plan_approval"
  | "editing"
  | "debugging"
  | "waiting_tool_permission"
  | "verifying"
  | "write_gate_blocked"
  | "completed"
  | "completed_partial"
  | "failed"
  | "cancelled";

const WORKFLOW_LABELS: Record<string, string> = {
  answerWorkflow: "正在回答",
  planWorkflow: "正在制定计划",
  editWorkflow: "正在修改文件",
  runWorkflow: "正在执行命令",
  debugWorkflow: "正在调试修复",
  reviewWorkflow: "正在审阅代码",
  verifyWorkflow: "正在验证结果",
  summarizeWorkflow: "正在总结内容",
  searchWorkflow: "正在定位信息",
  refactorWorkflow: "正在规划重构",
  generateFileWorkflow: "正在生成文件",
};

const TASK_STATE_LABELS: Record<string, string> = {
  idle: "待命",
  planning: "正在制定计划",
  waiting_confirmation: "等待确认",
  executing: "正在执行",
  verifying: "正在验证",
  completed: "任务已完成",
  failed: "执行失败",
  cancelled: "已取消",
};

export interface ExecutionPresentation {
  userFacingState: UserFacingExecutionState;
  userFacingLabel: string;
}

export function presentExecutionState(meta: Partial<AgentExecutionMeta>): ExecutionPresentation {
  if (meta.stopReason === "awaiting_plan_handoff") {
    return { userFacingState: "waiting_plan_approval", userFacingLabel: "等待你批准执行" };
  }
  if (meta.stopReason === "awaiting_permission") {
    return { userFacingState: "waiting_tool_permission", userFacingLabel: "等待工具授权" };
  }
  if (meta.workflowState?.phase === "terminated") {
    return { userFacingState: "write_gate_blocked", userFacingLabel: "写入门禁阻塞" };
  }
  if (meta.stopReason === "user_cancelled") {
    return { userFacingState: "cancelled", userFacingLabel: "已取消" };
  }
  if (
    meta.stopReason === "completed_partial" ||
    meta.stopReason === "recovery_partial" ||
    meta.stopReason === "misleading_completion" ||
    meta.stopReason === "blocked_by_policy" ||
    meta.completionStatus === "historical_reference" ||
    meta.completionStatus === "completed_partial" ||
    meta.completionStatus === "misleading_completion"
  ) {
    const label =
      meta.completionStatus === "historical_reference"
        ? "历史完成未验证"
        : meta.stopReason === "recovery_partial"
          ? "部分完成 · 恢复预算耗尽"
          : "任务未完全完成";
    return { userFacingState: "completed_partial", userFacingLabel: label };
  }
  if (meta.workflowTaskState === "completed" || meta.stopReason === "completed") {
    const ledger = meta.toolLedger;
    const needsProof =
      (ledger?.attemptedShellCalls ?? 0) > 0 || (ledger?.attemptedWriteCalls ?? 0) > 0;
    const proved =
      (ledger?.successfulShellCalls ?? 0) > 0 || (ledger?.successfulWriteCalls ?? 0) > 0;
    if (needsProof && !proved) {
      return { userFacingState: "completed_partial", userFacingLabel: "历史未验证 / 需要重新确认" };
    }
    if (meta.completionStatus === "completed_success" || proved || !needsProof) {
      return { userFacingState: "completed", userFacingLabel: "任务已完成" };
    }
    return { userFacingState: "completed_partial", userFacingLabel: "任务未完全完成" };
  }
  if (meta.stopReason === "budget_exhausted") {
    return { userFacingState: "completed_partial", userFacingLabel: "部分完成 · 预算耗尽" };
  }
  if (meta.workflowTaskState === "failed" || meta.stopReason === "error") {
    return { userFacingState: "failed", userFacingLabel: "执行失败，等待补充信息" };
  }
  if (meta.workflowSwitch?.switched) {
    const to = meta.workflowSwitch.toWorkflowType || meta.workflowSwitch.toIntent;
    return { userFacingState: "analyzing", userFacingLabel: `已切换工作流：${WORKFLOW_LABELS[to] ?? to}` };
  }
  if (meta.capabilityEscalations?.length) {
    const latest = meta.capabilityEscalations[meta.capabilityEscalations.length - 1]!;
    const to = meta.reconciledWorkflowType ?? latest.toWorkflow;
    const fromLabel = WORKFLOW_LABELS[latest.fromWorkflow] ?? latest.fromWorkflow;
    const toLabel = WORKFLOW_LABELS[to] ?? to;
    return {
      userFacingState: mapWorkflowToFacing(to),
      userFacingLabel: `任务能力已升级：${fromLabel} → ${toLabel}`,
    };
  }
  if (meta.workflowTaskState && TASK_STATE_LABELS[meta.workflowTaskState]) {
    const internalPlanningOnly =
      meta.workflowTaskState === "planning" &&
      meta.workflowType != null &&
      meta.workflowType !== "planWorkflow";
    if (!internalPlanningOnly) {
      const label = TASK_STATE_LABELS[meta.workflowTaskState]!;
      const state = mapTaskStateToFacing(meta.workflowTaskState, meta.stopReason);
      return { userFacingState: state, userFacingLabel: label };
    }
  }
  const workflowLabel = meta.workflowType ? WORKFLOW_LABELS[meta.workflowType] : undefined;
  if (workflowLabel) {
    return {
      userFacingState: mapWorkflowToFacing(meta.workflowType),
      userFacingLabel: workflowLabel,
    };
  }
  return { userFacingState: "analyzing", userFacingLabel: "正在分析" };
}

function mapWorkflowToFacing(workflowType?: string): UserFacingExecutionState {
  if (workflowType === "planWorkflow") return "planning";
  if (workflowType === "editWorkflow" || workflowType === "generateFileWorkflow") return "editing";
  if (workflowType === "debugWorkflow") return "debugging";
  if (workflowType === "verifyWorkflow" || workflowType === "runWorkflow") return "verifying";
  if (workflowType === "answerWorkflow") return "answering";
  return "analyzing";
}

function mapTaskStateToFacing(
  taskState: string,
  stopReason?: AgentStopReason,
): UserFacingExecutionState {
  if (taskState === "waiting_confirmation" || stopReason === "awaiting_permission") {
    return "waiting_tool_permission";
  }
  if (taskState === "planning") return "planning";
  if (taskState === "executing") return "editing";
  if (taskState === "verifying") return "verifying";
  if (taskState === "failed") return "failed";
  if (taskState === "completed") return "completed";
  if (taskState === "cancelled") return "cancelled";
  return "analyzing";
}
