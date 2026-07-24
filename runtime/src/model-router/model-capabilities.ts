import {
  explainNoAvailableModel,
  profileSatisfiesDeclaredCapabilities,
  profileSatisfiesPrivacy,
  resolveTaskRequirement,
  type DeclaredCapabilityKey,
} from "./model-capability-profile.js";
import type {
  ModelLevel,
  ModelProfile,
  ModelRole,
  RouterInput,
  RuleRouteResult,
  TaskType,
} from "./types.js";

export { explainNoAvailableModel, resolveTaskRequirement };

/** 模型侧可匹配的能力字段（V5 能力矩阵）。 */
export interface ModelCapabilityFlags {
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsJsonMode: boolean;
  maxInputTokens: number;
  maxOutputTokens: number;
  defaultLevel: ModelLevel;
}

/** 任务类型 → 最低能力要求（与 RuleRouter 规则互补，可被 rule 字段覆盖加强）。 */
export interface TaskCapabilityRequirement {
  taskType: TaskType;
  minLevel: ModelLevel;
  supportsVision?: boolean;
  supportsTools?: boolean;
  supportsJsonMode?: boolean;
  minInputTokens?: number;
  description: string;
}

export const TASK_CAPABILITY_MATRIX: readonly TaskCapabilityRequirement[] = [
  { taskType: "casual_chat", minLevel: 1, description: "短问候/闲聊" },
  { taskType: "companion_chat", minLevel: 1, description: "陪伴对话" },
  { taskType: "memory_write", minLevel: 1, description: "记忆写入" },
  { taskType: "memory_search", minLevel: 1, description: "记忆检索" },
  { taskType: "summary", minLevel: 1, description: "摘要压缩" },
  { taskType: "intent_classification", minLevel: 1, description: "意图分类" },
  { taskType: "simple_qa", minLevel: 1, description: "简单问答" },
  { taskType: "technical_qa", minLevel: 2, description: "技术问答" },
  { taskType: "code_question", minLevel: 2, description: "代码解释/问答" },
  { taskType: "debug", minLevel: 2, description: "调试分析" },
  { taskType: "document_qa", minLevel: 2, description: "文档/TodoList 整理" },
  { taskType: "code_edit", minLevel: 3, supportsTools: true, description: "代码修改" },
  { taskType: "architecture", minLevel: 3, description: "架构/方案设计" },
  { taskType: "image_qa", minLevel: 3, supportsVision: true, description: "图片理解" },
  { taskType: "tool_action", minLevel: 2, supportsTools: true, description: "工具调用任务" },
  {
    taskType: "high_risk_action",
    minLevel: 3,
    supportsJsonMode: true,
    description: "高风险写操作/需审查",
  },
  { taskType: "unknown", minLevel: 1, description: "未分类任务" },
] as const;

const MATRIX_BY_TASK = new Map<TaskType, TaskCapabilityRequirement>(
  TASK_CAPABILITY_MATRIX.map((row) => [row.taskType, row]),
);

export function extractCapabilityFlags(profile: ModelProfile): ModelCapabilityFlags {
  return {
    supportsStreaming: profile.supportsStreaming,
    supportsTools: profile.supportsTools,
    supportsVision: profile.supportsVision,
    supportsJsonMode: profile.supportsJsonMode,
    maxInputTokens: profile.maxInputTokens,
    maxOutputTokens: profile.maxOutputTokens,
    defaultLevel: profile.defaultLevel,
  };
}

/** 合并任务矩阵基线与 RuleRouter 动态要求（取更严格一侧）。 */
export function resolveEffectiveRequirements(rule: RuleRouteResult): TaskCapabilityRequirement {
  const base = MATRIX_BY_TASK.get(rule.taskType) ?? MATRIX_BY_TASK.get("unknown")!;
  const minLevel = Math.max(base.minLevel, rule.requiredLevel) as ModelLevel;
  return {
    taskType: rule.taskType,
    minLevel,
    supportsVision: Boolean(base.supportsVision || rule.requireVision),
    supportsTools: Boolean(base.supportsTools || rule.requireTools),
    supportsJsonMode: Boolean(base.supportsJsonMode || rule.requireJsonMode),
    minInputTokens: base.minInputTokens,
    description: base.description,
  };
}

