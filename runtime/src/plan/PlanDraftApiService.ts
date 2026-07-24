import type { Planner } from "../agent/Planner.js";
import type { ApiResult } from "../core/apiResult.js";
import type { RunStore } from "../orchestrator/RunStore.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import { toPublicError } from "../util/publicError.js";
import {
  PlanDraftInvalidResultSchema,
  PlanDraftResultSchema,
  PlanDraftRunErrorResultSchema,
  type PlanDraftRequest,
} from "./PlanDraftContracts.js";
import { detectPlanReportRequest } from "./planIntent.js";
import type { PlanService } from "./PlanService.js";
import { PlanValidationError } from "./types.js";

export interface PlanDraftApiServiceDeps {
  planner: Planner;
  planService: PlanService;
  runs: RunStore;
  trace?: TraceLogger;
}

/** Owns the machine-plan draft API boundary and its Run lifecycle. */
export class PlanDraftApiService {
  constructor(private readonly deps: PlanDraftApiServiceDeps) {}

  async generate(input: PlanDraftRequest, planner?: Planner): Promise<ApiResult> {
    const reportRequest = detectPlanReportRequest(input.goal);
    if (reportRequest) {
      return { status: 400, body: PlanDraftInvalidResultSchema.parse(reportRequest) };
    }

    const run = this.deps.runs.create({
      kind: "plan",
      status: "running",
      goal: input.goal,
      correlation: { runId: "" },
    });
    this.deps.runs.update(run.id, {
      correlationJson: JSON.stringify({ runId: run.id }),
    });

    try {
      this.deps.trace?.write({ type: "run_start", runId: run.id, kind: "plan" });
      const draft = await this.deps.planService.createDraftFromPlanner({
        goal: input.goal,
        context: input.context,
        sessionId: input.sessionId,
        mode: input.mode,
        requestId: run.id,
        planner: planner ?? this.deps.planner,
      });
      this.deps.runs.update(run.id, {
        status: "completed",
        resultJson: JSON.stringify({ planId: draft.planId, version: draft.version }),
      });
      this.deps.trace?.write({ type: "run_end", runId: run.id, kind: "plan", status: "completed" });
      return {
        status: 200,
        body: PlanDraftResultSchema.parse({
          runId: run.id,
          planId: draft.planId,
          version: draft.version,
          status: draft.status,
          planHash: draft.planHash,
          previewMarkdown: draft.previewMarkdown,
          publicPlanJson: draft.publicPlanJson,
          warning: "previewMarkdown / publicPlanJson 仅供展示，不可直接执行",
          nextAction: {
            approve: `POST /api/plans/${draft.planId}/approve`,
            execute: `POST /api/agent with activatePlan:true, planId:${draft.planId}, version:${draft.version}`,
          },
        }),
      };
    } catch (error) {
      const publicError = toPublicError(error, "生成计划失败");
      this.deps.runs.update(run.id, { status: "failed", error: publicError.message });
      this.deps.trace?.write({ type: "run_end", runId: run.id, kind: "plan", status: "failed" });
      if (error instanceof PlanValidationError) {
        return {
          status: 400,
          body: PlanDraftInvalidResultSchema.parse({
            error: error.message,
            code: error.code,
            runId: run.id,
          }),
        };
      }
      return {
        status: 502,
        body: PlanDraftRunErrorResultSchema.parse({
          error: publicError.message,
          code: publicError.code,
          runId: run.id,
        }),
      };
    }
  }
}
