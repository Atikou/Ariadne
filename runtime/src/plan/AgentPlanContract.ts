import { randomUUID } from "node:crypto";
import { z } from "zod";

const nonBlank = z.string().trim().min(1);
const planId = z.string().trim().min(1);
const positiveInteger = z.number().int().positive();

export const AgentPlanStateSchema = z.enum([
  "collecting_context",
  "needs_clarification",
  "ready_for_confirmation",
  "approved",
  "superseded",
]);
export type AgentPlanState = z.infer<typeof AgentPlanStateSchema>;

export const AgentPlanExecutionStateSchema = z.enum([
  "not_started",
  "in_progress",
  "blocked",
  "completed",
  "failed",
]);
export type AgentPlanExecutionState = z.infer<typeof AgentPlanExecutionStateSchema>;

export const AgentPlanStepStatusSchema = z.enum([
  "pending",
  "in_progress",
  "blocked",
  "completed",
  "failed",
]);

export const AgentPlanFactSchema = z.object({
  id: nonBlank,
  statement: nonBlank,
  evidence: nonBlank,
}).strict();

export const AgentPlanConstraintSchema = z.object({
  id: nonBlank,
  kind: z.enum(["constraint", "non_goal", "assumption"]),
  statement: nonBlank,
}).strict();

export const AgentPlanClarificationSchema = z.object({
  id: nonBlank,
  question: nonBlank,
  impact: nonBlank,
}).strict();

export const AgentPlanDraftStepSchema = z.object({
  id: nonBlank,
  title: nonBlank,
  dependsOn: z.array(nonBlank).max(16).default([]),
  action: nonBlank,
  scope: z.array(nonBlank).min(1).max(32),
  expectedOutcome: nonBlank,
  verification: nonBlank,
}).strict();

export const AgentPlanCompletionCriterionSchema = z.object({
  id: nonBlank,
  behavior: nonBlank,
  verification: nonBlank,
}).strict();

export const AgentPlanModelDraftSchema = z.object({
  basePlanId: planId.optional(),
  baseVersion: positiveInteger.optional(),
  title: nonBlank,
  goal: nonBlank,
  facts: z.array(AgentPlanFactSchema).min(1).max(64),
  constraints: z.array(AgentPlanConstraintSchema).max(64).default([]),
  clarifications: z.array(AgentPlanClarificationSchema).max(12).default([]),
  steps: z.array(AgentPlanDraftStepSchema).max(7).default([]),
  completionCriteria: z.array(AgentPlanCompletionCriterionSchema).max(32).default([]),
}).strict().superRefine((draft, context) => {
  if ((draft.basePlanId === undefined) !== (draft.baseVersion === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["baseVersion"],
      message: "basePlanId 与 baseVersion 必须同时提供",
    });
  }
});
export type AgentPlanModelDraft = z.infer<typeof AgentPlanModelDraftSchema>;

export const AgentPlanQualityIssueCodeSchema = z.enum([
  "invalid_schema",
  "missing_execution_steps",
  "critical_ambiguity_with_steps",
  "inconsistent_step_granularity",
  "invalid_step_dependency",
  "context_check_is_execution_step",
  "unfounded_limit",
  "optional_verification",
  "missing_completion_criteria",
  "vague_completion_criterion",
]);
export type AgentPlanQualityIssueCode = z.infer<typeof AgentPlanQualityIssueCodeSchema>;

export const AgentPlanQualityIssueSchema = z.object({
  code: AgentPlanQualityIssueCodeSchema,
  severity: z.enum(["warning", "critical"]),
  message: nonBlank,
  path: z.string().optional(),
}).strict();
export type AgentPlanQualityIssue = z.infer<typeof AgentPlanQualityIssueSchema>;

export const AgentPlanStepSchema = AgentPlanDraftStepSchema.extend({
  status: AgentPlanStepStatusSchema,
  actualScope: z.array(z.string()).default([]),
  evidence: z.array(z.string()).default([]),
  deviations: z.array(z.string()).default([]),
  blockingReason: z.string().optional(),
}).strict();
export type AgentPlanStep = z.infer<typeof AgentPlanStepSchema>;

