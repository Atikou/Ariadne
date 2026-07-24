import type { ContextManager } from "../context/ContextManager.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolPermission } from "../core/permissions.js";
import type { ProcessSandbox } from "../sandbox/ProcessSandbox.js";
import type { AgentToolStep } from "./toolStep.js";
import { toolStepPayloadForContext } from "./toolStepOutcome.js";
import type { AgentRunMode, RunBudget } from "./RunPolicyTypes.js";
import type { BudgetManager } from "./BudgetManager.js";
import { countSuccessfulPermissionUsage } from "./BudgetManager.js";
import type { RunStateLocationContext } from "../orchestrator/runStateLocation.js";
import type { AgentIntentType } from "./IntentTypes.js";
import {
  defaultWorkflowPlanner,
  type WorkflowPlan,
  type WorkflowToolName,
} from "./WorkflowPlanner.js";
import { ToolExecutionGateway } from "./ToolExecutionGateway.js";
import { defaultWorkflowRouter } from "./WorkflowRouter.js";

export interface PlanWorkflowOptions {
  registry: ToolRegistry;
  workspaceRoot: string;
  processSandbox?: ProcessSandbox;
  allowedPermissions: ToolPermission[];
  budget: RunBudget;
  budgetManager?: BudgetManager;
  trace?: TraceLogger;
  contextManager?: ContextManager;
  sessionId?: string;
  taskId?: string;
  requestId?: string;
}

export interface PlanWorkflowResult {
  steps: AgentToolStep[];
  modelContext: string;
}

export interface PlanWorkflowResumeContext {
  completedStepIds: readonly WorkflowToolName[];
  priorSteps: AgentToolStep[];
  location?: RunStateLocationContext;
  workflowPlan?: WorkflowPlan;
}

/**
 * 确定性只读预扫描执行器（由 WorkflowPlanner 选择步骤序列）。
 */
export class PlanWorkflow {
  private readonly gateway: ToolExecutionGateway;

  constructor(private readonly options: PlanWorkflowOptions) {
    this.gateway = new ToolExecutionGateway(options.registry);
  }

  async run(
    goal: string,
    mode: AgentRunMode,
    resume?: PlanWorkflowResumeContext,
    intent?: AgentIntentType,
  ): Promise<PlanWorkflowResult | undefined> {
    const workflowPlan = resume?.workflowPlan ?? defaultWorkflowPlanner.plan(goal, mode, intent);
    if (!workflowPlan) return undefined;
    if (!this.options.allowedPermissions.includes("read")) return undefined;

    const priorSteps = resume?.priorSteps ?? [];
    const completed = new Set(resume?.completedStepIds ?? []);
    const steps: AgentToolStep[] = [...priorSteps];
    const workflowTools = workflowPlan.steps;

    const pendingCount = workflowTools.length - completed.size;
    const maxNewSteps = this.options.budgetManager
      ? this.options.budgetManager.remainingWorkflowSteps(steps, pendingCount)
      : Math.min(
          pendingCount,
          Math.max(0, this.options.budget.maxToolCalls - steps.length),
          Math.max(
            0,
            this.options.budget.maxReadCalls - countSuccessfulPermissionUsage(steps).readCalls,
          ),
        );
    if (maxNewSteps <= 0 && steps.length === 0) return undefined;
    if (maxNewSteps <= 0 && steps.length > 0) return buildResult(steps, workflowPlan);

    let scanOutput = steps.find((s) => s.tool === "project_scan" && s.ok)?.output as
      | Record<string, unknown>
      | undefined;
    let locateOutput = steps.find((s) => s.tool === "locate_relevant_files" && s.ok)?.output;

    let newSteps = 0;
    for (const stepId of workflowTools) {
      if (completed.has(stepId)) continue;
      if (newSteps >= maxNewSteps) break;

      if (stepId === "project_scan") {
        const projectScan = await this.runTool(
          "project_scan",
          { root: ".", maxDepth: 3 },
          "预扫描：先识别项目结构、配置和重要入口。",
          steps,
        );
        steps.push(projectScan);
        newSteps += 1;
        if (projectScan.ok) scanOutput = asRecord(projectScan.output);
        if (newSteps >= maxNewSteps) return buildResult(steps, workflowPlan);
        continue;
      }

      if (stepId === "locate_relevant_files") {
        const possiblePaths = unique([
          ...readStringArray(scanOutput?.sourceRoots).slice(0, 8),
          ...(resume?.location?.searchPlan?.possiblePaths ?? []),
        ]).slice(0, 12);
        const isResume = Boolean(resume?.location);
        const locate = await this.runTool(
          "locate_relevant_files",
          {
            projectId: resume?.location?.projectId ?? "default",
            goal,
            mode,
            limit: 12,
            possiblePaths,
            keywords: resume?.location?.searchPlan?.keywords,
            possibleSymbols: resume?.location?.searchPlan?.possibleSymbols,
            resumeContext: resume?.location
              ? {
                  visitedFiles: resume.location.visitedFiles,
                  visitedDirs: resume.location.visitedDirs,
                  candidateFiles: resume.location.candidateFiles,
                  primaryFiles: resume.location.primaryFiles,
                  searchPlan: resume.location.searchPlan,
                }
              : undefined,
            locateBudget: {
              maxSearchCalls: workflowPlan.id === "plan_prescan" ? 3 : 4,
              maxListCalls: 1,
              maxReadForLocationCalls: workflowPlan.id === "plan_prescan" ? 2 : 3,
              maxCandidateFiles: 16,
              maxPrimaryFiles: 8,
            },
          },
          isResume
            ? "续跑：在已保存 searchPlan/visitedFiles 基础上继续定位。"
            : "预扫描：根据目标定位 primaryFiles 和 candidateFiles。",
          steps,
        );
        steps.push(locate);
        newSteps += 1;
        if (locate.ok) locateOutput = locate.output;
        if (newSteps >= maxNewSteps) return buildResult(steps, workflowPlan);
        continue;
      }

      if (stepId === "context_pack") {
        const files = filesFromLocateOutput(locateOutput);
        if (files.length > 0) {
          const pack = await this.runTool(
            "context_pack",
            {
              files,
              maxFiles: 8,
              maxTokens: 12_000,
              includeSummaries: true,
              includeImportantSections: true,
            },
            "预扫描：一次性打包相关文件上下文，避免连续 read_file。",
            steps,
          );
          steps.push(pack);
          newSteps += 1;
        }
      }
    }

    return buildResult(steps, workflowPlan);
  }

