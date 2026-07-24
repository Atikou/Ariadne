import type { ToolObservationFailureKind } from "../../tools/toolOutcome.js";
import type { AgentToolStep } from "../toolStep.js";
import { extractStepPath, isObservationFailureStep, isObservationSuccessStep } from "../toolStepOutcome.js";
import { buildDuplicateActionBlockReason } from "./ToolRecoveryPolicy.js";
import { stableToolInputKey, stepInputKey } from "./stableToolInputKey.js";

export interface FailedActionAssessment {
  blocked: true;
  reason: string;
  circuitOpen: boolean;
}

interface FailedActionRecord {
  tool: string;
  inputKey: string;
  outcomeKind: string;
  path?: string;
  executedCount: number;
  blockedCount: number;
  lastMessage: string;
}

export interface ToolLoopAction {
  tool: string;
  input?: Record<string, unknown>;
}

/**
 * 运行内失败动作记忆：相同 tool+input 在达到 maxRepeatedToolFailures 后熔断。
 * 第 1 次失败记录；第 2 次相同请求直接拦截，不再真实执行、不再消耗主 model turn。
 */
export class FailedActionMemory {
  private readonly records = new Map<string, FailedActionRecord>();

  constructor(private readonly maxRepeatedFailures = 1) {}

  record(step: AgentToolStep): void {
    if (step.cached) return;

    if (step.blocked) {
      const inputKey = stepInputKey(step.tool, step.input);
      const existing = this.findRecord(step.tool, inputKey);
      if (existing) {
        existing.blockedCount += 1;
        existing.lastMessage = step.error ?? existing.lastMessage;
      }
      return;
    }

    if (isObservationSuccessStep(step)) {
      this.invalidateAfterSuccess(step);
      return;
    }

    const isFailure =
      isObservationFailureStep(step) ||
      step.outcomeClass === "execution_error" ||
      step.ok === false;
    if (!isFailure) return;

    const outcomeKind = step.outcomeKind ?? (step.outcomeClass === "execution_error" ? "tool_crash" : "error");
    const inputKey = stepInputKey(step.tool, step.input);
    const key = this.recordKey(step.tool, inputKey, outcomeKind);
    const message = step.outcomeMessage ?? step.error ?? "unknown failure";
    const existing = this.records.get(key);
    if (existing) {
      existing.executedCount += 1;
      existing.lastMessage = message;
      return;
    }
    this.records.set(key, {
      tool: step.tool,
      inputKey,
      outcomeKind,
      path: extractStepPath(step),
      executedCount: 1,
      blockedCount: 0,
      lastMessage: message,
    });
  }

  invalidatePath(targetPath: string): void {
    const normalized = targetPath.replace(/\\/g, "/");
    for (const [key, record] of this.records.entries()) {
      if (record.outcomeKind !== "not_found") continue;
      if (record.path === normalized || record.inputKey.includes(`"path":"${normalized}"`)) {
        this.records.delete(key);
      }
    }
  }

  invalidateAfterSuccess(step: AgentToolStep): void {
    const path = extractStepPath(step);
    if (!path) return;
    if (
      step.tool === "write_file" ||
      step.tool === "apply_patch" ||
      (step.tool === "read_file" && isObservationSuccessStep(step))
    ) {
      this.invalidatePath(path);
    }
  }

  assess(action: ToolLoopAction): FailedActionAssessment | undefined {
    const input = (action.input ?? {}) as Record<string, unknown>;
    const inputKey = stableToolInputKey(action.tool, input);
    const record = this.findRecord(action.tool, inputKey);
    if (!record) return undefined;
    if (record.executedCount < this.maxRepeatedFailures) return undefined;

    const circuitOpen = record.blockedCount >= 1 || record.executedCount > this.maxRepeatedFailures;
    const path = typeof input.path === "string" ? input.path : record.path;
    return {
      blocked: true,
      circuitOpen,
      reason: buildDuplicateActionBlockReason(
        action.tool,
        { observationKind: record.outcomeKind, executedCount: record.executedCount },
        circuitOpen,
        path,
      ),
    };
  }

  shouldForcePartialFinal(lastStep?: AgentToolStep): boolean {
    return Boolean(lastStep?.recoveryCircuitOpen);
  }

  buildSummaryContext(): string | undefined {
    if (this.records.size === 0) return undefined;
    const lines = ["（系统）本 run 已记录的观察失败 / 执行异常："];
    for (const record of this.records.values()) {
      lines.push(
        `- ${record.tool} ${record.inputKey} → ${record.outcomeKind}（执行 ${record.executedCount} 次，拦截 ${record.blockedCount} 次）：${record.lastMessage}`,
      );
    }
    lines.push("请勿对相同 tool+input 重复无效调用；按恢复路线换策略或输出 final。");
    return lines.join("\n");
  }

  listRecords(): ReadonlyArray<FailedActionRecord> {
    return [...this.records.values()];
  }

  exportState(): FailedActionRecord[] {
    return [...this.records.values()];
  }

  restoreState(records: FailedActionRecord[]): void {
    this.records.clear();
    for (const record of records) {
      const key = this.recordKey(record.tool, record.inputKey, record.outcomeKind);
      this.records.set(key, { ...record });
    }
  }

  private recordKey(tool: string, inputKey: string, kind: string): string {
    return `${tool}|${inputKey}|${kind}`;
  }

  private findRecord(tool: string, inputKey: string): FailedActionRecord | undefined {
    for (const record of this.records.values()) {
      if (record.tool === tool && record.inputKey === inputKey) return record;
    }
    return undefined;
  }
}

export function isRepeatableObservationFailure(kind: string): kind is ToolObservationFailureKind {
  return [
    "not_found",
    "no_results",
    "command_failed",
    "command_not_found",
    "not_a_file",
    "empty_result",
    "no_project_info",
  ].includes(kind);
}
