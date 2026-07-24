import type { AgentIntentType, AgentWorkflowType } from "./IntentTypes.js";
import type { AgentWorkflowInternalPlan, UserPermissionPolicy } from "./RunPolicyTypes.js";

export interface ImplicitPlanWorkflowInput {
  goal: string;
  intent: AgentIntentType;
  workflowType: AgentWorkflowType;
  permissionPolicy: UserPermissionPolicy;
}

export interface ImplicitPlanWorkflowResult {
  modelContext: string;
  plan: AgentWorkflowInternalPlan;
}

export const IMPLICIT_PLAN_MAX_STEPS = 8;

const requiredImplicitFields = ["goalSummary", "internalSteps", "successCriteria", "stopConditions"];

const READ_ONLY_INTENTS = new Set<AgentIntentType>(["answer", "plan", "summarize", "search", "review"]);
const SIDE_EFFECT_INTENTS = new Set<AgentIntentType>(["edit", "debug", "generate_file", "run", "verify"]);

const MULTI_ACTION_RE =
  /(?:并且|然后|接着|同时|以及|并|再|先.{0,12}再).{0,30}(?:修改|测试|验证|运行|生成|修复|更新|添加|检查)/;
const MULTI_STEP_LANGUAGE_RE = /多个|若干|分阶段|步骤|全流程|多文件|多模块/;

export interface TaskComplexityAssessment {
  complex: boolean;
  signals: string[];
}

export function assessTaskComplexity(goal: string): TaskComplexityAssessment {
  const text = goal.trim();
  const signals: string[] = [];
  if (text.length >= 72) signals.push("long_goal");
  if (MULTI_ACTION_RE.test(text)) signals.push("multi_action");
  if ((text.match(/[、,，;；]/g) || []).length >= 2) signals.push("multi_clause");
  if (MULTI_STEP_LANGUAGE_RE.test(text)) signals.push("multi_step_language");
  return { complex: signals.length > 0, signals };
}

/**
 * Internal lightweight plan for complex side-effect tasks.
 *
 * This is NOT user-visible plan mode: it only gives the executor a stable step
 * checklist before tool calls begin.
 */
export class ImplicitPlanWorkflow {
  run(input: ImplicitPlanWorkflowInput): ImplicitPlanWorkflowResult | undefined {
    if (!shouldRunImplicitPlan(input.intent, input.goal)) return undefined;
    const complexity = assessTaskComplexity(input.goal);
    return {
      modelContext: renderImplicitPlanContext(input, complexity.signals),
      plan: buildImplicitPlan(input, complexity.signals),
    };
  }
}

export function shouldRunImplicitPlan(intent: AgentIntentType, goal: string): boolean {
  if (READ_ONLY_INTENTS.has(intent) || intent === "refactor") return false;
  if (!SIDE_EFFECT_INTENTS.has(intent)) return false;
  return assessTaskComplexity(goal).complex;
}

function buildImplicitPlan(
  input: ImplicitPlanWorkflowInput,
  complexitySignals: string[],
): AgentWorkflowInternalPlan {
  return {
    workflowType: input.workflowType,
    phase: "implicit",
    goal: input.goal,
    intent: input.intent,
    permissionPolicy: input.permissionPolicy,
    requiredFields: requiredImplicitFields,
    complexitySignals,
    userVisiblePlanMode: false,
    maxSteps: IMPLICIT_PLAN_MAX_STEPS,
  };
}

function renderImplicitPlanContext(input: ImplicitPlanWorkflowInput, complexitySignals: string[]): string {
  return [
    `${input.workflowType} implicit internal plan phase:`,
    `goal: ${input.goal}`,
    `permissionPolicy: ${input.permissionPolicy}`,
    `complexitySignals: ${complexitySignals.join(", ")}`,
    `maxSteps: ${IMPLICIT_PLAN_MAX_STEPS}`,
    "userVisiblePlanMode: false",
    "",
    "This is an internal executor checklist only. It is NOT user-visible plan mode and must not be shown as a formal /api/plans document.",
    "Before side-effect tools, produce a lightweight internal plan covering:",
    "1. goalSummary: what success looks like in one paragraph.",
    "2. internalSteps: up to 8 ordered steps the executor will follow (read/locate/write/verify).",
    "3. successCriteria: concrete checks that prove the task is done.",
    "4. stopConditions: when to stop, ask for confirmation, or return partial final.",
    "",
    "Follow internalSteps sequentially. Do not skip straight to writes when earlier read/locate steps are still incomplete.",
  ].join("\n");
}
