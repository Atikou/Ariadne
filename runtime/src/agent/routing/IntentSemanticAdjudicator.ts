import type { AgentIntentType } from "../IntentTypes.js";
import { defaultWorkflowPlanner } from "../WorkflowPlanner.js";
import { defaultWorkflowRouter } from "../WorkflowRouter.js";
import { runModeForIntent } from "../intentPatterns.js";
import type { TaskContext } from "../task/TaskContext.js";
import type { IntentDecision, IntentDecisionSource } from "./IntentDecision.js";
import { inferRequiredSideEffectsFromMessage } from "./SideEffectInference.js";
import type { MessageContinuationSignals } from "./MessageSignalExtractor.js";
import type { TaskBoundaryDecision } from "./TaskBoundaryDecision.js";

const NON_EXECUTABLE_INTENTS = new Set<AgentIntentType>([
  "answer",
  "summarize",
  "search",
  "review",
  "plan",
]);

const EXECUTION_INTENTS = new Set<AgentIntentType>(["run", "verify", "debug"]);

export interface AdjudicateIntentInput {
  candidate: IntentDecision;
  candidateSource: IntentDecisionSource;
  message: string;
  signals: MessageContinuationSignals;
  boundary: TaskBoundaryDecision;
  taskContext?: TaskContext;
}

/** 代码结构化裁决：校验 AI/legacy 候选在当前任务状态下是否合理。 */
export function adjudicateIntentCandidate(input: AdjudicateIntentInput): IntentDecision {
  const required =
    input.boundary.requiredSideEffects.length > 0
      ? input.boundary.requiredSideEffects
      : inferRequiredSideEffectsFromMessage(input.message, input.signals);

  let intent = input.candidate.intent;
  let reason = input.candidate.reason;
  let source: IntentDecisionSource = input.candidateSource;
  let corrected = false;

  if (required.includes("write") && NON_EXECUTABLE_INTENTS.has(intent)) {
    intent = "edit";
    corrected = true;
    reason = `语义候选为 ${input.candidate.intent}，但任务需要修改产物（write），纠偏为 edit`;
  }

  if (
    required.includes("shell") &&
    !EXECUTION_INTENTS.has(intent) &&
    intent !== "plan"
  ) {
    intent = "run";
    corrected = true;
    reason = `语义候选为 ${input.candidate.intent}，但任务需要 shell，纠偏为 run`;
  }

  if (
    input.taskContext?.isActive &&
    isSideEffectIntent(input.taskContext.intent) &&
    NON_EXECUTABLE_INTENTS.has(intent) &&
    !required.includes("shell")
  ) {
    intent = input.taskContext.intent;
    corrected = true;
    reason = `语义候选为 ${input.candidate.intent}，活跃副作用任务 ${input.taskContext.intent} 未被只读降级`;
    source = "task_continuation";
  }

  if (!corrected) {
    return { ...input.candidate, source: input.candidateSource };
  }

  const mode = runModeForIntent(intent);
  const workflowType = defaultWorkflowRouter.routeIntent(intent).workflowType;
  const isActiveTask = input.taskContext?.isActive === true;
  return {
    ...input.candidate,
    mode,
    modeSource: "inferred",
    intent,
    workflowType,
    workflowPlan: defaultWorkflowPlanner.plan(input.message, mode, intent),
    needsWrite: required.includes("write") || intent === "edit" || intent === "generate_file" || intent === "refactor",
    needsRunCommand:
      required.includes("shell") || intent === "run" || intent === "verify" || intent === "debug",
    source: source === "task_continuation" ? source : "intent_adjudicator",
    reason,
    confidence: Math.max(input.candidate.confidence, 0.78),
    isContinuation: source === "task_continuation" ? true : false,
    isNewTask: source === "task_continuation" ? false : !isActiveTask,
  };
}

function isSideEffectIntent(intent: AgentIntentType): boolean {
  return (
    intent === "edit" ||
    intent === "run" ||
    intent === "debug" ||
    intent === "verify" ||
    intent === "refactor" ||
    intent === "generate_file"
  );
}
