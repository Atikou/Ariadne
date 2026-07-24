import { DecisionEngine } from "./decision-engine.js";
import { defaultContextAnalyzer, type RoutingContext } from "./context-analyzer.js";
import type { CostBudgetManager } from "./cost-budget-manager.js";
import type { ModelRegistry } from "./model-registry.js";
import type { RuntimeStatsFeedback } from "./runtime-stats-feedback.js";
import { RuleRouter } from "./route-rules.js";
import type { RouteLogStore } from "./route-stores.js";
import type { RouterDecision, RouterInput } from "./types.js";

/** 规则路由 + 策略决策的统一入口（不负责执行模型调用）。 */
export class SmartModelRouter {
  private readonly ruleRouter = new RuleRouter();
  private readonly decisionEngine: DecisionEngine;

  constructor(
    registry: ModelRegistry,
    private readonly routeLogStore?: RouteLogStore,
    runtimeFeedback?: RuntimeStatsFeedback,
    costBudget?: CostBudgetManager,
  ) {
    this.decisionEngine = new DecisionEngine(registry, runtimeFeedback, costBudget);
  }

  route(input: RouterInput): RouterDecision {
    return this.routeDetailed(input).decision;
  }

  routeDetailed(input: RouterInput): { decision: RouterDecision; routingContext: RoutingContext } {
    const routingContext = defaultContextAnalyzer.analyze(input);
    const rule = this.ruleRouter.evaluate(input);
    const decision = this.decisionEngine.decide(rule, input, routingContext);
    this.routeLogStore?.save(decision, input.userInput);
    return { decision, routingContext };
  }
}
