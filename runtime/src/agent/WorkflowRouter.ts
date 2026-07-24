import type { AgentIntentType, AgentWorkflowType } from "./IntentTypes.js";

export type WorkflowKind = "hard" | "soft";

export function isHardWorkflow(
  route: Pick<WorkflowRouteResult, "workflowKind">,
): boolean {
  return route.workflowKind === "hard";
}

export function isSoftWorkflow(
  route: Pick<WorkflowRouteResult, "workflowKind">,
): boolean {
  return route.workflowKind === "soft";
}

export type AgentWorkflowExecutor =
  | "answerExecutor"
  | "planExecutor"
  | "editExecutor"
  | "runExecutor"
  | "debugExecutor"
  | "reviewExecutor"
  | "verifyExecutor"
  | "summarizeExecutor"
  | "searchExecutor"
  | "refactorExecutor"
  | "generateFileExecutor";

export interface WorkflowRouteInput {
  intent: AgentIntentType;
}

export interface WorkflowRouteResult {
  intent: AgentIntentType;
  workflowType: AgentWorkflowType;
  executor: AgentWorkflowExecutor;
  /** hard：只读/计划/审阅等可硬阻断副作用；soft：执行类可动态 capability escalation。 */
  workflowKind: WorkflowKind;
  readonlyOnly: boolean;
  enforceReadOnlyTools: boolean;
  sideEffectKind: "none" | "write" | "shell" | "mixed";
}

const WORKFLOW_ROUTES: Record<AgentIntentType, Omit<WorkflowRouteResult, "intent">> = {
  answer: {
    workflowType: "answerWorkflow",
    executor: "answerExecutor",
    workflowKind: "hard",
    readonlyOnly: true,
    enforceReadOnlyTools: true,
    sideEffectKind: "none",
  },
  plan: {
    workflowType: "planWorkflow",
    executor: "planExecutor",
    workflowKind: "hard",
    readonlyOnly: true,
    enforceReadOnlyTools: false,
    sideEffectKind: "none",
  },
  edit: {
    workflowType: "editWorkflow",
    executor: "editExecutor",
    workflowKind: "soft",
    readonlyOnly: false,
    enforceReadOnlyTools: false,
    sideEffectKind: "write",
  },
  run: {
    workflowType: "runWorkflow",
    executor: "runExecutor",
    workflowKind: "soft",
    readonlyOnly: false,
    enforceReadOnlyTools: false,
    sideEffectKind: "shell",
  },
  debug: {
    workflowType: "debugWorkflow",
    executor: "debugExecutor",
    workflowKind: "soft",
    readonlyOnly: false,
    enforceReadOnlyTools: false,
    sideEffectKind: "mixed",
  },
  review: {
    workflowType: "reviewWorkflow",
    executor: "reviewExecutor",
    workflowKind: "hard",
    readonlyOnly: true,
    enforceReadOnlyTools: false,
    sideEffectKind: "none",
  },
  verify: {
    workflowType: "verifyWorkflow",
    executor: "verifyExecutor",
    workflowKind: "soft",
    readonlyOnly: false,
    enforceReadOnlyTools: false,
    sideEffectKind: "shell",
  },
  summarize: {
    workflowType: "summarizeWorkflow",
    executor: "summarizeExecutor",
    workflowKind: "hard",
    readonlyOnly: true,
    enforceReadOnlyTools: true,
    sideEffectKind: "none",
  },
  search: {
    workflowType: "searchWorkflow",
    executor: "searchExecutor",
    workflowKind: "hard",
    readonlyOnly: true,
    enforceReadOnlyTools: true,
    sideEffectKind: "none",
  },
  refactor: {
    workflowType: "refactorWorkflow",
    executor: "refactorExecutor",
    workflowKind: "soft",
    readonlyOnly: false,
    enforceReadOnlyTools: false,
    sideEffectKind: "write",
  },
  generate_file: {
    workflowType: "generateFileWorkflow",
    executor: "generateFileExecutor",
    workflowKind: "soft",
    readonlyOnly: false,
    enforceReadOnlyTools: false,
    sideEffectKind: "write",
  },
};

export class WorkflowRouter {
  route(input: WorkflowRouteInput): WorkflowRouteResult {
    return this.routeIntent(input.intent);
  }

  routeIntent(intent: AgentIntentType): WorkflowRouteResult {
    const route = WORKFLOW_ROUTES[intent];
    return { intent, ...route };
  }

  routeWorkflowType(workflowType: AgentWorkflowType): WorkflowRouteResult | undefined {
    for (const [intent, route] of Object.entries(WORKFLOW_ROUTES) as Array<
      [AgentIntentType, Omit<WorkflowRouteResult, "intent">]
    >) {
      if (route.workflowType === workflowType) {
        return { intent, ...route };
      }
    }
    return undefined;
  }
}

export const defaultWorkflowRouter = new WorkflowRouter();
