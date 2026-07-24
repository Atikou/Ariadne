import type { PausedRunStore } from "../agent/PausedRunStore.js";
import type { PlanHandoffStore } from "./PlanHandoffStore.js";
import type { PermissionRequestStore } from "./PermissionRequestStore.js";
import type { PermissionRequestPayload } from "./permissionRequestTypes.js";
import type { PlanHandoffPayload } from "./planHandoffTypes.js";

export interface AgentPauseGateResult {
  blocked: true;
  code: "PLAN_HANDOFF_PENDING" | "PERMISSION_PAUSE_PENDING" | "PERMISSION_RESUME_REQUIRED";
  error: string;
  planHandoff?: PlanHandoffPayload;
  permissionRequest?: PermissionRequestPayload;
  runId?: string;
}

/** 会话存在待处理计划交接、权限申请或已暂停未恢复快照时，禁止无关新消息绕过。 */
export function findBlockingAgentPause(input: {
  sessionId?: string;
  planHandoffStore?: PlanHandoffStore;
  permissionRequestStore?: PermissionRequestStore;
  pausedRunStore?: PausedRunStore;
}): AgentPauseGateResult | null {
  const sessionId = input.sessionId?.trim();
  if (!sessionId) return null;

  const pendingHandoff = input.planHandoffStore?.getPendingBySessionId(sessionId);
  if (pendingHandoff) {
    return {
      blocked: true,
      code: "PLAN_HANDOFF_PENDING",
      error:
        "当前会话有待处理的计划交接。请先在侧栏「计划交接」面板选择「按计划执行」或「拒绝」，不要发送无关新消息。",
      planHandoff: pendingHandoff,
      runId: pendingHandoff.runId,
    };
  }

  const pending = input.permissionRequestStore?.listPending({ sessionId }) ?? [];
  if (pending.length > 0) {
    const first = pending[0]!;
    return {
      blocked: true,
      code: "PERMISSION_PAUSE_PENDING",
      error:
        "当前会话有待处理的工具权限申请。请先在侧栏权限弹窗选择「允许」「拒绝」或「本次会话都允许」。",
      permissionRequest: first,
      runId: first.runId,
    };
  }

  const pausedRunId = input.pausedRunStore?.getFirstPausedRunIdForSession(sessionId);
  if (pausedRunId) {
    const approved = input.permissionRequestStore?.getApprovedByRunId(pausedRunId);
    return {
      blocked: true,
      code: "PERMISSION_RESUME_REQUIRED",
      error:
        "当前会话有已批准但未完成的执行。请等待自动续跑完成，或稍后重试 resume-permission。",
      permissionRequest: approved ?? undefined,
      runId: pausedRunId,
    };
  }

  return null;
}

/** @deprecated 使用 findBlockingAgentPause */
export { findBlockingAgentPause as findBlockingPermissionPause };
