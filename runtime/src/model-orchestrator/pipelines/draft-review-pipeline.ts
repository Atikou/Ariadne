import { z } from "zod";

import type { CollaborationRunStore } from "../../model-router/route-stores.js";
import type { RouterDecision, RiskLevel } from "../../model-router/types.js";
import { buildDraftMessages } from "../prompt-templates/draft-prompt.js";
import { buildReviewMessages } from "../prompt-templates/review-prompt.js";
import type {
  DraftReviewResult,
  ModelChatFn,
  ModelChatResult,
  OrchestratorInput,
  OrchestratorResult,
  PipelineFallbackContext,
} from "../types.js";
import { runSingleModelPipeline } from "./single-model-pipeline.js";
import { parseStrictJsonDocument } from "../../util/strictJsonDocument.js";

const DraftReviewResultSchema = z
  .object({
    verdict: z.enum(["approve", "revise", "reject"]),
    confidence: z.number().min(0).max(1),
    issues: z
      .array(
        z
          .object({
            severity: z.enum(["low", "medium", "high"]),
            message: z.string(),
          })
          .strict(),
      ),
    revisedAnswer: z.string().optional(),
  })
  .strict();

export function parseDraftReviewResult(content: string): DraftReviewResult {
  return DraftReviewResultSchema.parse(parseStrictJsonDocument(content, "审查模型输出"));
}

function recordAndApply(
  ctx: PipelineFallbackContext,
  decision: RouterDecision,
  sessionId: string | undefined,
  plan: NonNullable<ReturnType<PipelineFallbackContext["manager"]["planDraftFailure"]>>,
): RouterDecision {
  const logId = ctx.logStore.create({
    routeLogId: decision.id,
    sessionId,
    fromModelId: plan.fromModelId,
    toModelId: plan.toModelId,
    fromStrategy: plan.fromStrategy,
    toStrategy: plan.toStrategy,
    triggerType: plan.trigger,
    reason: plan.reason,
  });
  ctx.recordFallback(logId);
  return ctx.manager.applyPlan(decision, plan);
}

