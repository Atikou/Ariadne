import { AnswerEvaluator } from "./answer-evaluator.js";
import type { ModelRegistry } from "./model-registry.js";
import {
  type ExecutionStrategy,
  type FallbackPlan,
  type FallbackTrigger,
  type ModelLevel,
  type RouterDecision,
  type RuleRouteResult,
} from "./types.js";

export const MAX_FALLBACKS_PER_REQUEST = 2;

function ruleFromDecision(decision: RouterDecision, level?: ModelLevel): RuleRouteResult {
  return {
    taskType: decision.taskType,
    requiredLevel: level ?? decision.selectedLevel,
    risk: decision.risk,
    reason: decision.reason,
  };
}

function primaryModelId(decision: RouterDecision): string | undefined {
  return (
    decision.selectedModelId ??
    decision.finalModelId ??
    decision.reviewModelId ??
    decision.draftModelId
  );
}

export class FallbackManager {
  private readonly answerEvaluator = new AnswerEvaluator();

  constructor(private readonly registry: ModelRegistry) {}

  plan(
    decision: RouterDecision,
    trigger: FallbackTrigger,
    context: {
      fromModelId?: string;
      usedModelIds?: string[];
      localOnly?: boolean;
    } = {},
  ): FallbackPlan | null {
    const fromStrategy = decision.executionStrategy;
    const exclude = new Set(context.usedModelIds ?? []);
    const fromModelId =
      context.fromModelId ?? primaryModelId(decision) ?? decision.candidates[0];
    if (!fromModelId) return null;

    if (fromStrategy === "local_draft_remote_review") {
      return this.planFromCollaboration(decision, trigger, fromModelId, exclude, context.localOnly);
    }

    if (fromStrategy === "parallel_vote") {
      return this.planFromSingle(decision, trigger, fromModelId, exclude, context.localOnly);
    }

    if (fromStrategy === "single_model" || fromStrategy === "strong_model_direct") {
      return this.planFromSingle(decision, trigger, fromModelId, exclude, context.localOnly);
    }

    return null;
  }

  applyPlan(decision: RouterDecision, plan: FallbackPlan): RouterDecision {
    if (plan.toStrategy === "local_draft_remote_review") {
      return {
        ...decision,
        executionStrategy: "local_draft_remote_review",
        draftModelId: plan.toModelId,
        reviewModelId: plan.toModelId,
        finalModelId: plan.toModelId,
        selectedModelId: undefined,
      };
    }

    if (plan.toStrategy === "strong_model_direct") {
      return {
        ...decision,
        executionStrategy: "strong_model_direct",
        selectedModelId: plan.toModelId,
        finalModelId: plan.toModelId,
        draftModelId: undefined,
        reviewModelId: undefined,
      };
    }

    return {
      ...decision,
      executionStrategy: "single_model",
      selectedModelId: plan.toModelId,
      draftModelId: undefined,
      reviewModelId: undefined,
      finalModelId: plan.toModelId,
    };
  }

  detectOutputIssue(
    decision: RouterDecision,
    answer: string,
    userInput: string,
  ): FallbackTrigger | null {
    const evaluation = this.answerEvaluator.evaluate({ decision, answer, userInput });
    if (evaluation.verdict === "needs_fallback") {
      return evaluation.trigger ?? null;
    }
    return null;
  }

  /** 草稿失败：低风险降级为 review 单路；中高风险升级强模型直答。 */
  planDraftFailure(
    decision: RouterDecision,
    risk: RouterDecision["risk"],
    draftModelId: string,
    reviewModelId: string,
    localOnly?: boolean,
  ): FallbackPlan | null {
    if (risk === "low") {
      return {
        fromModelId: draftModelId,
        toModelId: reviewModelId,
        fromStrategy: "local_draft_remote_review",
        toStrategy: "single_model",
        trigger: "model_error",
        reason: "草稿模型失败，低风险改用审查模型单路回答",
        maxAttempts: 1,
      };
    }
    const strongId = this.findStrongModel(decision, [draftModelId], localOnly);
    if (!strongId) return null;
    return {
      fromModelId: draftModelId,
      toModelId: strongId,
      fromStrategy: "local_draft_remote_review",
      toStrategy: "strong_model_direct",
      trigger: "model_error",
      reason: "草稿模型失败，改用强模型直答",
      maxAttempts: 1,
    };
  }

  /** 审查 JSON 解析失败：高风险升级强模型；低风险保留草稿（非 upgrade，返回 null）。 */
  planReviewParseFailure(
    decision: RouterDecision,
    risk: RouterDecision["risk"],
    reviewModelId: string,
    localOnly?: boolean,
  ): FallbackPlan | null {
    if (risk === "low") return null;
    const strongId = this.findStrongModel(decision, [reviewModelId], localOnly);
    if (!strongId) return null;
    return {
      fromModelId: reviewModelId,
      toModelId: strongId,
      fromStrategy: "local_draft_remote_review",
      toStrategy: "strong_model_direct",
      trigger: "json_parse_failed",
      reason: "审查 JSON 解析失败，改用强模型直答",
      maxAttempts: 1,
    };
  }

