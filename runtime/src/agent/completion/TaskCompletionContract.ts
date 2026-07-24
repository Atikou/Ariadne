import type { AgentIntentType } from "../IntentTypes.js";
import type { AgentRunMode } from "../RunPolicyTypes.js";

export type SideEffectKind = "read" | "write" | "shell";

export type CompletionEvidenceKind = "write_readback" | "tool_success" | "manual";

/**
 * 上层计划/任务传入的结构化验收条件。
 * description 只用于展示；FinalGuard 只按 evidenceKind/toolNames 裁决，绝不解析自然语言。
 */
export interface CompletionCriterionInput {
  id: string;
  description: string;
  evidenceKind: CompletionEvidenceKind;
  toolNames?: string[];
  /** 可信计划编译器绑定的工具输入子集；运行时工具输入必须逐字段匹配。 */
  expectedInputSubset?: Record<string, unknown>;
  /** 写入验收对应的目标产物路径。 */
  targetPath?: string;
  afterLastWrite?: boolean;
  required?: boolean;
}

/** 仅限进程内可信调用方使用，不属于公开 Agent HTTP body。 */
export interface AgentCompletionContext {
  completionCriteria?: CompletionCriterionInput[];
}

export type CompletionRequirement =
  | {
      id: string;
      kind: "side_effect";
      sideEffect: SideEffectKind;
      description: string;
      source: "routing" | "intent" | "workflow";
    }
  | {
      id: string;
      kind: "write_verification";
      description: string;
      source: "workflow";
    }
  | {
      id: string;
      kind: "acceptance";
      description: string;
      evidenceKind: CompletionEvidenceKind;
      toolNames: string[];
      expectedInputSubset?: Record<string, unknown>;
      targetPath?: string;
      afterLastWrite: boolean;
      source: "plan" | "task";
    };

export interface TaskCompletionContract {
  requiresSideEffect: boolean;
  requiredSideEffects: SideEffectKind[];
  source: "routing" | "intent";
  requirements: CompletionRequirement[];
}

export type PersistedTaskCompletionContract = Pick<
  TaskCompletionContract,
  "requiresSideEffect" | "requiredSideEffects"
> &
  Partial<Pick<TaskCompletionContract, "source" | "requirements">>;

/** Hydrates contracts saved before evidence requirements were introduced. */
export function normalizeTaskCompletionContract(
  contract: PersistedTaskCompletionContract,
): TaskCompletionContract {
  const source = contract.source ?? "intent";
  const requirements = contract.requirements
    ? [...contract.requirements]
    : contract.requiredSideEffects.map((sideEffect) => ({
        id: `side-effect:${sideEffect}`,
        kind: "side_effect" as const,
        sideEffect,
        description: `成功执行所需 ${sideEffect} 副作用`,
        source,
      }));
  if (
    contract.requiredSideEffects.includes("write") &&
    !requirements.some((item) => item.kind === "write_verification")
  ) {
    requirements.push({
      id: "workflow:write-verification",
      kind: "write_verification",
      description: "每个最终写入产物都有系统绑定的成功验证步骤",
      source: "workflow",
    });
  }
  return {
    requiresSideEffect: contract.requiresSideEffect,
    requiredSideEffects: [...contract.requiredSideEffects],
    source,
    requirements,
  };
}

/**
 * Final Guard 只消费入口路由/任务上下文产生的结构化副作用需求。
 * goal 保留用于调用兼容与审计，不参与完成契约推断。
 */
export function buildTaskCompletionContract(input: {
  goal: string;
  intent: AgentIntentType;
  mode: AgentRunMode;
  requiredSideEffects?: readonly SideEffectKind[];
  completionCriteria?: readonly CompletionCriterionInput[];
}): TaskCompletionContract {
  const required = new Set<SideEffectKind>(input.requiredSideEffects ?? []);
  const source = input.requiredSideEffects ? "routing" : "intent";

  if (!input.requiredSideEffects) {
    if (input.intent === "run" || input.intent === "verify" || input.intent === "debug") {
      required.add("shell");
    }
    if (input.intent === "edit" || input.intent === "refactor" || input.intent === "generate_file") {
      required.add("write");
    }
  }

  const requiredSideEffects = [...required];
  const requirementSource = source === "routing" ? "routing" : "intent";
  const requirements: CompletionRequirement[] = requiredSideEffects.map((sideEffect) => ({
    id: `side-effect:${sideEffect}`,
    kind: "side_effect",
    sideEffect,
    description: `成功执行所需 ${sideEffect} 副作用`,
    source: requirementSource,
  }));
  if (required.has("write")) {
    requirements.push({
      id: "workflow:write-verification",
      kind: "write_verification",
      description: "每个最终写入产物都有系统绑定的成功验证步骤",
      source: "workflow",
    });
  }
  for (const criterion of normalizeCompletionCriteria(input.completionCriteria)) {
    if (criterion.required === false) continue;
    requirements.push({
      id: criterion.id,
      kind: "acceptance",
      description: criterion.description,
      evidenceKind: criterion.evidenceKind,
      toolNames: criterion.toolNames ?? [],
      expectedInputSubset: criterion.expectedInputSubset,
      targetPath: criterion.targetPath,
      afterLastWrite: criterion.afterLastWrite === true,
      source: "plan",
    });
  }
  return {
    requiresSideEffect: requiredSideEffects.some((kind) => kind === "write" || kind === "shell"),
    requiredSideEffects,
    source,
    requirements,
  };
}

export function normalizeCompletionCriteria(
  criteria: readonly CompletionCriterionInput[] | undefined,
): CompletionCriterionInput[] {
  const result: CompletionCriterionInput[] = [];
  const seen = new Set<string>();
  for (const raw of criteria ?? []) {
    const id = raw.id.trim();
    const description = raw.description.trim();
    if (!id || !description || seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      description,
      evidenceKind: raw.evidenceKind,
      toolNames: [...new Set((raw.toolNames ?? []).map((name) => name.trim()).filter(Boolean))],
      expectedInputSubset: cloneRecord(raw.expectedInputSubset),
      targetPath: raw.targetPath?.trim() || undefined,
      afterLastWrite: raw.afterLastWrite === true,
      required: raw.required !== false,
    });
  }
  return result;
}

function cloneRecord(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return value ? structuredClone(value) : undefined;
}
