import type { Planner } from "../agent/Planner.js";
import type { ApiResult } from "../core/apiResult.js";
import type { PlanService } from "./PlanService.js";
import { canAutoApprovePlan } from "./planActivationPolicy.js";
import { defaultConfirmedTodoIds } from "./planActivationIntent.js";
import { PlanValidationError } from "./types.js";

export type PlanExecutionMode = "static" | "agent_loop";

export interface PlanActivationWorkflowOptions {
  planService: Pick<
    PlanService,
    | "getUserVisiblePlan"
    | "compileUserVisiblePlan"
    | "approve"
    | "getRecord"
  >;
  executeStoredPlan: (
    planId: string,
    version: number,
    payload: {
      permissionPolicy?: import("../agent/RunPolicyTypes.js").UserPermissionPolicy;
      sessionId?: string;
      runId?: string;
      rollbackOnFailure?: boolean;
      fallbackToPlanOnUncertainty?: boolean;
      executionMode?: PlanExecutionMode;
      planRunId?: string;
    },
    dryRun: boolean,
  ) => Promise<ApiResult>;
  planner?: Planner;
}

export interface PlanActivationInput {
  userVisiblePlanId: string;
  confirmedTodoIds?: string[];
  sessionId?: string;
  dryRun?: boolean;
  autoApprove?: boolean;
  permissionPolicy?: import("../agent/RunPolicyTypes.js").UserPermissionPolicy;
  executionMode?: PlanExecutionMode;
  approvedBy?: string;
  rollbackOnFailure?: boolean;
  fallbackToPlanOnUncertainty?: boolean;
}

export interface PlanActivationResult {
  phase: "compiled" | "executed";
  userVisiblePlanId: string;
  planId: string;
  version: number;
  status: string;
  executionMode: PlanExecutionMode;
  dryRun: boolean;
  autoApproved: boolean;
  execution?: ApiResult["body"];
}

/**
 * Plan Activation Layer：将 UserVisiblePlan 一键编译并（条件允许时）审批、执行。
 */
export class PlanActivationWorkflow {
  constructor(private readonly options: PlanActivationWorkflowOptions) {}

  async activate(input: PlanActivationInput): Promise<ApiResult> {
    const uvp = this.options.planService.getUserVisiblePlan(input.userVisiblePlanId);
    if (!uvp) {
      return { status: 404, body: { error: "UserVisiblePlan 不存在", code: "UVP_NOT_FOUND" } };
    }

    const confirmedTodoIds =
      input.confirmedTodoIds && input.confirmedTodoIds.length > 0
        ? input.confirmedTodoIds
        : defaultConfirmedTodoIds(uvp.todos);

    if (confirmedTodoIds.length === 0) {
      return {
        status: 400,
        body: { error: "UserVisiblePlan 无可用 Todo，无法激活", code: "NO_TODOS" },
      };
    }

    const dryRun = input.dryRun ?? false;
    const executionMode: PlanExecutionMode = input.executionMode ?? "agent_loop";

    let compiled;
    try {
      compiled = await this.options.planService.compileUserVisiblePlan({
        userVisiblePlanId: input.userVisiblePlanId,
        confirmedTodoIds,
        sessionId: input.sessionId ?? uvp.sessionId,
        planner: this.options.planner,
      });
    } catch (err) {
      if (err instanceof PlanValidationError) {
        const status = err.message.includes("不存在") ? 404 : 400;
        return { status, body: { error: err.message, code: err.code } };
      }
      return { status: 400, body: { error: String(err) } };
    }

    const record = this.options.planService.getRecord(compiled.planId, compiled.version);
    if (!record) {
      return { status: 500, body: { error: "编译后计划未找到" } };
    }

    const autoApproved = canAutoApprovePlan({
      dryRun,
      autoApprove: input.autoApprove,
      internal: record.internal,
    });

    if (!autoApproved) {
      const body: PlanActivationResult = {
        phase: "compiled",
        userVisiblePlanId: input.userVisiblePlanId,
        planId: compiled.planId,
        version: compiled.version,
        status: compiled.status,
        executionMode,
        dryRun,
        autoApproved: false,
      };
      return {
        status: 200,
        body: {
          ...body,
          previewMarkdown: compiled.previewMarkdown,
          publicPlanJson: compiled.publicPlanJson,
          warning:
            "计划已编译为 awaiting_approval；含 write/shell 等副作用步骤，须先审批，再通过统一 Agent 入口执行；dry-run 或只读计划可传 autoApprove:true",
        },
      };
    }

    try {
      this.options.planService.approve(
        compiled.planId,
        compiled.version,
        input.approvedBy?.trim() || (dryRun ? "system:dry-run" : "system:auto-activate"),
        dryRun ? "auto before dry-run activate" : "auto-activate",
      );
    } catch (err) {
      return { status: 400, body: { error: String(err) } };
    }

    const execution = await this.options.executeStoredPlan(
      compiled.planId,
      compiled.version,
      {
        permissionPolicy: input.permissionPolicy,
        sessionId: input.sessionId ?? uvp.sessionId,
        rollbackOnFailure: input.rollbackOnFailure,
        fallbackToPlanOnUncertainty: input.fallbackToPlanOnUncertainty,
        executionMode,
      },
      dryRun,
    );

    if (execution.status !== 200) {
      return execution;
    }

    const body: PlanActivationResult = {
      phase: "executed",
      userVisiblePlanId: input.userVisiblePlanId,
      planId: compiled.planId,
      version: compiled.version,
      status: dryRun ? "dry_run_completed" : "executed",
      executionMode,
      dryRun,
      autoApproved: true,
      execution: execution.body,
    };

    return { status: 200, body };
  }
}