/** 按角色放宽/收紧要求：draft 允许轻量本地模型；review 对齐 rule.requiredLevel。 */
export function resolveRoleRequirements(
  rule: RuleRouteResult,
  role: ModelRole,
): TaskCapabilityRequirement {
  const effective = resolveEffectiveRequirements(rule);
  if (role === "draft") {
    return {
      ...effective,
      minLevel: 1,
      supportsVision: false,
      supportsTools: false,
      supportsJsonMode: false,
    };
  }
  if (role === "review") {
    return {
      ...effective,
      minLevel: rule.requiredLevel,
    };
  }
  return {
    ...effective,
    minLevel: Math.max(effective.minLevel, rule.requiredLevel) as ModelLevel,
  };
}

const DRAFT_GENERAL_TYPES: TaskType[] = ["technical_qa", "simple_qa", "summary", "document_qa"];

function taskAllowed(profile: ModelProfile, taskType: TaskType): boolean {
  return profile.allowedTaskTypes.includes(taskType) || profile.allowedTaskTypes.includes("unknown");
}

function draftTaskAllowed(profile: ModelProfile, taskType: TaskType, allowDraftGeneralTypes?: boolean): boolean {
  if (taskAllowed(profile, taskType)) return true;
  if (!allowDraftGeneralTypes) return false;
  return DRAFT_GENERAL_TYPES.some((t) => profile.allowedTaskTypes.includes(t));
}

function roleAllowed(profile: ModelProfile, role: ModelRole): boolean {
  if (role === "primary") return profile.canFinal && profile.allowedRoles.includes("primary");
  if (role === "draft") return profile.canDraft && profile.allowedRoles.includes("draft");
  if (role === "review") return profile.canReview && profile.allowedRoles.includes("review");
  return profile.canFinal && profile.allowedRoles.includes("final");
}

export function profileSatisfiesRequirements(
  profile: ModelProfile,
  requirement: TaskCapabilityRequirement,
  opts?: {
    role?: ModelRole;
    localOnly?: boolean;
    contextTokenEstimate?: number;
    allowDraftGeneralTypes?: boolean;
    rule?: RuleRouteResult;
    routerInput?: Pick<RouterInput, "userInput" | "hasAttachments" | "attachmentTypes" | "agentProtocolRequired">;
  },
): boolean {
  if (!profile.enabled) return false;
  if (opts?.localOnly && profile.provider !== "local") return false;

  const role = opts?.role ?? "primary";
  if (!roleAllowed(profile, role)) return false;

  if (profile.defaultLevel < requirement.minLevel) return false;

  const flags = extractCapabilityFlags(profile);
  if (requirement.supportsVision && !flags.supportsVision) return false;
  if (requirement.supportsTools && !flags.supportsTools) return false;
  if (requirement.supportsJsonMode && !flags.supportsJsonMode) return false;

  const tokenNeed = opts?.contextTokenEstimate ?? requirement.minInputTokens ?? 0;
  if (tokenNeed > 0 && flags.maxInputTokens < tokenNeed) return false;

  if (!draftTaskAllowed(profile, requirement.taskType, opts?.allowDraftGeneralTypes && role === "draft")) {
    return false;
  }

  if (opts?.rule) {
    const taskReq = resolveTaskRequirement(opts.rule, {
      userInput: opts.routerInput?.userInput ?? "",
      localOnly: opts.localOnly,
      hasAttachments: opts.routerInput?.hasAttachments,
      attachmentTypes: opts.routerInput?.attachmentTypes,
    });
    const requiredCaps: DeclaredCapabilityKey[] =
      role === "draft"
        ? [
            "text",
            ...(taskReq.requiredCapabilities.includes("image") ? (["image"] as const) : []),
          ]
        : taskReq.requiredCapabilities;
    if (!profileSatisfiesDeclaredCapabilities(profile, requiredCaps)) return false;
    if (!profileSatisfiesPrivacy(profile, { sensitive: taskReq.sensitive, localOnly: taskReq.localOnly })) {
      return false;
    }
  }

  return true;
}

export interface ListProfilesForRoleOptions {
  localOnly?: boolean;
  contextTokenEstimate?: number;
  allowDraftGeneralTypes?: boolean;
  routerInput?: Pick<RouterInput, "userInput" | "hasAttachments" | "attachmentTypes" | "agentProtocolRequired">;
}

