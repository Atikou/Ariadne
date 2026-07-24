import type { AgentToolStep } from "./toolStep.js";
import type { ToolOutcomeClass, ToolObservationFailureKind } from "../tools/toolOutcome.js";

/** 核心判断：基于 outcomeClass，不单独依赖 ok。 */
export function stepOutcomeClass(step: AgentToolStep): ToolOutcomeClass | undefined {
  return step.outcomeClass;
}

export function isObservationSuccessStep(step: AgentToolStep): boolean {
  return step.outcomeClass === "observation_success";
}

export function isObservationFailureStep(step: AgentToolStep): boolean {
  return step.outcomeClass === "observation_failure";
}

export function isExecutionErrorStep(step: AgentToolStep): boolean {
  return step.outcomeClass === "execution_error";
}

/** 副作用写入类工具是否产生有效结果（观察成功）。 */
export function isEffectiveWriteStep(step: AgentToolStep): boolean {
  return (
    isObservationSuccessStep(step) &&
    (step.tool === "write_file" || step.tool === "apply_patch" || step.tool === "rollback_change")
  );
}

export function isEffectiveReadStep(step: AgentToolStep): boolean {
  return isObservationSuccessStep(step) && step.tool === "read_file";
}

/** 工具步骤是否产生有效成功结果（兼容无 outcomeClass 的旧步骤）。 */
export function isSuccessfulToolStep(step: AgentToolStep): boolean {
  if (step.blocked) return false;
  if (step.executed === false) return false;
  if (step.outcomeClass) return isObservationSuccessStep(step);
  return step.ok === true;
}

/** 工具步骤是否执行但失败（观察失败或执行错误）。 */
export function isFailedToolStep(step: AgentToolStep): boolean {
  if (step.blocked) return false;
  if (step.outcomeClass) return isObservationFailureStep(step) || isExecutionErrorStep(step);
  return step.ok === false && step.executed !== false;
}

/** 工作流/计划上下文回灌：成功返回 output，失败返回结构化错误。 */
export function toolStepPayloadForContext(step: AgentToolStep): unknown {
  if (isSuccessfulToolStep(step)) {
    return step.output ?? step.resultLayers?.modelVisible ?? null;
  }
  return {
    error: step.error ?? step.outcomeMessage,
    blocked: step.blocked,
    outcomeClass: step.outcomeClass,
    outcomeKind: step.outcomeKind,
  };
}

export function stepPlanTraceStatus(step: AgentToolStep): "done" | "skipped" | "failed" {
  if (step.blocked) return "skipped";
  if (isSuccessfulToolStep(step)) return "done";
  return "failed";
}

export function countToolOutcomeUsage(steps: AgentToolStep[]): {
  toolFailures: number;
  toolObservationFailures: number;
  toolExecutionErrors: number;
} {
  let toolObservationFailures = 0;
  let toolExecutionErrors = 0;
  for (const step of steps) {
    if (step.blocked) continue;
    if (isObservationFailureStep(step)) toolObservationFailures += 1;
    else if (isExecutionErrorStep(step)) toolExecutionErrors += 1;
  }
  return {
    toolFailures: toolObservationFailures + toolExecutionErrors,
    toolObservationFailures,
    toolExecutionErrors,
  };
}

export function observationFailureKind(step: AgentToolStep): ToolObservationFailureKind | undefined {
  if (!isObservationFailureStep(step)) return undefined;
  return step.outcomeKind as ToolObservationFailureKind;
}

export function extractStepPath(step: AgentToolStep): string | undefined {
  if (step.outcomePath) return step.outcomePath.replace(/\\/g, "/");
  const input = step.input as { path?: string } | undefined;
  return typeof input?.path === "string" ? input.path.replace(/\\/g, "/") : undefined;
}
