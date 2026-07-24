import { createHash } from "node:crypto";

import type { InternalTaskPlan } from "./types.js";

/** 稳定 hash：用于执行前校验计划未被篡改。 */
export function computePlanHash(plan: Omit<InternalTaskPlan, "audit"> & { audit?: InternalTaskPlan["audit"] }): string {
  const clone = { ...plan };
  if (clone.audit) {
    clone.audit = { ...clone.audit, planHash: "" };
  }
  const json = JSON.stringify(clone, Object.keys(clone).sort());
  return `sha256:${createHash("sha256").update(json).digest("hex")}`;
}

export function attachPlanHash(plan: InternalTaskPlan): InternalTaskPlan {
  const hash = computePlanHash(plan);
  return {
    ...plan,
    audit: {
      ...plan.audit,
      planHash: hash,
      updatedAt: new Date().toISOString(),
    },
  };
}
