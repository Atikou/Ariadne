import type { AgentIntentType } from "./IntentTypes.js";
import type { AgentRunMode } from "./RunPolicyTypes.js";
import {
  asksForAnalysis,
  explicitNoWorkflow,
  hasProjectScope,
  hasTargetHint,
  wantsCodeWork,
  wantsEdit,
  wantsGenerateFile,
  wantsRefactor,
} from "./intentPatterns.js";

/** Deterministic read-only workflow tools that can run before the model turn. */
export const WORKFLOW_TOOL_NAMES = [
  "project_scan",
  "locate_relevant_files",
  "context_pack",
] as const;

export type WorkflowToolName = (typeof WORKFLOW_TOOL_NAMES)[number];

export type AgentWorkflowId =
  | "plan_prescan"
  | "implement_locate"
  | "edit_locate"
  | "debug_locate"
  | "generate_file_locate"
  | "refactor_locate";

export interface WorkflowPlan {
  id: AgentWorkflowId;
  reason: string;
  steps: readonly WorkflowToolName[];
  contextHeader: string;
  contextHint: string;
}

export { hasProjectScope, hasTargetHint } from "./intentPatterns.js";

/**
 * Selects deterministic pre-model workflows. These workflows are intentionally read-only:
 * they locate files and package context, then the normal agent loop decides what to do next.
 */
export class WorkflowPlanner {
  plan(goal: string, mode: AgentRunMode, intent?: AgentIntentType): WorkflowPlan | null {
    if (explicitNoWorkflow(goal)) return null;

    const planPrescan = this.planPrescan(goal, mode);
    if (planPrescan) return planPrescan;

    const generateFileLocate = this.planGenerateFileLocate(goal, mode, intent);
    if (generateFileLocate) return generateFileLocate;

    const debugLocate = this.planDebugLocate(goal, mode, intent);
    if (debugLocate) return debugLocate;

    const refactorLocate = this.planRefactorLocate(goal, mode, intent);
    if (refactorLocate) return refactorLocate;

    const editLocate = this.planEditLocate(goal, mode, intent);
    if (editLocate) return editLocate;

    return this.planImplementLocate(goal, mode);
  }

  private planPrescan(goal: string, mode: AgentRunMode): WorkflowPlan | null {
    if (mode !== "plan" && mode !== "review") return null;
    if (!asksForAnalysis(goal) || !hasProjectScope(goal)) return null;

    return {
      id: "plan_prescan",
      reason: "计划/审阅模式下的项目分析请求，执行完整只读预扫描。",
      steps: ["project_scan", "locate_relevant_files", "context_pack"],
      contextHeader: "计划/审阅模式内部预扫描结果（只读、确定性执行）：",
      contextHint:
        "请优先基于这些结果生成最终计划或审阅结论；如果信息足够，请直接输出 final，不要重复执行同类扫描。",
    };
  }

  private planGenerateFileLocate(
    goal: string,
    mode: AgentRunMode,
    intent?: AgentIntentType,
  ): WorkflowPlan | null {
    if (mode !== "implement") return null;
    if (!wantsGenerateFile(goal, intent) || (!hasTargetHint(goal) && !hasProjectScope(goal))) {
      return null;
    }

    return {
      id: "generate_file_locate",
      reason:
        "generateFileWorkflow read-only prelocation: locate the target directory and nearby conventions before creating a file.",
      steps: ["locate_relevant_files", "context_pack"],
      contextHeader: "generateFileWorkflow read-only prelocation result:",
      contextHint:
        "Use the located files and context_pack result to infer naming, exports, tests, and documentation before creating a new file.",
    };
  }

  private planRefactorLocate(
    goal: string,
    mode: AgentRunMode,
    intent?: AgentIntentType,
  ): WorkflowPlan | null {
    if (mode !== "implement" && intent !== "refactor") return null;
    if (!wantsRefactor(goal, intent) || !hasProjectScope(goal)) return null;

    return {
      id: "refactor_locate",
      reason:
        "refactorWorkflow read-only prescan: map project scope before staged refactor planning.",
      steps: ["project_scan", "locate_relevant_files", "context_pack"],
      contextHeader: "refactorWorkflow read-only prescan result:",
      contextHint:
        "Use scan and located context to draft a staged refactor plan before any write-capable action.",
    };
  }

  private planEditLocate(
    goal: string,
    mode: AgentRunMode,
    intent?: AgentIntentType,
  ): WorkflowPlan | null {
    if (mode !== "implement" && mode !== "debug") return null;
    if (!wantsEdit(goal, intent) || (!hasTargetHint(goal) && !hasProjectScope(goal))) {
      return null;
    }

    return {
      id: "edit_locate",
      reason:
        "editWorkflow read-only prelocation: locate relevant files and pack context before any write-capable action.",
      steps: ["locate_relevant_files", "context_pack"],
      contextHeader: "editWorkflow read-only prelocation result:",
      contextHint:
        "Use the located files and context_pack result to draft the edit plan first. Do not call write-capable tools until permissions and the concrete patch are clear.",
    };
  }

  private planDebugLocate(
    goal: string,
    mode: AgentRunMode,
    intent?: AgentIntentType,
  ): WorkflowPlan | null {
    if (mode !== "debug" && intent !== "debug") return null;
    if (!hasTargetHint(goal) && !hasProjectScope(goal)) return null;

    return {
      id: "debug_locate",
      reason:
        "debugWorkflow read-only diagnosis: locate likely failing files and pack context before root-cause analysis.",
      steps: ["locate_relevant_files", "context_pack"],
      contextHeader: "debugWorkflow read-only diagnosis context:",
      contextHint:
        "Use the located files and context_pack result to explain the failure, identify suspected files, form root-cause hypotheses, and draft a minimal fix plus verification plan before any write-capable action.",
    };
  }

  private planImplementLocate(goal: string, mode: AgentRunMode): WorkflowPlan | null {
    if (mode !== "implement" && mode !== "debug") return null;
    if (!wantsCodeWork(goal) || (!hasTargetHint(goal) && !hasProjectScope(goal))) return null;

    return {
      id: "implement_locate",
      reason: "实现/调试模式下的代码变更请求，先定位相关文件并打包上下文。",
      steps: ["locate_relevant_files", "context_pack"],
      contextHeader: "实现/调试模式内部预定位结果（只读、确定性执行）：",
      contextHint:
        "请优先基于已定位文件与 context_pack 结果进行修改或调试；避免重复 list_files/search_text 试探。",
    };
  }
}

export const defaultWorkflowPlanner = new WorkflowPlanner();

export function shouldRunAgentWorkflow(goal: string, mode: AgentRunMode): boolean {
  return defaultWorkflowPlanner.plan(goal, mode) !== null;
}

/** @deprecated Use shouldRunAgentWorkflow; retained for plan/review-only checks. */
export function shouldRunPlanWorkflow(goal: string, mode: AgentRunMode): boolean {
  const workflow = defaultWorkflowPlanner.plan(goal, mode);
  return workflow?.id === "plan_prescan";
}
