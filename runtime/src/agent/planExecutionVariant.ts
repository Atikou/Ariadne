export type PlanExecutionVariant = "plan_only" | "plan_wait_approval" | "plan_then_execute";

export type PlanAfterAction = "final" | "request_permission" | "request_permission_then_execute";

const PLAN_THEN_EXECUTE_RE =
  /(然后|再|接着).{0,12}(执行|修改|落实|动手|开工)|(先|首先).{0,24}(计划|方案|分析).{0,24}(然后|再|接着).{0,12}(执行|修改|落实|按.{0,6}做)/i;
const PLAN_WAIT_APPROVAL_RE = /(等我确认|待我确认|待确认|批准后再|确认后再)/i;
const PLAN_ONLY_RE = /(不要执行|不执行|只制定|只读|不要修改|不做修改|先别改)/i;

export function detectPlanExecutionVariant(message?: string): PlanExecutionVariant | undefined {
  const text = (message ?? "").trim();
  if (!text) return undefined;
  if (!/(计划|方案|规划|设计|plan)/i.test(text)) return undefined;
  if (PLAN_ONLY_RE.test(text)) return "plan_only";
  if (PLAN_THEN_EXECUTE_RE.test(text)) return "plan_then_execute";
  if (PLAN_WAIT_APPROVAL_RE.test(text)) return "plan_wait_approval";
  if (/(制定|分析).{0,20}(计划|方案)/i.test(text)) return "plan_only";
  return undefined;
}

export function afterPlanForVariant(variant: PlanExecutionVariant | undefined): PlanAfterAction {
  if (variant === "plan_wait_approval" || variant === "plan_then_execute") {
    return variant === "plan_then_execute"
      ? "request_permission_then_execute"
      : "request_permission";
  }
  return "final";
}

export function shouldRequestPermissionAfterPlan(variant: PlanExecutionVariant | undefined): boolean {
  return variant === "plan_wait_approval" || variant === "plan_then_execute";
}