export const AgentPlanContractSchema = z.object({
  schemaVersion: z.literal(1),
  planId,
  version: positiveInteger,
  sourceRunId: nonBlank,
  sessionId: nonBlank.optional(),
  supersedesVersion: positiveInteger.optional(),
  title: nonBlank,
  goal: nonBlank,
  facts: z.array(AgentPlanFactSchema).min(1).max(64),
  constraints: z.array(AgentPlanConstraintSchema).max(64),
  clarifications: z.array(AgentPlanClarificationSchema).max(12),
  steps: z.array(AgentPlanStepSchema).max(7),
  completionCriteria: z.array(AgentPlanCompletionCriterionSchema).max(32),
  planState: AgentPlanStateSchema,
  executionState: AgentPlanExecutionStateSchema,
  completeness: z.enum(["incomplete", "complete"]),
  blockingReasons: z.array(z.string()).max(32),
  qualityIssues: z.array(AgentPlanQualityIssueSchema).max(64),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export type AgentPlanContract = z.infer<typeof AgentPlanContractSchema>;

export const AgentPlanExecutionReportSchema = z.object({
  planId,
  version: positiveInteger,
  steps: z.array(z.object({
    stepId: nonBlank,
    status: z.enum(["pending", "blocked", "completed", "failed"]),
    actualScope: z.array(nonBlank).max(128).default([]),
    evidence: z.array(nonBlank).max(128).default([]),
    deviations: z.array(nonBlank).max(128).default([]),
    blockingReason: nonBlank.optional(),
  }).strict()).min(1).max(7),
}).strict();
export type AgentPlanExecutionReport = z.infer<typeof AgentPlanExecutionReportSchema>;

export interface AgentPlanExecutionReportEvaluation {
  report?: AgentPlanExecutionReport;
  issues: string[];
  acceptable: boolean;
}

export interface AgentPlanDraftEvaluation {
  draft?: AgentPlanModelDraft;
  issues: AgentPlanQualityIssue[];
  acceptable: boolean;
  needsClarification: boolean;
}

const CONTEXT_ONLY_STEP_RE =
  /^(?:检查|扫描|了解|查看|读取|分析)(?:当前)?(?:工作区|项目结构|代码库|仓库|环境|现状)/i;
const UNFOUNDED_LIMIT_RE =
  /(?:约|大约|不超过|控制在)\s*\d+\s*(?:行|小时|天|分钟)|\d+\s*(?:lines?|hours?|days?)\b/i;
const OPTIONAL_VERIFICATION_RE = /(?:可选|如有时间|如果方便|视情况|optional)/i;
const VAGUE_CRITERION_RE = /^(?:完成|完善|优化|处理|实现功能|测试通过|工作正常)[。.!！]?$/i;

export function evaluateAgentPlanDraft(input: unknown): AgentPlanDraftEvaluation {
  const parsed = AgentPlanModelDraftSchema.safeParse(input);
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((issue) => ({
        code: "invalid_schema",
        severity: "critical",
        message: issue.message,
        path: issue.path.join(".") || undefined,
      })),
      acceptable: false,
      needsClarification: false,
    };
  }

  const draft = parsed.data;
  const issues: AgentPlanQualityIssue[] = [];
  const needsClarification = draft.clarifications.length > 0;
  if (needsClarification && (draft.steps.length > 0 || draft.completionCriteria.length > 0)) {
    issues.push({
      code: "critical_ambiguity_with_steps",
      severity: "critical",
      message: "存在关键歧义时不能冻结执行步骤或完成标准；应先向用户澄清。",
      path: "clarifications",
    });
  }
  if (!needsClarification && (draft.steps.length < 3 || draft.steps.length > 7)) {
    issues.push({
      code: "missing_execution_steps",
      severity: "critical",
      message: "可确认计划必须包含 3 到 7 个执行里程碑。",
      path: "steps",
    });
  }
  if (!needsClarification && draft.completionCriteria.length === 0) {
    issues.push({
      code: "missing_completion_criteria",
      severity: "critical",
      message: "可确认计划必须定义用户可观察、可重复的完成标准。",
      path: "completionCriteria",
    });
  }

  const stepIds = new Set(draft.steps.map((step) => step.id));
  for (const [index, step] of draft.steps.entries()) {
    if (step.dependsOn.some((dependency) => !stepIds.has(dependency) || dependency === step.id)) {
      issues.push({
        code: "invalid_step_dependency",
        severity: "critical",
        message: `步骤 ${step.id} 包含不存在或自引用的依赖。`,
        path: `steps.${index}.dependsOn`,
      });
    }
    if (CONTEXT_ONLY_STEP_RE.test(step.action) || CONTEXT_ONLY_STEP_RE.test(step.title)) {
      issues.push({
        code: "context_check_is_execution_step",
        severity: "critical",
        message: `步骤 ${step.id} 把计划阶段的环境检查错误地列为了执行任务。`,
        path: `steps.${index}`,
      });
    }
    if (UNFOUNDED_LIMIT_RE.test(`${step.title} ${step.action} ${step.expectedOutcome}`)) {
      issues.push({
        code: "unfounded_limit",
        severity: "critical",
        message: `步骤 ${step.id} 包含没有依据的行数或时间限制。`,
        path: `steps.${index}`,
      });
    }
    if (OPTIONAL_VERIFICATION_RE.test(step.verification)) {
      issues.push({
        code: "optional_verification",
        severity: "critical",
        message: `步骤 ${step.id} 把必要验证写成了可选项。`,
        path: `steps.${index}.verification`,
      });
    }
  }
  if (hasDependencyCycle(draft.steps)) {
    issues.push({
      code: "invalid_step_dependency",
      severity: "critical",
      message: "执行步骤依赖图存在循环。",
      path: "steps",
    });
  }
  for (const [index, criterion] of draft.completionCriteria.entries()) {
    if (VAGUE_CRITERION_RE.test(criterion.behavior) || VAGUE_CRITERION_RE.test(criterion.verification)) {
      issues.push({
        code: "vague_completion_criterion",
        severity: "critical",
        message: `完成标准 ${criterion.id} 不能被用户观察或重复验证。`,
        path: `completionCriteria.${index}`,
      });
    }
  }
  if (!needsClarification && hasInconsistentGranularity(draft.steps)) {
    issues.push({
      code: "inconsistent_step_granularity",
      severity: "warning",
      message: "执行里程碑的描述粒度差异较大，请在执行时按完整模块而非零碎实现细节推进。",
      path: "steps",
    });
  }

  return {
    draft,
    issues,
    acceptable: !issues.some((issue) => issue.severity === "critical"),
    needsClarification,
  };
}

