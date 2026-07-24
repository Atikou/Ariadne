import { randomUUID } from "node:crypto";

import type { ModelRegistry } from "./model-registry.js";
import { applyRoutingContext, type RoutingContext } from "./context-analyzer.js";
import { CostBudgetManager, defaultCostBudgetManager } from "./cost-budget-manager.js";
import { RouterModelEvaluator } from "./router-model-evaluator.js";
import { explainNoAvailableModel } from "./model-capabilities.js";
import { profileSatisfiesDeclaredCapabilities } from "./model-capability-profile.js";
import type { RuntimeStatsFeedback } from "./runtime-stats-feedback.js";
import {
  RouterError,
  type ModelProfile,
  type RouterDecision,
  type RouterInput,
  type RuleRouteResult,
  type TaskType,
} from "./types.js";

export class DecisionEngine {
  private readonly evaluator = new RouterModelEvaluator();

  constructor(
    private readonly registry: ModelRegistry,
    private readonly runtimeFeedback?: RuntimeStatsFeedback,
    private readonly costBudget: CostBudgetManager = defaultCostBudgetManager,
  ) {}

  private routerContext(input: RouterInput) {
    return {
      userInput: input.userInput,
      localOnly: input.localOnly,
      hasAttachments: input.hasAttachments,
      attachmentTypes: input.attachmentTypes,
    };
  }

  private throwNoAvailableModel(rule: RuleRouteResult, input: RouterInput): never {
    throw new RouterError(
      "NO_AVAILABLE_MODEL",
      explainNoAvailableModel(
        rule,
        this.routerContext(input),
        this.registry.listAll(),
        this.registry.listEnabled(input.localOnly),
      ),
    );
  }

  decide(rule: RuleRouteResult, input: RouterInput, routingContext?: RoutingContext): RouterDecision {
    const context = routingContext;
    let effectiveRule = context ? applyRoutingContext(rule, context) : rule;
    if (input.requiredCapabilities?.length) {
      effectiveRule = {
        ...effectiveRule,
        requiredCapabilities: [
          ...new Set([
            ...(effectiveRule.requiredCapabilities ?? []),
            ...input.requiredCapabilities,
          ]),
        ],
      };
    }
    if (context?.suggestedLevelBump) {
      const probe = this.registry.findPrimaryCandidates(
        effectiveRule,
        input.localOnly,
        this.routerContext(input),
      );
      if (probe.length === 0) {
        effectiveRule = rule;
      }
    }
    const contextNote =
      context && context.signals.length > 0
        ? `；V8 上下文：${context.signals.join("，")}`
        : "";

    const now = new Date().toISOString();
    const base = {
      id: randomUUID(),
      sessionId: input.sessionId,
      projectId: input.projectId,
      taskType: effectiveRule.taskType,
      selectedLevel: effectiveRule.requiredLevel,
      risk: effectiveRule.risk,
      reason: effectiveRule.reason,
      requireUserConfirmation: effectiveRule.requireUserConfirmation ?? false,
      createdAt: now,
      candidates: [] as string[],
      contextSignals: context?.signals,
    };

    if (input.forceModelId) {
      const forced = this.registry.get(input.forceModelId);
      if (!forced?.enabled) {
        throw new RouterError("NO_AVAILABLE_MODEL", `未找到指定模型：${input.forceModelId}`);
      }
      const required = effectiveRule.requiredCapabilities ?? [];
      if (!profileSatisfiesDeclaredCapabilities(forced, required)) {
        throw new RouterError(
          "MODEL_CAPABILITY_MISMATCH",
          `指定模型 ${forced.id} 不满足当前执行协议，必须具备：${required.join("、")}`,
        );
      }
      if (input.agentProtocolRequired && !this.registry.isAgentProtocolAdmitted(forced)) {
        throw new RouterError(
          "MODEL_PROTOCOL_QUARANTINED",
          `指定模型 ${forced.id} 因连续违反严格 AgentAction 协议而处于临时隔离；普通聊天仍可使用，请等待隔离期结束或改用其他 Agent 模型。`,
        );
      }
      return {
        ...base,
        source: "manual_override",
        executionStrategy: "single_model",
        selectedModelId: forced.id,
        candidates: [forced.id],
        reason: `手动指定模型 ${forced.id}`,
      };
    }

    let strategy = effectiveRule.preferredStrategy ?? "single_model";
    if (
      strategy !== "rule_only" &&
      (input.forceSingleModel || input.allowCollaboration === false || input.qualityMode === "fast")
    ) {
      strategy = "single_model";
    } else if (
      strategy === "local_draft_remote_review" &&
      !effectiveRule.preferCollaboration &&
      input.qualityMode !== "deep"
    ) {
      strategy = "single_model";
    }

    if (strategy === "rule_only") {
      return {
        ...base,
        source: "rule",
        executionStrategy: "rule_only",
        candidates: [],
        reason: `${base.reason}；不调用模型${contextNote}`,
      };
    }

    if (strategy === "single_model") {
      const primary = this.registry.findPrimaryCandidates(
        effectiveRule,
        input.localOnly,
        this.routerContext(input),
      );
      if (primary.length === 0) {
        this.throwNoAvailableModel(effectiveRule, input);
      }
      const ranked = this.rankCandidates(
        primary,
        input,
        effectiveRule.taskType,
        context?.effectiveTokenEstimate,
      );
      const evaluation = this.evaluator.evaluate({
        routerInput: input,
        rule: effectiveRule,
        candidates: ranked.candidates,
        routingContext: context,
      });
      let pick = ranked.candidates[0]!;
      let source: RouterDecision["source"] = "rule";
      let reason = base.reason;
      if (evaluation.shouldOverrideRule && evaluation.recommendedModelId) {
        const override = ranked.candidates.find((p) => p.id === evaluation.recommendedModelId);
        if (override) {
          pick = override;
          source = "evaluator";
          reason = `${base.reason}；V3 评估：${evaluation.reasons.join("，")}`;
        }
      }
      if (
        this.runtimeFeedback &&
        ranked.statsSignals.length > 0 &&
        pick.id !== ranked.candidates[0]!.id
      ) {
        pick = ranked.candidates[0]!;
        source = "runtime_stats";
        reason = `${base.reason}；V8 运行反馈：${ranked.statsSignals.join("，")}`;
      } else if (pick.id !== primary[0]!.id && source === "rule" && ranked.statsSignals.length > 0) {
        source = "runtime_stats";
        reason = `${base.reason}；V8 运行反馈：${ranked.statsSignals.join("，")}`;
      }
      if (ranked.costSignals.length > 0 && pick.id !== ranked.candidates[0]!.id) {
        pick = ranked.candidates[0]!;
        source = "cost_budget";
        reason = `${base.reason}；V8 成本预算：${ranked.costSignals.join("，")}`;
      }
      const contextSignals = [
        ...(context?.signals ?? []),
        ...ranked.statsSignals.map((s) => `stats:${s}`),
        ...ranked.costSignals.map((s) => `cost:${s}`),
      ];
      return {
        ...base,
        source,
        executionStrategy: "single_model",
        selectedModelId: pick.id,
        candidates: ranked.candidates.map((p) => p.id),
        contextSignals: contextSignals.length > 0 ? contextSignals : undefined,
        reason: `${reason}${contextNote}`,
      };
    }

    if (
      strategy === "local_draft_remote_review" &&
      input.qualityMode === "deep" &&
      !input.localOnly
    ) {
      const parallel = this.decideParallelVote(effectiveRule, input, base, context, contextNote);
      if (parallel) return parallel;
    }

    return this.decideCollaboration(effectiveRule, input, base, context, contextNote);
  }

