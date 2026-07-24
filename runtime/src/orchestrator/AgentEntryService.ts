import type { AgentCompletionContext } from "../agent/completion/TaskCompletionContract.js";
import type { LoopChatFn } from "../agent/AgentLoop.js";
import { Planner } from "../agent/Planner.js";
import { parseUserPermissionPolicyValue } from "../agent/RunPolicyTypes.js";
import type { ApiResult } from "../core/apiResult.js";
import { PlanActivationWorkflow } from "../plan/PlanActivationWorkflow.js";
import {
  detectPlanActivationIntent,
  parseUserVisiblePlanIdFromMessage,
} from "../plan/planActivationIntent.js";
import type { PlanService } from "../plan/PlanService.js";
import type { AgentRequestService } from "./AgentRequestService.js";
import {
  agentHttpRequestBodySchema,
  formatAgentRequestValidationError,
  isAgentPlanActivationRequest,
  isAgentStoredPlanExecutionRequest,
  toAgentConversationRequest,
  type AgentHttpRequest,
} from "./AgentRequestSchemas.js";
import type { PlanExecutionService } from "./PlanExecutionService.js";

export interface AgentEntryServiceDeps {
  planner: Planner;
  planService: PlanService;
  planExecutionService: Pick<PlanExecutionService, "executeStoredPlan">;
  agentRequestService: Pick<AgentRequestService, "run">;
}

/** Owns non-stream Agent request routing before the core Agent lifecycle. */
export class AgentEntryService {
  constructor(private readonly deps: AgentEntryServiceDeps) {}

  async run(
    body: unknown,
    makeChat?: LoopChatFn,
    completionContext?: AgentCompletionContext,
  ): Promise<ApiResult> {
    const parsed = agentHttpRequestBodySchema.safeParse(body ?? {});
    if (!parsed.success) {
      return {
        status: 400,
        body: { error: formatAgentRequestValidationError(parsed.error) },
      };
    }

    const request = parsed.data;
    const activation = await this.tryPlanActivation(request, makeChat);
    if (activation) return activation;

    if (isAgentPlanActivationRequest(request)) {
      return { status: 400, body: { error: "显式计划激活请求未能进入激活工作流" } };
    }

    return this.deps.agentRequestService.run(
      toAgentConversationRequest(request),
      makeChat,
      completionContext,
    );
  }

  private async tryPlanActivation(
    payload: AgentHttpRequest,
    makeChat?: LoopChatFn,
  ): Promise<ApiResult | null> {
    const planner = makeChat ? new Planner(makeChat) : this.deps.planner;
    if (isAgentStoredPlanExecutionRequest(payload)) {
      return this.deps.planExecutionService.executeStoredPlan(
        payload.planId,
        payload.version,
        {
          permissionPolicy: parseUserPermissionPolicyValue(payload.permissionPolicy),
          sessionId: payload.sessionId,
          rollbackOnFailure: payload.rollbackOnFailure,
          fallbackToPlanOnUncertainty: payload.fallbackToPlanOnUncertainty,
          executionMode: payload.executionMode,
        },
        payload.dryRun ?? false,
        planner,
      );
    }

    const messageRequest = isAgentPlanActivationRequest(payload) ? undefined : payload;
    const message = messageRequest?.message ?? "";
    const explicitMode = messageRequest?.mode;
    if (!payload.activatePlan && (explicitMode === "plan" || explicitMode === "review")) {
      return null;
    }

    const explicitUserVisiblePlanId =
      payload.userVisiblePlanId?.trim() || parseUserVisiblePlanIdFromMessage(message);
    if (!payload.activatePlan && !explicitUserVisiblePlanId) return null;
    if (!payload.activatePlan && !detectPlanActivationIntent(message)) return null;

    const userVisiblePlanId =
      explicitUserVisiblePlanId ||
      (payload.sessionId
        ? this.deps.planService.getLatestUserVisiblePlanForSession(payload.sessionId)?.id
        : undefined);
    if (!userVisiblePlanId) {
      return {
        status: 400,
        body: {
          error:
            "未找到可激活的 UserVisiblePlan；请先 POST /api/plans/analyze 或在消息中附带 uvp_ id",
          code: "UVP_NOT_FOUND",
        },
      };
    }

    return new PlanActivationWorkflow({
      planService: this.deps.planService,
      executeStoredPlan: (planId, version, execPayload, dryRun) =>
        this.deps.planExecutionService.executeStoredPlan(
          planId,
          version,
          execPayload,
          dryRun,
        ),
      planner,
    }).activate({
      userVisiblePlanId,
      sessionId: payload.sessionId,
      dryRun: payload.dryRun,
      autoApprove: payload.autoApprove,
      permissionPolicy: parseUserPermissionPolicyValue(payload.permissionPolicy),
      executionMode: payload.executionMode,
      confirmedTodoIds: payload.confirmedTodoIds,
      approvedBy: payload.approvedBy,
      rollbackOnFailure: payload.rollbackOnFailure,
      fallbackToPlanOnUncertainty: payload.fallbackToPlanOnUncertainty,
    });
  }
}