export function createAgentPlanContract(input: {
  draft: AgentPlanModelDraft;
  issues: AgentPlanQualityIssue[];
  runId: string;
  sessionId?: string;
  planId?: string;
  version?: number;
  supersedesVersion?: number;
}): AgentPlanContract {
  const now = new Date().toISOString();
  const needsClarification = input.draft.clarifications.length > 0;
  return AgentPlanContractSchema.parse({
    schemaVersion: 1,
    planId: input.planId ?? `plan_${randomUUID()}`,
    version: input.version ?? 1,
    sourceRunId: input.runId,
    sessionId: input.sessionId,
    supersedesVersion: input.supersedesVersion,
    title: input.draft.title,
    goal: input.draft.goal,
    facts: input.draft.facts,
    constraints: input.draft.constraints,
    clarifications: input.draft.clarifications,
    steps: input.draft.steps.map((step) => ({
      ...step,
      status: "pending",
      actualScope: [],
      evidence: [],
      deviations: [],
    })),
    completionCriteria: input.draft.completionCriteria,
    planState: needsClarification ? "needs_clarification" : "ready_for_confirmation",
    executionState: "not_started",
    completeness: needsClarification ? "incomplete" : "complete",
    blockingReasons: needsClarification
      ? input.draft.clarifications.map((item) => item.impact)
      : [],
    qualityIssues: input.issues,
    createdAt: now,
    updatedAt: now,
  });
}

export function renderAgentPlanMarkdown(plan: AgentPlanContract): string {
  const lines = [
    `# ${plan.title}`,
    "",
    `**Plan v${plan.version}**`,
    `- 计划状态：${planStateLabel(plan.planState)}`,
    `- 执行状态：${executionStateLabel(plan.executionState)}`,
    `- 计划完整性：${plan.completeness === "complete" ? "完整" : "需要补充"}`,
    `- 阻塞状态：${plan.blockingReasons.length > 0 ? plan.blockingReasons.join("；") : "无"}`,
    "",
    "## 目标",
    "",
    plan.goal,
    "",
    "## 已知事实",
    "",
    ...plan.facts.map((fact) => `- ${fact.statement}（证据：${fact.evidence}）`),
    "",
    "## 约束与非目标",
    "",
    ...(plan.constraints.length > 0
      ? plan.constraints.map((item) => `- [${constraintKindLabel(item.kind)}] ${item.statement}`)
      : ["- 无额外约束。"]),
    "",
    "## 待确认决策",
    "",
    ...(plan.clarifications.length > 0
      ? plan.clarifications.map((item) => `- ${item.question}（影响：${item.impact}）`)
      : ["- 无。"]),
    "",
    "## 执行步骤",
    "",
    ...(plan.steps.length > 0
      ? plan.steps.flatMap((step, index) => [
          `### ${index + 1}. ${step.title}`,
          `- 动作：${step.action}`,
          `- 范围：${step.scope.join("、")}`,
          `- 预期结果：${step.expectedOutcome}`,
          `- 验证：${step.verification}`,
          `- 依赖：${step.dependsOn.length > 0 ? step.dependsOn.join("、") : "无"}`,
          "",
        ])
      : ["计划需先解决待确认决策，尚未冻结执行步骤。", ""]),
    "## 完成标准",
    "",
    ...(plan.completionCriteria.length > 0
      ? plan.completionCriteria.map((item) => `- ${item.behavior}（验证：${item.verification}）`)
      : ["- 待确认关键决策后补充。"]),
  ];
  return lines.join("\n").trim();
}

