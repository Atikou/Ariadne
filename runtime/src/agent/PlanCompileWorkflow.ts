import type { Planner } from "./Planner.js";
import type { ApiResult } from "../orchestrator/Orchestrator.js";
import type { PlanService } from "../plan/PlanService.js";

export interface PlanCompileWorkflowOptions {
  planService: Pick<PlanService, "compileUserVisiblePlan">;
  planner?: Planner;
}

export interface PlanCompileWorkflowInput {
  userVisiblePlanId: string;
  confirmedTodoIds: string[];
  sessionId?: string;
}

/**
 * Workflow-level entry for turning confirmed user-visible todos into an
 * InternalTaskPlan draft. The draft is still awaiting approval and cannot run
 * until the normal approve -> execute chain is used.
 */
export class PlanCompileWorkflow {
  constructor(private readonly options: PlanCompileWorkflowOptions) {}

  async run(input: PlanCompileWorkflowInput): Promise<ApiResult> {
    const draft = await this.options.planService.compileUserVisiblePlan({
      userVisiblePlanId: input.userVisiblePlanId,
      confirmedTodoIds: input.confirmedTodoIds,
      sessionId: input.sessionId,
      planner: this.options.planner,
    });
    return {
      status: 200,
      body: {
        planId: draft.planId,
        version: draft.version,
        status: draft.status,
        planHash: draft.planHash,
        previewMarkdown: draft.previewMarkdown,
        publicPlanJson: draft.publicPlanJson,
        sourceUserVisiblePlanId: draft.sourceUserVisiblePlan.id,
        warning:
          "Compiled result is an awaiting-approval InternalTaskPlan draft; approve before execute.",
      },
    };
  }
}
