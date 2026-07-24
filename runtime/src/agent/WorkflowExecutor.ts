import type { ContextManager } from "../context/ContextManager.js";
import type { RunState } from "../orchestrator/runStateTypes.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { BudgetManager } from "./BudgetManager.js";
import type { ToolPermission } from "../core/permissions.js";
import type { ProcessSandbox } from "../sandbox/ProcessSandbox.js";
import { ImplicitPlanWorkflow } from "./ImplicitPlanWorkflow.js";
import { RefactorPlanWorkflow } from "./RefactorPlanWorkflow.js";
import { DebugAnalysisWorkflow } from "./DebugAnalysisWorkflow.js";
import { EditProposalWorkflow } from "./EditProposalWorkflow.js";
import { PlanWorkflow, type PlanWorkflowResumeContext } from "./PlanWorkflow.js";
import type {
  AgentWorkflowDebugAnalysis,
  AgentWorkflowInternalPlan,
  AgentWorkflowProposal,
  AgentWorkflowRefactorPlan,
  RunPolicy,
  RunBudget,
} from "./RunPolicyTypes.js";
import { RunVerifyWorkflow } from "./RunVerifyWorkflow.js";
import type { AgentToolStep } from "./toolStep.js";
import { defaultWorkflowPlanner } from "./WorkflowPlanner.js";

export interface WorkflowExecutorOptions {
  registry: ToolRegistry;
  workspaceRoot: string;
  processSandbox?: ProcessSandbox;
  allowedPermissions: ToolPermission[];
  runGrantedPermissions?: readonly ToolPermission[];
  budget: RunBudget;
  budgetManager: BudgetManager;
  policy: RunPolicy;
  trace?: TraceLogger;
  contextManager?: ContextManager;
  sessionId?: string;
  taskId?: string;
  requestId?: string;
}

export interface WorkflowExecutionInput {
  goal: string;
  isResume?: boolean;
  resumeState?: RunState;
}

export interface WorkflowExecutionResult {
  steps: AgentToolStep[];
  modelContexts: string[];
  workflowProposals: AgentWorkflowProposal[];
  workflowDebugAnalyses: AgentWorkflowDebugAnalysis[];
  workflowRefactorPlans: AgentWorkflowRefactorPlan[];
  workflowInternalPlans: AgentWorkflowInternalPlan[];
}

export class WorkflowExecutor {
  constructor(private readonly options: WorkflowExecutorOptions) {}

  async executeBeforeModel(input: WorkflowExecutionInput): Promise<WorkflowExecutionResult> {
    const steps: AgentToolStep[] = [];
    const modelContexts: string[] = [];
    const workflowProposals: AgentWorkflowProposal[] = [];
    const workflowDebugAnalyses: AgentWorkflowDebugAnalysis[] = [];
    const workflowRefactorPlans: AgentWorkflowRefactorPlan[] = [];
    const workflowInternalPlans: AgentWorkflowInternalPlan[] = [];

    const planResult = await this.runPlanWorkflow(input);
    if (planResult) {
      steps.push(...planResult.steps);
      modelContexts.push(planResult.modelContext);
    }

    const debugAnalysisResult = this.runDebugAnalysisWorkflow(input.goal);
    if (debugAnalysisResult) {
      modelContexts.push(debugAnalysisResult.modelContext);
      workflowDebugAnalyses.push(debugAnalysisResult.analysis);
    }

    const refactorPlanResult = this.runRefactorPlanWorkflow(input.goal);
    if (refactorPlanResult) {
      modelContexts.push(refactorPlanResult.modelContext);
      workflowRefactorPlans.push(refactorPlanResult.plan);
    }

    const implicitPlanResult = this.runImplicitPlanWorkflow(input.goal);
    if (implicitPlanResult) {
      modelContexts.push(implicitPlanResult.modelContext);
      workflowInternalPlans.push(implicitPlanResult.plan);
    }

    const editProposalResult = this.runEditProposalWorkflow(input.goal);
    if (editProposalResult) {
      modelContexts.push(editProposalResult.modelContext);
      workflowProposals.push(editProposalResult.proposal);
    }

    const runVerifyResult = await this.runRunVerifyWorkflow(input.goal);
    if (runVerifyResult) {
      steps.push(...runVerifyResult.steps);
      modelContexts.push(runVerifyResult.modelContext);
    }

    return { steps, modelContexts, workflowProposals, workflowDebugAnalyses, workflowRefactorPlans, workflowInternalPlans };
  }