export function renderAgentPlanClarification(plan: AgentPlanContract): string {
  return [
    `## ${plan.title}`,
    "",
    plan.goal,
    "",
    "### 需要你确认的关键决策",
    "",
    ...plan.clarifications.map((item, index) =>
      `${index + 1}. ${item.question}\n   影响：${item.impact}`),
    "",
    "确认这些决策后，我会继续只读分析并生成可验证的 Plan v"
      + `${plan.version + 1}；现在尚未进入执行阶段。`,
  ].join("\n");
}

export function planDraftRepairMessage(evaluation: AgentPlanDraftEvaluation): string {
  return [
    "计划草案未通过质量校验，不能进入等待确认状态。",
    ...evaluation.issues.map((issue) =>
      `- ${issue.code}${issue.path ? ` (${issue.path})` : ""}: ${issue.message}`),
    "请继续保持只读，修正 plan 字段后重新返回 final action。",
  ].join("\n");
}

export function evaluateAgentPlanExecutionReport(
  plan: AgentPlanContract,
  input: unknown,
): AgentPlanExecutionReportEvaluation {
  const parsed = AgentPlanExecutionReportSchema.safeParse(input);
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((issue) =>
        `${issue.path.join(".") || "planExecution"}: ${issue.message}`),
      acceptable: false,
    };
  }
  const report = parsed.data;
  const issues: string[] = [];
  if (report.planId !== plan.planId || report.version !== plan.version) {
    issues.push(
      `执行报告引用 ${report.planId} v${report.version}，与已批准的 ${plan.planId} v${plan.version} 不一致。`,
    );
  }
  const expectedIds = new Set(plan.steps.map((step) => step.id));
  const reportedIds = new Set<string>();
  for (const item of report.steps) {
    if (!expectedIds.has(item.stepId)) issues.push(`执行报告包含未知步骤 ${item.stepId}。`);
    if (reportedIds.has(item.stepId)) issues.push(`执行报告重复包含步骤 ${item.stepId}。`);
    reportedIds.add(item.stepId);
    if (item.status === "completed" && item.evidence.length === 0) {
      issues.push(`已完成步骤 ${item.stepId} 缺少验证证据。`);
    }
    if (
      (item.status === "blocked" || item.status === "failed")
      && !item.blockingReason
    ) {
      issues.push(`${item.status === "blocked" ? "阻塞" : "失败"}步骤 ${item.stepId} 缺少原因。`);
    }
  }
  for (const id of expectedIds) {
    if (!reportedIds.has(id)) issues.push(`执行报告缺少计划步骤 ${id}。`);
  }
  return {
    report,
    issues,
    acceptable: issues.length === 0,
  };
}

export function planExecutionRepairMessage(
  plan: AgentPlanContract,
  evaluation: AgentPlanExecutionReportEvaluation,
): string {
  return [
    `执行结果尚不能结算 ${plan.planId} v${plan.version}。`,
    ...evaluation.issues.map((issue) => `- ${issue}`),
    "请依据已经发生的工具结果修正 final.planExecution；不得声称没有证据的步骤已完成。",
  ].join("\n");
}

function hasDependencyCycle(steps: AgentPlanModelDraft["steps"]): boolean {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const step = byId.get(id);
    if (step?.dependsOn.some((dependency) => visit(dependency))) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return steps.some((step) => visit(step.id));
}

function hasInconsistentGranularity(steps: AgentPlanModelDraft["steps"]): boolean {
  if (steps.length < 2) return false;
  const sizes = steps.map((step) =>
    `${step.action}${step.expectedOutcome}${step.verification}`.length);
  const min = Math.min(...sizes);
  const max = Math.max(...sizes);
  return min > 0 && max / min > 4;
}

function planStateLabel(state: AgentPlanState): string {
  switch (state) {
    case "collecting_context": return "正在收集上下文";
    case "needs_clarification": return "需要澄清";
    case "ready_for_confirmation": return "等待确认";
    case "approved": return "已批准";
    case "superseded": return "已被新版本替代";
  }
}

function executionStateLabel(state: AgentPlanExecutionState): string {
  switch (state) {
    case "not_started": return "尚未开始";
    case "in_progress": return "执行中";
    case "blocked": return "阻塞";
    case "completed": return "已完成";
    case "failed": return "失败";
  }
}

function constraintKindLabel(kind: AgentPlanContract["constraints"][number]["kind"]): string {
  if (kind === "constraint") return "约束";
  if (kind === "non_goal") return "非目标";
  return "假设";
}
