import type { InternalTaskPlan } from "./types.js";

/** 非 dry-run 生产执行前是否必须人工审批（禁止系统 silent auto-approve）。 */
export function planRequiresHumanApproval(internal: InternalTaskPlan): boolean {
  return internal.steps.some((step) => {
    if (step.riskLevel === "high") return true;
    if (step.requiresApproval) return true;
    const perms = step.requiredPermissions ?? [];
    return perms.some((p) => p === "write" || p === "shell" || p === "dangerous" || p === "network");
  });
}

export function canAutoApprovePlan(input: {
  dryRun: boolean;
  autoApprove?: boolean;
  internal: InternalTaskPlan;
}): boolean {
  if (input.dryRun) return true;
  if (!input.autoApprove) return false;
  return !planRequiresHumanApproval(input.internal);
}