  private async runPlanWorkflow(
    input: WorkflowExecutionInput,
  ): Promise<{ steps: AgentToolStep[]; modelContext: string } | undefined> {
    const workflowPlan =
      input.isResume && input.resumeState
        ? defaultWorkflowPlanner.plan(
            input.resumeState.goal,
            this.options.policy.mode,
            this.options.policy.intent,
          ) ?? undefined
        : undefined;
    const resume: PlanWorkflowResumeContext | undefined =
      input.isResume && input.resumeState
        ? {
            completedStepIds: input.resumeState.completedSteps,
            priorSteps: input.resumeState.completedToolSteps,
            location: input.resumeState.location,
            workflowPlan,
          }
        : undefined;

    const workflow = await new PlanWorkflow({
      registry: this.options.registry,
      workspaceRoot: this.options.workspaceRoot,
      processSandbox: this.options.processSandbox,
      allowedPermissions: this.options.allowedPermissions,
      budget: this.options.budget,
      budgetManager: this.options.budgetManager,
      trace: this.options.trace,
      contextManager: this.options.contextManager,
      sessionId: this.options.sessionId,
      taskId: this.options.taskId,
      requestId: this.options.requestId,
    }).run(input.goal, this.options.policy.mode, resume, this.options.policy.intent);
    if (!workflow) return undefined;

    const priorCount = input.isResume && input.resumeState
      ? input.resumeState.completedToolSteps.length
      : 0;
    const newSteps = workflow.steps.slice(priorCount);
    if (newSteps.length > 0) {
      return { steps: newSteps, modelContext: workflow.modelContext };
    }
    if (input.isResume && workflow.modelContext) {
      return {
        steps: [],
        modelContext: `${workflow.modelContext}\n\n(resume: completed workflow steps were preserved; continue analysis or return final.)`,
      };
    }
    return undefined;
  }

  private runRunVerifyWorkflow(goal: string) {
    return new RunVerifyWorkflow({
      registry: this.options.registry,
      workspaceRoot: this.options.workspaceRoot,
      processSandbox: this.options.processSandbox,
      allowedPermissions: this.options.allowedPermissions,
      permissionPolicy: this.options.policy.permissionPolicy,
      runGrantedPermissions: this.options.runGrantedPermissions,
      budget: this.options.budget,
      trace: this.options.trace,
      contextManager: this.options.contextManager,
      sessionId: this.options.sessionId,
      taskId: this.options.taskId,
      requestId: this.options.requestId,
    }).run(goal, this.options.policy.intent);
  }

  private runEditProposalWorkflow(goal: string) {
    return new EditProposalWorkflow().run({
      goal,
      intent: this.options.policy.intent,
      permissionPolicy: this.options.policy.permissionPolicy,
      allowedPermissions: this.options.allowedPermissions,
      runGrantedPermissions: this.options.runGrantedPermissions,
    });
  }

  private runDebugAnalysisWorkflow(goal: string) {
    return new DebugAnalysisWorkflow().run({
      goal,
      intent: this.options.policy.intent,
      permissionPolicy: this.options.policy.permissionPolicy,
      runGrantedPermissions: this.options.runGrantedPermissions,
    });
  }

  private runRefactorPlanWorkflow(goal: string) {
    return new RefactorPlanWorkflow().run({
      goal,
      intent: this.options.policy.intent,
      permissionPolicy: this.options.policy.permissionPolicy,
      runGrantedPermissions: this.options.runGrantedPermissions,
    });
  }

  private runImplicitPlanWorkflow(goal: string) {
    return new ImplicitPlanWorkflow().run({
      goal,
      intent: this.options.policy.intent,
      workflowType: this.options.policy.workflowType,
      permissionPolicy: this.options.policy.permissionPolicy,
    });
  }
}