export async function runDraftReviewPipeline(
  input: OrchestratorInput,
  chat: ModelChatFn,
  collaborationStore: CollaborationRunStore,
  risk: RiskLevel,
  fallbackCtx: PipelineFallbackContext,
): Promise<OrchestratorResult> {
  const decision = input.routerDecision;
  const draftId = decision.draftModelId;
  const reviewId = decision.reviewModelId ?? decision.finalModelId;
  if (!draftId || !reviewId) {
    throw new Error("local_draft_remote_review 缺少 draft/review 模型");
  }

  const collaborationRunId = collaborationStore.create({
    sessionId: input.sessionId,
    routeLogId: decision.id,
    strategy: decision.executionStrategy,
    draftModelId: draftId,
    reviewModelId: reviewId,
    finalModelId: decision.finalModelId,
  });

  const modelCallIds: string[] = [];
  const usedModelIds: string[] = [];
  let draftText = "";
  let lastResponse: ModelChatResult["response"] | undefined;

  try {
    const draftMessages = buildDraftMessages(input.renderedPrompt.finalMessages, input.userInput);
    const draftRes = await chat(
      draftId,
      { messages: draftMessages, temperature: input.temperature ?? 0.3 },
      { role: "draft", routeLogId: decision.id, collaborationRunId, sessionId: input.sessionId },
    );
    modelCallIds.push(draftRes.callLogId);
    usedModelIds.push(draftId);
    lastResponse = draftRes.response;
    draftText = draftRes.response.content;
  } catch {
    const plan = fallbackCtx.manager.planDraftFailure(
      decision,
      risk,
      draftId,
      reviewId,
      fallbackCtx.localOnly,
    );
    if (!plan) {
      throw new Error("草稿模型失败且无法生成 fallback 计划");
    }
    const nextDecision = recordAndApply(fallbackCtx, decision, input.sessionId, plan);
    const direct = await runSingleModelPipeline({ ...input, routerDecision: nextDecision }, chat);
    collaborationStore.finish(collaborationRunId, {
      status: plan.toStrategy === "strong_model_direct" ? "draft_failed_strong" : "draft_failed_single",
      verdict: "revise",
    });
    return {
      ...direct,
      collaborationRunId,
      modelCallIds: [...modelCallIds, ...direct.modelCallIds],
      usedModelIds: [...usedModelIds, ...direct.usedModelIds],
    };
  }

  let reviewResult: DraftReviewResult | undefined;
  try {
    const reviewMessages = buildReviewMessages(input.userInput, draftText);
    const reviewRes = await chat(
      reviewId,
      { messages: reviewMessages, temperature: 0.1 },
      { role: "review", routeLogId: decision.id, collaborationRunId, sessionId: input.sessionId },
    );
    lastResponse = reviewRes.response;
    if (!usedModelIds.includes(reviewId)) usedModelIds.push(reviewId);
    modelCallIds.push(reviewRes.callLogId);
    reviewResult = parseDraftReviewResult(reviewRes.response.content);
  } catch {
    const plan = fallbackCtx.manager.planReviewParseFailure(
      decision,
      risk,
      reviewId,
      fallbackCtx.localOnly,
    );
    if (!plan) {
      throw new Error("审查失败且无法生成 fallback 计划");
    }
    const nextDecision = recordAndApply(fallbackCtx, decision, input.sessionId, plan);
    const direct = await runSingleModelPipeline({ ...input, routerDecision: nextDecision }, chat);
    collaborationStore.finish(collaborationRunId, { status: "review_failed_regen", verdict: "reject" });
    return {
      ...direct,
      collaborationRunId,
      modelCallIds: [...modelCallIds, ...direct.modelCallIds],
      usedModelIds: [...usedModelIds, ...direct.usedModelIds],
    };
  }

  if (!reviewResult) {
    throw new Error("审查结果为空");
  }

  let finalAnswer: string;
  if (reviewResult.verdict === "approve") {
    finalAnswer = draftText;
  } else if (reviewResult.revisedAnswer?.trim()) {
    finalAnswer = reviewResult.revisedAnswer.trim();
  } else if (reviewResult.verdict === "reject" && risk === "high") {
    const plan = fallbackCtx.manager.planReviewRejected(decision, reviewId, fallbackCtx.localOnly);
    if (!plan) {
      throw new Error("审查 reject 且无 revisedAnswer，高风险任务拒绝使用草稿");
    }
    const nextDecision = recordAndApply(fallbackCtx, decision, input.sessionId, plan);
    const direct = await runSingleModelPipeline({ ...input, routerDecision: nextDecision }, chat);
    collaborationStore.finish(collaborationRunId, {
      status: "review_rejected_fallback",
      verdict: "reject",
      issuesJson: JSON.stringify(reviewResult.issues),
    });
    return {
      ...direct,
      collaborationRunId,
      modelCallIds: [...modelCallIds, ...direct.modelCallIds],
      usedModelIds: [...usedModelIds, ...direct.usedModelIds],
      reviewResult,
    };
  } else {
    finalAnswer = draftText;
  }

  collaborationStore.finish(collaborationRunId, {
    status: "completed",
    verdict: reviewResult.verdict,
    confidence: reviewResult.confidence,
    issuesJson: JSON.stringify(reviewResult.issues),
  });

  return {
    finalAnswer,
    usedStrategy: "local_draft_remote_review",
    usedModelIds,
    collaborationRunId,
    modelCallIds,
    reviewResult,
    clientName: lastResponse?.clientName,
    modelName: lastResponse?.modelName,
    location: lastResponse?.location,
    latencyMs: lastResponse?.latencyMs,
    usage: lastResponse?.usage,
  };
}
