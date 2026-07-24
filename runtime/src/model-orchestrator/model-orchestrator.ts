import type { FallbackLogStore } from "../model-router/route-stores.js";
import { AnswerEvaluator } from "../model-router/answer-evaluator.js";
import {
  FallbackManager,
  MAX_FALLBACKS_PER_REQUEST,
} from "../model-router/fallback-manager.js";
import type { CollaborationRunStore } from "../model-router/route-stores.js";
import type { RouterDecision } from "../model-router/types.js";
import { runDraftReviewPipeline } from "./pipelines/draft-review-pipeline.js";
import { runParallelVotePipeline } from "./pipelines/parallel-vote-pipeline.js";
import { runRuleOnlyPipeline } from "./pipelines/rule-only-pipeline.js";
import { runSingleModelPipeline } from "./pipelines/single-model-pipeline.js";
import type {
  ModelChatFn,
  OrchestratorInput,
  OrchestratorResult,
  PipelineFallbackContext,
} from "./types.js";

export class ModelOrchestrator {
  private readonly answerEvaluator = new AnswerEvaluator();

  constructor(
    private readonly chat: ModelChatFn,
    private readonly collaborationStore: CollaborationRunStore,
    private readonly fallbackManager: FallbackManager,
    private readonly fallbackLogStore: FallbackLogStore,
  ) {}

  async run(input: OrchestratorInput): Promise<OrchestratorResult> {
    let decision = input.routerDecision;
    let fallbackCount = 0;
    const fallbackLogIds: string[] = [];
    const usedModelIds: string[] = [];

    const fallbackCtx: PipelineFallbackContext = {
      manager: this.fallbackManager,
      logStore: this.fallbackLogStore,
      recordFallback: (logId) => {
        fallbackLogIds.push(logId);
        fallbackCount += 1;
      },
      localOnly: input.localOnly,
    };

    for (;;) {
      const currentInput: OrchestratorInput = { ...input, routerDecision: decision };
      let result: OrchestratorResult;

      try {
        result = await this.executeOnce(currentInput, fallbackCtx);
      } catch (error) {
        const strategy = decision.executionStrategy;
        if (
          (strategy !== "single_model" &&
            strategy !== "strong_model_direct" &&
            strategy !== "parallel_vote") ||
          fallbackCount >= MAX_FALLBACKS_PER_REQUEST
        ) {
          throw error;
        }
        const plan = this.fallbackManager.plan(decision, "model_error", {
          fromModelId: decision.selectedModelId ?? decision.finalModelId,
          usedModelIds,
        });
        if (!plan) throw error;
        const logId = this.recordPlan(decision, input.sessionId, plan);
        fallbackCtx.recordFallback(logId);
        decision = this.fallbackManager.applyPlan(decision, plan);
        continue;
      }

      usedModelIds.push(...result.usedModelIds);

      const answerEval = this.answerEvaluator.evaluate({
        decision,
        answer: result.finalAnswer,
        userInput: input.userInput,
      });
      if (
        answerEval.verdict === "needs_fallback" &&
        answerEval.trigger &&
        fallbackCount < MAX_FALLBACKS_PER_REQUEST
      ) {
        const plan = this.fallbackManager.plan(decision, answerEval.trigger, { usedModelIds });
        if (plan) {
          const enrichedPlan =
            answerEval.reasons.length > 0
              ? { ...plan, reason: `${plan.reason}；V4 评估：${answerEval.reasons.join("，")}` }
              : plan;
          const logId = this.recordPlan(decision, input.sessionId, enrichedPlan);
          fallbackCtx.recordFallback(logId);
          decision = this.fallbackManager.applyPlan(decision, enrichedPlan);
          continue;
        }
      }

      return {
        ...result,
        fallbackCount: fallbackCount > 0 ? fallbackCount : undefined,
        fallbackLogIds: fallbackLogIds.length > 0 ? fallbackLogIds : undefined,
      };
    }
  }

  private recordPlan(
    decision: RouterDecision,
    sessionId: string | undefined,
    plan: ReturnType<FallbackManager["plan"]> & object,
  ): string {
    return this.fallbackLogStore.create({
      routeLogId: decision.id,
      sessionId,
      fromModelId: plan.fromModelId,
      toModelId: plan.toModelId,
      fromStrategy: plan.fromStrategy,
      toStrategy: plan.toStrategy,
      triggerType: plan.trigger,
      reason: plan.reason,
    });
  }

  private async executeOnce(
    input: OrchestratorInput,
    fallbackCtx: PipelineFallbackContext,
  ): Promise<OrchestratorResult> {
    const strategy = input.routerDecision.executionStrategy;
    if (strategy === "rule_only") {
      return runRuleOnlyPipeline(input);
    }
    if (strategy === "single_model" || strategy === "strong_model_direct") {
      return runSingleModelPipeline(input, this.chat);
    }
    if (strategy === "local_draft_remote_review") {
      return runDraftReviewPipeline(
        input,
        this.chat,
        this.collaborationStore,
        input.routerDecision.risk,
        fallbackCtx,
      );
    }
    if (strategy === "parallel_vote") {
      return runParallelVotePipeline(
        input,
        this.chat,
        this.collaborationStore,
        fallbackCtx,
      );
    }
    throw new Error(`不支持的执行策略：${strategy}`);
  }
}