export function listProfilesForRole(
  profiles: ModelProfile[],
  rule: RuleRouteResult,
  role: ModelRole,
  opts?: ListProfilesForRoleOptions,
): ModelProfile[] {
  const requirement = resolveRoleRequirements(rule, role);
  return profiles.filter((profile) =>
    profileSatisfiesRequirements(profile, requirement, {
      role,
      localOnly: opts?.localOnly,
      contextTokenEstimate: opts?.contextTokenEstimate,
      allowDraftGeneralTypes: opts?.allowDraftGeneralTypes,
      rule,
      routerInput: opts?.routerInput,
    }),
  );
}

/** 启动校验：每个需模型的任务类型至少有一个 primary 候选。 */
export function validateCapabilityMatrixCoverage(profiles: ModelProfile[]): string[] {
  const enabled = profiles.filter((p) => p.enabled);
  const warnings: string[] = [];

  for (const row of TASK_CAPABILITY_MATRIX) {
    if (row.minLevel === 0) continue;
    const rule: RuleRouteResult = {
      taskType: row.taskType,
      requiredLevel: row.minLevel,
      risk: row.taskType === "high_risk_action" ? "high" : "low",
      reason: "capability-matrix-coverage-check",
      requireVision: row.supportsVision,
      requireTools: row.supportsTools,
      requireJsonMode: row.supportsJsonMode,
    };
    const primary = listProfilesForRole(enabled, rule, "primary");
    if (primary.length === 0) {
      warnings.push(`任务类型 ${row.taskType} 无可用 primary 模型（minLevel=${row.minLevel}）`);
    }

    if (row.taskType === "architecture" || row.taskType === "document_qa") {
      const review = listProfilesForRole(enabled, rule, "review");
      if (review.length === 0) {
        warnings.push(`任务类型 ${row.taskType} 无可用 review 模型（协作可能降级）`);
      }
    }
  }

  return warnings;
}

export interface TaskCapabilityCoverage {
  taskType: TaskType;
  minLevel: ModelLevel;
  supportsVision: boolean;
  supportsTools: boolean;
  supportsJsonMode: boolean;
  primaryCandidates: string[];
  draftCandidates: string[];
  reviewCandidates: string[];
  uncovered: boolean;
}

export interface CapabilityMatrixSnapshot {
  profiles: Array<
    ModelProfile & { capabilities: ModelCapabilityFlags; declaredCapabilities: ModelProfile["declaredCapabilities"] }
  >;
  matrix: TaskCapabilityRequirement[];
  coverage: TaskCapabilityCoverage[];
  validationWarnings: string[];
}

export function buildCapabilityMatrixSnapshot(profiles: ModelProfile[]): CapabilityMatrixSnapshot {
  const enabled = profiles.filter((p) => p.enabled);
  const coverage: TaskCapabilityCoverage[] = TASK_CAPABILITY_MATRIX.map((row) => {
    const rule: RuleRouteResult = {
      taskType: row.taskType,
      requiredLevel: row.minLevel,
      risk: row.taskType === "high_risk_action" ? "high" : "low",
      reason: "matrix-snapshot",
      requireVision: row.supportsVision,
      requireTools: row.supportsTools,
      requireJsonMode: row.supportsJsonMode,
    };
    const req = resolveEffectiveRequirements(rule);
    const primary = listProfilesForRole(enabled, rule, "primary");
    const draft = listProfilesForRole(enabled, rule, "draft", { allowDraftGeneralTypes: true });
    const review = listProfilesForRole(enabled, rule, "review");
    return {
      taskType: row.taskType,
      minLevel: req.minLevel,
      supportsVision: Boolean(req.supportsVision),
      supportsTools: Boolean(req.supportsTools),
      supportsJsonMode: Boolean(req.supportsJsonMode),
      primaryCandidates: primary.map((p) => p.id),
      draftCandidates: draft.map((p) => p.id),
      reviewCandidates: review.map((p) => p.id),
      uncovered: row.minLevel > 0 && primary.length === 0,
    };
  });

  return {
    profiles: profiles.map((profile) => ({
      ...profile,
      capabilities: extractCapabilityFlags(profile),
      declaredCapabilities: profile.declaredCapabilities,
    })),
    matrix: [...TASK_CAPABILITY_MATRIX],
    coverage,
    validationWarnings: validateCapabilityMatrixCoverage(profiles),
  };
}
