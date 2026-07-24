import type { PlanStore } from "./PlanStore.js";
import type { InternalTaskPlan } from "./types.js";

export class PlanApprovalManager {
  constructor(private readonly store: PlanStore) {}

  approve(planId: string, version: number, approvedBy: string, comment?: string): InternalTaskPlan {
    return this.store.applyApprovalDecision({
      planId,
      version,
      approvedBy,
      approvalStatus: "approved",
      comment,
    });
  }

  reject(planId: string, version: number, approvedBy: string, comment?: string): InternalTaskPlan {
    return this.store.applyApprovalDecision({
      planId,
      version,
      approvedBy,
      approvalStatus: "rejected",
      comment,
    });
  }

  autoApproveForDryRun(planId: string, version: number): InternalTaskPlan {
    return this.approve(planId, version, "system:dry-run", "dry-run auto approve");
  }
}