  private async runTool(
    toolName: string,
    input: Record<string, unknown>,
    thought: string,
    priorSteps: AgentToolStep[],
  ): Promise<AgentToolStep> {
    const tool = this.options.registry.get(toolName);
    const step: AgentToolStep = {
      iteration: 0,
      tool: toolName,
      input,
      permission: tool?.permissions[0],
      thought,
      ok: false,
    };

    this.options.trace?.write({
      type: "agent_tool",
      tool: toolName,
      iteration: 0,
      runId: this.options.requestId,
      sessionId: this.options.sessionId,
      taskId: this.options.taskId,
      workflow: "plan",
    });

    const result = await this.gateway.run({
      toolName,
      input,
      source: "preflight",
      budgetBucket: "preflight",
      workspaceRoot: this.options.workspaceRoot,
      allowedPermissions: this.options.allowedPermissions,
      intent: "plan",
      permissionPolicy: "readOnly",
      mode: "plan",
      workflowRoute: defaultWorkflowRouter.routeIntent("plan"),
      budgetManager: this.options.budgetManager,
      existingSteps: priorSteps,
      taskId: this.options.taskId,
      sessionId: this.options.sessionId,
      requestId: this.options.requestId,
      isPreflight: true,
      registryExtras: { processSandbox: this.options.processSandbox },
    });

    if (result.outcomeClass !== "execution_error") {
      const output =
        this.options.contextManager?.compactToolOutput(toolName, result.output) ?? result.output;
      this.saveToolMessage(toolName, output, result);
      return {
        ...step,
        preflight: true,
        executed: result.executed,
        ok: result.outcomeClass === "observation_success",
        output,
        durationMs: result.durationMs,
        error: result.outcomeClass === "observation_failure" ? result.message : undefined,
        outcomeClass: result.outcomeClass,
        outcomeKind: result.outcomeKind,
        outcomeMessage: result.message,
      };
    }

    const failed = {
      ...step,
      preflight: true,
      error: result.error ?? result.message,
      blocked: result.code === "permission_denied",
      durationMs: result.durationMs,
      outcomeClass: result.outcomeClass,
      outcomeKind: result.outcomeKind,
    };
    this.saveToolMessage(toolName, { error: failed.error, code: result.code }, result);
    return failed;
  }

  private saveToolMessage(
    toolName: string,
    output: unknown,
    result?: import("../tools/types.js").ToolRunResult,
  ): void {
    if (!this.options.contextManager || !this.options.sessionId) return;
    this.options.contextManager.saveToolMessage(
      this.options.sessionId,
      `内部预扫描步骤「${toolName}」执行结果（JSON）：\n${JSON.stringify(output)}`,
      this.options.requestId,
      {
        outcomeClass: result?.outcomeClass,
        outcomeKind: result?.outcomeKind,
        toolName,
        ledgerBacked: result?.outcomeClass === "observation_success",
      },
    );
  }
}

export { shouldRunPlanWorkflow, shouldRunAgentWorkflow } from "./WorkflowPlanner.js";

function buildResult(steps: AgentToolStep[], workflowPlan: WorkflowPlan): PlanWorkflowResult {
  return {
    steps,
    modelContext: renderPlanWorkflowContext(steps, workflowPlan),
  };
}

function renderPlanWorkflowContext(steps: AgentToolStep[], workflowPlan: WorkflowPlan): string {
  const blocks = steps.map((step, index) => {
    const payload = toolStepPayloadForContext(step);
    return [
      `## ${index + 1}. ${step.tool}`,
      `thought: ${step.thought ?? ""}`,
      `input: ${JSON.stringify(step.input)}`,
      `output: ${JSON.stringify(payload)}`,
    ].join("\n");
  });
  return [
    workflowPlan.contextHeader,
    workflowPlan.contextHint,
    "说明：以下是内部预扫描步骤的结果；可调用工具名仅限每个小节标题中的真实工具名，不要把内部流程名或大写类名当作工具名调用。",
    ...blocks,
  ].join("\n\n");
}

function filesFromLocateOutput(output: unknown): string[] {
  const record = asRecord(output);
  return [
    ...pathArray(record?.primaryFiles),
    ...pathArray(record?.candidateFiles),
  ].filter((item, index, arr) => item && arr.indexOf(item) === index).slice(0, 8);
}

function pathArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      const record = asRecord(item);
      return typeof record?.path === "string" ? record.path : undefined;
    })
    .filter((item): item is string => Boolean(item));
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