  private decideParallelVote(
    rule: RuleRouteResult,
    input: RouterInput,
    base: Omit<RouterDecision, "source" | "executionStrategy" | "candidates"> & { candidates: string[] },
    routingContext?: RoutingContext,
    contextNote = "",
  ): RouterDecision | null {
    const tokenNeed = routingContext?.effectiveTokenEstimate ?? input.contextTokenEstimate;
    const merged = this.findParallelVotePool(rule, input, tokenNeed);
    const ranked = this.rankCandidates(merged, input, rule.taskType, tokenNeed);
    if (ranked.candidates.length < 2) return null;

    const reviewRanked = this.rankCandidates(
      this.registry.findReviewCandidates(rule, input.localOnly, this.routerContext(input)),
      input,
      rule.taskType,
      tokenNeed,
    );
    const voters = ranked.candidates.slice(0, 2);
    const judge =
      reviewRanked.candidates.find((p) => !voters.some((v) => v.id === p.id)) ??
      reviewRanked.candidates[0];
    if (!judge) return null;

    const voteModelIds = voters.map((v) => v.id);
    const feedbackNote =
      ranked.statsSignals.length > 0 ? `；V8 运行反馈：${ranked.statsSignals.join("，")}` : "";
    const costNote = ranked.costSignals.length > 0 ? `；V8 成本预算：${ranked.costSignals.join("，")}` : "";

    return {
      ...base,
      source: "rule",
      executionStrategy: "parallel_vote",
      voteModelIds,
      judgeModelId: judge.id,
      draftModelId: voteModelIds[0],
      finalModelId: voteModelIds[1],
      reviewModelId: judge.id,
      candidates: [...new Set([...voteModelIds, judge.id])],
      contextSignals: [
        ...(routingContext?.signals ?? []),
        ...ranked.statsSignals.map((s) => `stats:${s}`),
        ...ranked.costSignals.map((s) => `cost:${s}`),
        "parallel_vote",
      ],
      reason: `${base.reason}；deep 模式并行投票（${voteModelIds.join(" vs ")}，裁决 ${judge.id}）${feedbackNote}${costNote}${contextNote}`,
    };
  }

