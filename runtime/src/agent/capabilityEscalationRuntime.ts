import type { ToolPermission } from "../core/permissions.js";
import type { AgentIntentType } from "./IntentTypes.js";
import type { BudgetManager } from "./BudgetManager.js";
import type { CapabilityEscalationRecord } from "./CapabilityEscalation.js";
import {
  normalizeTaskCompletionContract,
  type PersistedTaskCompletionContract,
  type TaskCompletionContract,
  type SideEffectKind,
} from "./completion/TaskCompletionContract.js";

export function resolveEffectiveIntent(
  policyIntent: AgentIntentType | undefined,
  reconciledIntent: AgentIntentType | undefined,
): AgentIntentType {
  return reconciledIntent ?? policyIntent ?? "answer";
}

export function augmentContractWithEscalations(
  contract: PersistedTaskCompletionContract,
  escalations: CapabilityEscalationRecord[] | undefined,
): TaskCompletionContract {
  const normalizedContract = normalizeTaskCompletionContract(contract);
  if (!escalations?.length) return normalizedContract;
  const required = new Set<SideEffectKind>(normalizedContract.requiredSideEffects);
  for (const escalation of escalations) {
    for (const perm of escalation.targetSideEffects) {
      if (perm === "write" || perm === "dangerous") required.add("write");
      if (perm === "shell") required.add("shell");
    }
  }
  const requiredSideEffects = [...required];
  const requirements = [...normalizedContract.requirements];
  for (const sideEffect of requiredSideEffects) {
    const id = `side-effect:${sideEffect}`;
    if (!requirements.some((item) => item.id === id)) {
      requirements.push({
        id,
        kind: "side_effect",
        sideEffect,
        description: `成功执行升级后所需 ${sideEffect} 副作用`,
        source: "workflow",
      });
    }
  }
  if (required.has("write") && !requirements.some((item) => item.kind === "write_verification")) {
    requirements.push({
      id: "workflow:write-verification",
      kind: "write_verification",
      description: "每个最终写入产物都有系统绑定的成功验证步骤",
      source: "workflow",
    });
  }
  return {
    requiresSideEffect: requiredSideEffects.some((kind) => kind === "write" || kind === "shell"),
    requiredSideEffects,
    source: normalizedContract.source,
    requirements,
  };
}

/** escalation 后若分项预算为 0 但目标能力需要 write/shell，抬升到建议预算下限。 */
export function applyEscalationBudget(
  manager: BudgetManager,
  targetSideEffects: ToolPermission[],
): void {
  const budget = manager.budget;
  const suggested = manager.suggestedBudget;
  if (
    (targetSideEffects.includes("write") || targetSideEffects.includes("dangerous")) &&
    budget.maxWriteCalls === 0
  ) {
    budget.maxWriteCalls = Math.max(1, suggested.maxWriteCalls || 2);
  }
  if (targetSideEffects.includes("shell") && budget.maxShellCalls === 0) {
    budget.maxShellCalls = Math.max(1, suggested.maxShellCalls || 2);
  }
}

export function formatCapabilityEscalationTimelineContent(input: {
  escalation: CapabilityEscalationRecord;
  permissionPolicy?: string;
  targetPath?: string;
}): string {
  const lines = [
    input.escalation.reason,
    input.targetPath ? `目标：${input.targetPath}` : "",
    `权限策略：${input.permissionPolicy ?? "未指定"}`,
    "权限：这里只扩展可申请能力上限；工具仍须命中服务端 Run grant 或由 UI 批准具体 permissionRequest。",
  ];
  return lines.filter(Boolean).join("\n");
}