  planReviewRejected(
    decision: RouterDecision,
    reviewModelId: string,
    localOnly?: boolean,
  ): FallbackPlan | null {
    const strongId = this.findStrongModel(decision, [reviewModelId], localOnly);
    if (!strongId) return null;
    return {
      fromModelId: reviewModelId,
      toModelId: strongId,
      fromStrategy: "local_draft_remote_review",
      toStrategy: "strong_model_direct",
      trigger: "review_rejected",
      reason: "审查拒绝草稿且无修订稿，改用强模型直答",
      maxAttempts: 1,
    };
  }

  private planFromCollaboration(
    decision: RouterDecision,
    trigger: FallbackTrigger,
    fromModelId: string,
    exclude: Set<string>,
    localOnly?: boolean,
  ): FallbackPlan | null {
    if (trigger === "review_rejected" || trigger === "review_failed" || trigger === "json_parse_failed") {
      const strongId = this.findStrongModel(decision, [...exclude], localOnly);
      if (!strongId) return null;
      return {
        fromModelId,
        toModelId: strongId,
        fromStrategy: "local_draft_remote_review",
        toStrategy: "strong_model_direct",
        trigger,
        reason: `协作失败（${trigger}），升级强模型直答`,
        maxAttempts: 1,
      };
    }

    if (trigger === "model_error" || trigger === "model_timeout") {
      const reviewId = decision.reviewModelId ?? decision.finalModelId;
      if (decision.risk === "low" && reviewId && !exclude.has(reviewId)) {
        return {
          fromModelId,
          toModelId: reviewId,
          fromStrategy: "local_draft_remote_review",
          toStrategy: "single_model",
          trigger,
          reason: "协作调用失败，低风险改用审查模型单路",
          maxAttempts: 1,
        };
      }
      const strongId = this.findStrongModel(decision, [...exclude], localOnly);
      if (!strongId) return null;
      return {
        fromModelId,
        toModelId: strongId,
        fromStrategy: "local_draft_remote_review",
        toStrategy: "strong_model_direct",
        trigger,
        reason: "协作调用失败，升级强模型直答",
        maxAttempts: 1,
      };
    }

    return null;
  }

  private planFromSingle(
    decision: RouterDecision,
    trigger: FallbackTrigger,
    fromModelId: string,
    exclude: Set<string>,
    localOnly?: boolean,
  ): FallbackPlan | null {
    if (
      trigger !== "model_error" &&
      trigger !== "model_timeout" &&
      trigger !== "empty_output" &&
      trigger !== "answer_too_short"
    ) {
      return null;
    }

    const upgraded = this.findUpgradedSingleModel(fromModelId, decision, localOnly, exclude);
    if (!upgraded) return null;

    const toStrategy: ExecutionStrategy =
      this.registry.get(upgraded)?.defaultLevel === 3 ? "strong_model_direct" : "single_model";

    return {
      fromModelId,
      toModelId: upgraded,
      fromStrategy: decision.executionStrategy,
      toStrategy,
      trigger,
      reason:
        toStrategy === "strong_model_direct"
          ? "单模型失败或输出不足，升级强模型直答"
          : "单模型失败或输出不足，升级更高等级模型",
      maxAttempts: 1,
    };
  }

  findStrongModel(
    decision: RouterDecision,
    excludeIds: string[] = [],
    localOnly?: boolean,
  ): string | null {
    const exclude = new Set(excludeIds);
    const rule = ruleFromDecision(decision, 3);
    const candidates = this.registry.findFinalCandidates(rule, localOnly);
    const pick =
      candidates.find((p) => p.defaultLevel >= 3 && !exclude.has(p.id)) ??
      candidates.find((p) => !exclude.has(p.id));
    return pick?.id ?? null;
  }

  findUpgradedSingleModel(
    fromModelId: string,
    decision: RouterDecision,
    localOnly?: boolean,
    exclude: Set<string> = new Set(),
  ): string | null {
    const current = this.registry.get(fromModelId);
    if (!current) return null;
    const targetLevel = Math.min(3, (current.defaultLevel + 1) as ModelLevel) as ModelLevel;
    const rule = ruleFromDecision(decision, targetLevel);
    const candidates = this.registry
      .findPrimaryCandidates(rule, localOnly)
      .filter((p) => p.id !== fromModelId && !exclude.has(p.id) && p.defaultLevel > current.defaultLevel);
    if (candidates[0]) return candidates[0].id;
    if (current.defaultLevel < 3) {
      return this.findStrongModel(decision, [fromModelId, ...exclude], localOnly);
    }
    return null;
  }
}