  private findParallelVotePool(
    rule: RuleRouteResult,
    input: RouterInput,
    tokenNeed?: number,
  ): ModelProfile[] {
    const primary = this.registry.findPrimaryCandidates(
      rule,
      input.localOnly,
      this.routerContext(input),
    );
    const relaxed = this.registry.findDraftCandidates(
      rule,
      input.localOnly,
      tokenNeed,
      this.routerContext(input),
    );
    const seen = new Set<string>();
    const merged: ModelProfile[] = [];
    for (const profile of [...primary, ...relaxed]) {
      if (seen.has(profile.id)) continue;
      seen.add(profile.id);
      merged.push(profile);
    }
    return merged;
  }

  private rankCandidates(
    candidates: ModelProfile[],
    input: RouterInput,
    taskType: TaskType,
    tokenEstimate?: number,
  ): { candidates: ModelProfile[]; statsSignals: string[]; costSignals: string[] } {
    let current = candidates;
    let statsSignals: string[] = [];
    if (this.runtimeFeedback && current.length > 1) {
      const statsRanked = this.runtimeFeedback.rankCandidates(current, taskType);
      current = statsRanked.candidates;
      statsSignals = statsRanked.signals;
    }
    const costRanked = this.costBudget.rankCandidates(
      current,
      input,
      tokenEstimate ?? input.contextTokenEstimate,
    );
    return {
      candidates: costRanked.candidates,
      statsSignals,
      costSignals: costRanked.signals,
    };
  }

  private decideCollaboration(
    rule: RuleRouteResult,
    input: RouterInput,
    base: Omit<RouterDecision, "source" | "executionStrategy" | "candidates"> & { candidates: string[] },
    routingContext?: RoutingContext,
    contextNote = "",
  ): RouterDecision {
    const tokenNeed = routingContext?.effectiveTokenEstimate ?? input.contextTokenEstimate;
    const draftRanked = this.rankCandidates(
      this.registry.findDraftCandidates(rule, input.localOnly, tokenNeed, this.routerContext(input)),
      input,
      rule.taskType,
      tokenNeed,
    );
    const reviewRanked = this.rankCandidates(
      this.registry.findReviewCandidates(rule, input.localOnly, this.routerContext(input)),
      input,
      rule.taskType,
      tokenNeed,
    );
    const drafts = draftRanked.candidates;
    const reviews = reviewRanked.candidates;
    const feedbackSignals = [...draftRanked.statsSignals, ...reviewRanked.statsSignals];
    const costSignals = [...draftRanked.costSignals, ...reviewRanked.costSignals];
    const feedbackNote =
      feedbackSignals.length > 0 ? `；V8 运行反馈：${feedbackSignals.join("，")}` : "";
    const costNote = costSignals.length > 0 ? `；V8 成本预算：${costSignals.join("，")}` : "";
    const mergedContextSignals = [
      ...(routingContext?.signals ?? []),
      ...feedbackSignals.map((s) => `stats:${s}`),
      ...costSignals.map((s) => `cost:${s}`),
    ];
    const withStats = {
      ...base,
      contextSignals: mergedContextSignals.length > 0 ? mergedContextSignals : base.contextSignals,
    };

    if (reviews.length === 0) {
      if (rule.risk === "high") {
        throw new RouterError(
          "NO_REVIEW_MODEL_AVAILABLE",
          "高风险协作任务无可用审查模型，不允许静默降级",
        );
      }
      const primary = this.registry.findPrimaryCandidates(
        rule,
        input.localOnly,
        this.routerContext(input),
      );
      if (primary.length === 0) {
        this.throwNoAvailableModel(rule, input);
      }
      const ranked = this.rankCandidates(primary, input, rule.taskType, tokenNeed);
      const strong = ranked.candidates.find((p) => p.defaultLevel >= 3) ?? ranked.candidates[0]!;
      return {
        ...withStats,
        source: "fallback",
        executionStrategy: "single_model",
        selectedModelId: strong.id,
        candidates: ranked.candidates.map((p) => p.id),
        fallbackNote: "无审查模型，降级为 single_model",
        reason: `${base.reason}；无 review 模型${feedbackNote}${costNote}${contextNote}`,
      };
    }

    const draft = drafts[0];
    const review = reviews[0]!;
    const allCandidates = [...new Set([...(draft ? [draft.id] : []), ...reviews.map((r) => r.id)])];

    if (!draft) {
      if (rule.risk === "low") {
        return {
          ...withStats,
          source: "fallback",
          executionStrategy: "single_model",
          selectedModelId: review.id,
          candidates: allCandidates,
          fallbackNote: "无草稿模型，直接使用审查模型",
          reason: `${base.reason}${feedbackNote}${costNote}${contextNote}`,
        };
      }
      return {
        ...withStats,
        source: "fallback",
        executionStrategy: "single_model",
        selectedModelId: review.id,
        candidates: allCandidates,
        fallbackNote: "无草稿模型，中高风险改用强单模型",
        reason: `${base.reason}${feedbackNote}${costNote}${contextNote}`,
      };
    }

    return {
      ...withStats,
      source: "rule",
      executionStrategy: "local_draft_remote_review",
      draftModelId: draft.id,
      reviewModelId: review.id,
      finalModelId: review.id,
      candidates: allCandidates,
      reason: `${base.reason}${feedbackNote}${costNote}${contextNote}`,
    };
  }
}
