import type { AgentExecutionMeta } from "./RunPolicyTypes.js";

/**
 * 运行态词汇分层（P5 SSOT）。
 * - 用户可见：`userFacingLabel` / `userFacingState` / `executionStage`
 * - 任务语义：`intent` / `workflowType`
 * - 内部预算：`mode` / `entryIntent` / `entryWorkflowType` / `reconciled*`
 */
export const INTERNAL_EXECUTION_META_FIELDS = [
  "mode",
  "modeSource",
  "entryIntent",
  "entryWorkflowType",
  "reconciledIntent",
  "reconciledWorkflowType",
] as const;

export type InternalExecutionMetaField = (typeof INTERNAL_EXECUTION_META_FIELDS)[number];

export const PUBLIC_EXECUTION_META_FIELDS = [
  "executionStage",
  "intent",
  "workflowType",
  "permissionPolicy",
  "permissionPolicySource",
  "userFacingState",
  "userFacingLabel",
  "stopReason",
  "budget",
  "usage",
  "budgetExhausted",
  "needsMoreBudget",
  "suggestedBudget",
  "usedIterations",
  "usedModelTurns",
  "usedToolCalls",
  "usedReadCalls",
  "usedWriteCalls",
  "usedShellCalls",
  "location",
  "planVariant",
  "intentDecisionSource",
] as const;

export type PublicExecutionMeta = Omit<AgentExecutionMeta, InternalExecutionMetaField>;

/** 非 dev 展示/API 导出时剥离内部 mode 词汇，保留任务语义与预算用量。 */
export function toPublicExecutionMeta(meta: AgentExecutionMeta): PublicExecutionMeta {
  const {
    mode: _mode,
    modeSource: _modeSource,
    entryIntent: _entryIntent,
    entryWorkflowType: _entryWorkflowType,
    reconciledIntent: _reconciledIntent,
    reconciledWorkflowType: _reconciledWorkflowType,
    ...rest
  } = meta;
  void _mode;
  void _modeSource;
  void _entryIntent;
  void _entryWorkflowType;
  void _reconciledIntent;
  void _reconciledWorkflowType;
  return rest as PublicExecutionMeta;
}

export function isInternalExecutionMetaField(
  key: string,
): key is InternalExecutionMetaField {
  return (INTERNAL_EXECUTION_META_FIELDS as readonly string[]).includes(key);
}
