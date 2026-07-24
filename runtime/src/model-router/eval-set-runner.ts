import { randomUUID } from "node:crypto";

import { DecisionEngine } from "./decision-engine.js";
import { DEFAULT_ROUTING_EVAL_SET } from "./eval-set-defaults.js";
import type { ModelEvalStore } from "./eval-set-store.js";
import type { ModelRegistry } from "./model-registry.js";
import { RuleRouter } from "./route-rules.js";
import type {
  EvalSetCase,
  EvalSetCaseResult,
  EvalSetRunSummary,
  EvalSetScope,
} from "./eval-set-types.js";
import type {
  ExecutionStrategy,
  ModelLevel,
  RouterInput,
  TaskType,
} from "./types.js";

export interface EvalSetRunOptions {
  scope?: EvalSetScope;
  setName?: string;
  cases?: EvalSetCase[];
  persist?: boolean;
}

interface ObservedRoute {
  taskType: TaskType;
  level: ModelLevel;
  strategy?: ExecutionStrategy;
}

/**
 * V7：离线评测 RuleRouter / DecisionEngine，不调用模型、不写 route_logs。
 */
export class EvalSetRunner {
  private readonly ruleRouter = new RuleRouter();
  private readonly decisionEngine?: DecisionEngine;

  constructor(
    registry?: ModelRegistry,
    private readonly store?: ModelEvalStore,
  ) {
    if (registry) {
      this.decisionEngine = new DecisionEngine(registry);
    }
  }

  run(options: EvalSetRunOptions = {}): EvalSetRunSummary {
    const scope = options.scope ?? "rule";
    if (scope === "smart" && !this.decisionEngine) {
      throw new Error("smart 评测需要 ModelRegistry");
    }

    const cases = options.cases?.length ? options.cases : DEFAULT_ROUTING_EVAL_SET;
    const setName = options.setName ?? "default-routing-eval";
    const startedAt = new Date().toISOString();
    const runId = randomUUID();
    const results: EvalSetCaseResult[] = [];

    for (const evalCase of cases) {
      results.push(this.evaluateCase(evalCase, scope));
    }

    const passed = results.filter((r) => r.verdict === "pass").length;
    const failed = results.filter((r) => r.verdict === "fail").length;
    const skipped = results.filter((r) => r.verdict === "skipped").length;
    const finishedAt = new Date().toISOString();

    const summary: EvalSetRunSummary = {
      runId,
      setName,
      scope,
      startedAt,
      finishedAt,
      total: results.length,
      passed,
      failed,
      skipped,
      results,
    };

    if (options.persist !== false && this.store) {
      this.store.saveRun(summary, setName, scope);
    }

    return summary;
  }

  private evaluateCase(evalCase: EvalSetCase, scope: EvalSetScope): EvalSetCaseResult {
    const routerInput: RouterInput = {
      userInput: evalCase.input,
      ...evalCase.routerInput,
    };
    const observed = this.observeRoute(routerInput, scope);
    const hasExpectation =
      evalCase.expectedTaskType != null ||
      evalCase.expectedLevel != null ||
      evalCase.expectedStrategy != null;

    if (!hasExpectation) {
      return {
        caseId: evalCase.id,
        caseTitle: evalCase.title,
        inputPreview: evalCase.input,
        verdict: "skipped",
        actualTaskType: observed.taskType,
        actualLevel: observed.level,
        actualStrategy: observed.strategy,
        notes: ["no_expectation_defined"],
      };
    }

    const notes: string[] = [];
    let fail = false;

    if (evalCase.expectedTaskType != null && evalCase.expectedTaskType !== observed.taskType) {
      fail = true;
      notes.push(`taskType: expected=${evalCase.expectedTaskType} actual=${observed.taskType}`);
    }
    if (evalCase.expectedLevel != null && evalCase.expectedLevel !== observed.level) {
      fail = true;
      notes.push(`level: expected=${evalCase.expectedLevel} actual=${observed.level}`);
    }
    if (
      evalCase.expectedStrategy != null &&
      evalCase.expectedStrategy !== observed.strategy
    ) {
      fail = true;
      notes.push(`strategy: expected=${evalCase.expectedStrategy} actual=${observed.strategy ?? "n/a"}`);
    }

    return {
      caseId: evalCase.id,
      caseTitle: evalCase.title,
      inputPreview: evalCase.input,
      verdict: fail ? "fail" : "pass",
      expectedTaskType: evalCase.expectedTaskType,
      actualTaskType: observed.taskType,
      expectedLevel: evalCase.expectedLevel,
      actualLevel: observed.level,
      expectedStrategy: evalCase.expectedStrategy,
      actualStrategy: observed.strategy,
      notes: notes.length ? notes : undefined,
    };
  }

  private observeRoute(input: RouterInput, scope: EvalSetScope): ObservedRoute {
    const rule = this.ruleRouter.evaluate(input);
    if (scope === "rule") {
      return {
        taskType: rule.taskType,
        level: rule.requiredLevel,
        strategy: rule.preferredStrategy,
      };
    }
    const decision = this.decisionEngine!.decide(rule, {
      ...input,
      forceSingleModel: input.forceSingleModel ?? true,
    });
    return {
      taskType: decision.taskType,
      level: decision.selectedLevel,
      strategy: decision.executionStrategy,
    };
  }
}
