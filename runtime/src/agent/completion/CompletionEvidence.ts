import type { AgentToolStep } from "../toolStep.js";
import { isEffectiveWriteStep, isSuccessfulToolStep } from "../toolStepOutcome.js";
import type { CompletionRequirement, TaskCompletionContract } from "./TaskCompletionContract.js";
import { buildToolLedger } from "./ToolLedger.js";

export interface CompletionRequirementEvidence {
  requirementId: string;
  kind: CompletionRequirement["kind"];
  satisfied: boolean;
  reason: string;
  toolCallIds: string[];
}

export interface CompletionEvidenceReport {
  satisfied: boolean;
  requirements: CompletionRequirementEvidence[];
  missingRequirementIds: string[];
}

/**
 * 只消费系统产生的结构化工具事实。自然语言 answer/acceptance description 不参与裁决。
 */
export function evaluateCompletionEvidence(
  contract: TaskCompletionContract,
  steps: AgentToolStep[],
): CompletionEvidenceReport {
  const ledger = buildToolLedger(steps);
  const requirements = contract.requirements.map((requirement) =>
    evaluateRequirement(requirement, steps, ledger),
  );
  return {
    satisfied: requirements.every((item) => item.satisfied),
    requirements,
    missingRequirementIds: requirements.filter((item) => !item.satisfied).map((item) => item.requirementId),
  };
}

function evaluateRequirement(
  requirement: CompletionRequirement,
  steps: AgentToolStep[],
  ledger: ReturnType<typeof buildToolLedger>,
): CompletionRequirementEvidence {
  if (requirement.kind === "side_effect") {
    const effectiveWrites = steps.filter(isEffectiveWriteStep);
    const successful =
      requirement.sideEffect === "write"
        ? effectiveWrites.length
        : requirement.sideEffect === "shell"
          ? ledger.successfulShellCalls
          : ledger.successfulReadCalls;
    const toolCallIds = requirement.sideEffect === "write"
      ? effectiveWrites.map((step) => step.toolCallId).filter((id): id is string => Boolean(id))
      : ledger.entries
          .filter((entry) => entry.successful && entry.permissionBucket === requirement.sideEffect)
          .map((entry) => entry.toolCallId)
          .filter((id): id is string => Boolean(id));
    return {
      requirementId: requirement.id,
      kind: requirement.kind,
      satisfied: successful > 0,
      reason: successful > 0 ? `存在 ${successful} 次成功 ${requirement.sideEffect} 事实` : `缺少成功 ${requirement.sideEffect} 事实`,
      toolCallIds,
    };
  }

  if (requirement.kind === "write_verification") {
    const writes = latestSuccessfulWritesByTarget(steps);
    const missing = writes.filter(({ step }) => !hasBoundVerification(step, steps));
    return {
      requirementId: requirement.id,
      kind: requirement.kind,
      satisfied: writes.length > 0 && missing.length === 0,
      reason:
        writes.length === 0
          ? "没有可验证的成功写入"
          : missing.length === 0
            ? `最终写入 ${writes.length} 项均有系统绑定验证`
            : `${missing.length}/${writes.length} 项最终写入缺少系统绑定验证`,
      toolCallIds: writes
        .flatMap(({ step }) => [step.toolCallId, ...boundVerificationIds(step, steps)])
        .filter((id): id is string => Boolean(id)),
    };
  }

  if (requirement.evidenceKind === "manual") {
    return {
      requirementId: requirement.id,
      kind: requirement.kind,
      satisfied: false,
      reason: "该验收条件需要人工确认",
      toolCallIds: [],
    };
  }

  const lastWriteIndex = findLastSuccessfulWriteIndex(steps);
  const matches = steps.filter((step, index) => {
    if (!isSuccessfulToolStep(step)) return false;
    if (requirement.afterLastWrite && index <= lastWriteIndex) return false;
    if (requirement.evidenceKind === "write_readback") {
      return step.verification?.systemAssigned === true &&
        step.verification.kind === "write_readback" &&
        step.verification.criterionIds?.includes(requirement.id) === true;
    }
    return requirement.toolNames.includes(step.tool) &&
      step.verification?.systemAssigned === true &&
      step.verification.criterionIds?.includes(requirement.id) === true;
  });
  return {
    requirementId: requirement.id,
    kind: requirement.kind,
    satisfied: matches.length > 0,
    reason: matches.length > 0 ? "存在系统绑定的验收工具证据" : "缺少系统绑定的验收工具证据",
    toolCallIds: matches.map((step) => step.toolCallId).filter((id): id is string => Boolean(id)),
  };
}

function latestSuccessfulWritesByTarget(steps: AgentToolStep[]): Array<{ step: AgentToolStep; index: number }> {
  const latest = new Map<string, { step: AgentToolStep; index: number }>();
  steps.forEach((step, index) => {
    if (!isEffectiveWriteStep(step)) return;
    const target = writeTarget(step);
    const key = target ?? `__unknown_write_target__:${step.toolCallId ?? index}`;
    latest.set(key, { step, index });
  });
  return [...latest.values()];
}

function hasBoundVerification(write: AgentToolStep, steps: AgentToolStep[]): boolean {
  return boundVerificationIds(write, steps).length > 0;
}

function boundVerificationIds(write: AgentToolStep, steps: AgentToolStep[]): string[] {
  if (!write.toolCallId) return [];
  const writeIndex = steps.indexOf(write);
  return steps
    .slice(writeIndex + 1)
    .filter(
      (step) =>
        isSuccessfulToolStep(step) &&
        step.verification?.systemAssigned === true &&
        step.verification.verifiesToolCallId === write.toolCallId,
    )
    .map((step) => step.toolCallId)
    .filter((id): id is string => Boolean(id));
}

function findLastSuccessfulWriteIndex(steps: AgentToolStep[]): number {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (isEffectiveWriteStep(steps[index]!)) return index;
  }
  return -1;
}

function writeTarget(step: AgentToolStep): string | undefined {
  const output = asRecord(step.resultLayers?.raw) ?? asRecord(step.output);
  const input = asRecord(step.input);
  const value = output?.path ?? input?.path;
  return typeof value === "string" && value.trim() ? value.replace(/\\/g, "/").toLowerCase() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
