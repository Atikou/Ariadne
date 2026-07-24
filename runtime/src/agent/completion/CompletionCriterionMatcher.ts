import type { AgentToolStep } from "../toolStep.js";
import type { CompletionCriterionInput } from "./TaskCompletionContract.js";

/** 可信完成条件与一次实际工具调用是否严格匹配。 */
export function criterionMatchesToolStep(
  criterion: Pick<CompletionCriterionInput, "toolNames" | "expectedInputSubset">,
  step: AgentToolStep,
): boolean {
  if (!(criterion.toolNames ?? []).includes(step.tool)) return false;
  return matchesSubset(criterion.expectedInputSubset, asRecord(step.input));
}

/** 写入读回验收只绑定其声明的目标产物；未声明目标时绑定当前写入。 */
export function criterionMatchesWriteTarget(
  criterion: Pick<CompletionCriterionInput, "targetPath">,
  writeStep: AgentToolStep,
): boolean {
  if (!criterion.targetPath) return true;
  const input = asRecord(writeStep.input);
  const output = asRecord(writeStep.resultLayers?.raw) ?? asRecord(writeStep.output);
  const actual = stringValue(output?.path) ?? stringValue(input?.path);
  return actual ? sameLogicalPath(actual, criterion.targetPath) : false;
}

function matchesSubset(
  expected: Record<string, unknown> | undefined,
  actual: Record<string, unknown> | undefined,
): boolean {
  if (!expected || Object.keys(expected).length === 0) return true;
  if (!actual) return false;
  return Object.entries(expected).every(([key, value]) => valuesEqual(value, actual[key], key));
}

function valuesEqual(expected: unknown, actual: unknown, key: string): boolean {
  if (key === "path" && typeof expected === "string" && typeof actual === "string") {
    return sameLogicalPath(actual, expected);
  }
  if (Array.isArray(expected)) {
    return Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((item, index) => valuesEqual(item, actual[index], key));
  }
  const expectedRecord = asRecord(expected);
  if (expectedRecord) return matchesSubset(expectedRecord, asRecord(actual));
  return Object.is(expected, actual);
}

function sameLogicalPath(actual: string, expected: string): boolean {
  const normalizedActual = normalizePath(actual);
  const normalizedExpected = normalizePath(expected);
  return normalizedActual === normalizedExpected || normalizedActual.endsWith(`/${normalizedExpected}`);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
