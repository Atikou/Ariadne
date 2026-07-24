import type { DatabaseSync } from "node:sqlite";

import type { ClientStats, MetricsRegistry } from "../model/MetricsRegistry.js";

export type RuntimeStatsSuggestionSeverity = "info" | "warn";

export type RuntimeStatsSuggestionCategory =
  | "model_reliability"
  | "fallback_pattern"
  | "routing_source"
  | "process_metrics";

export interface RuntimeStatsSuggestion {
  id: string;
  severity: RuntimeStatsSuggestionSeverity;
  category: RuntimeStatsSuggestionCategory;
  message: string;
  evidence: Record<string, string | number | boolean>;
}

export interface ModelRuntimeMetric {
  modelId: string;
  calls: number;
  errors: number;
  errorRate: number;
  avgDurationMs: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  fallbackFromCount: number;
  fallbackToCount: number;
}

export interface TaskTypeRuntimeMetric {
  taskType: string;
  routes: number;
  routesWithFallback: number;
  fallbackRate: number;
  evaluatorRoutes: number;
  topStrategy: string;
}

export interface RuntimeStatsSnapshot {
  generatedAt: string;
  window: { routeLimit: number };
  summary: {
    routeCount: number;
    routesWithFallback: number;
    fallbackRate: number;
    evaluatorOverrides: number;
    ruleOnlyRoutes: number;
  };
  models: ModelRuntimeMetric[];
  taskTypes: TaskTypeRuntimeMetric[];
  processMetrics: ClientStats[];
  suggestions: RuntimeStatsSuggestion[];
}

export interface RuntimeStatsOptions {
  routeLimit?: number;
}

const DEFAULT_ROUTE_LIMIT = 200;
const MIN_MODEL_CALLS_FOR_WARN = 3;
const MODEL_ERROR_RATE_WARN = 0.25;
const MIN_ROUTES_FOR_TASK_WARN = 5;
const TASK_FALLBACK_RATE_WARN = 0.15;

interface ModelRow {
  model_id: string;
  calls: number;
  errors: number;
  avg_duration: number | null;
  prompt_tokens: number;
  completion_tokens: number;
}

interface TaskRow {
  task_type: string;
  routes: number;
  routes_with_fallback: number;
  evaluator_routes: number;
  top_strategy: string;
}

/**
 * V6：从路由 SQLite 表与进程内 MetricsRegistry 聚合运行统计，输出只读调优建议（不改配置）。
 */
export class RuntimeStatsCollector {
  constructor(
    private readonly db: DatabaseSync,
    private readonly metrics?: MetricsRegistry,
  ) {}

  snapshot(options: RuntimeStatsOptions = {}): RuntimeStatsSnapshot {
    const routeLimit = Math.min(Math.max(options.routeLimit ?? DEFAULT_ROUTE_LIMIT, 1), 1000);
    const models = this.collectModelMetrics();
    const taskTypes = this.collectTaskTypeMetrics(routeLimit);
    const summary = this.collectRouteSummary(routeLimit);
    const processMetrics = this.metrics?.snapshot() ?? [];
    const suggestions = this.buildSuggestions({
      models,
      taskTypes,
      summary,
      processMetrics,
    });

    return {
      generatedAt: new Date().toISOString(),
      window: { routeLimit },
      summary,
      models,
      taskTypes,
      processMetrics,
      suggestions,
    };
  }

  private collectModelMetrics(): ModelRuntimeMetric[] {
    const rows = this.db
      .prepare(
        `SELECT model_id,
                COUNT(*) AS calls,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
                AVG(duration_ms) AS avg_duration,
                SUM(COALESCE(prompt_tokens, 0)) AS prompt_tokens,
                SUM(COALESCE(completion_tokens, 0)) AS completion_tokens
         FROM model_call_logs
         GROUP BY model_id
         ORDER BY calls DESC`,
      )
      .all() as unknown as ModelRow[];

    const fallbackFrom = new Map<string, number>();
    for (const row of this.db
      .prepare(`SELECT from_model_id AS model_id, COUNT(*) AS cnt FROM fallback_logs GROUP BY from_model_id`)
      .all() as Array<{ model_id: string; cnt: number }>) {
      fallbackFrom.set(row.model_id, row.cnt);
    }
    const fallbackTo = new Map<string, number>();
    for (const row of this.db
      .prepare(`SELECT to_model_id AS model_id, COUNT(*) AS cnt FROM fallback_logs GROUP BY to_model_id`)
      .all() as Array<{ model_id: string; cnt: number }>) {
      fallbackTo.set(row.model_id, row.cnt);
    }

    return rows.map((row) => {
      const calls = Number(row.calls);
      const errors = Number(row.errors);
      return {
        modelId: row.model_id,
        calls,
        errors,
        errorRate: calls === 0 ? 0 : errors / calls,
        avgDurationMs: Math.round(Number(row.avg_duration ?? 0)),
        totalPromptTokens: Number(row.prompt_tokens),
        totalCompletionTokens: Number(row.completion_tokens),
        fallbackFromCount: fallbackFrom.get(row.model_id) ?? 0,
        fallbackToCount: fallbackTo.get(row.model_id) ?? 0,
      };
    });
  }

  private collectTaskTypeMetrics(routeLimit: number): TaskTypeRuntimeMetric[] {
    const rows = this.db
      .prepare(
        `WITH recent_routes AS (
           SELECT id, task_type, execution_strategy, source
           FROM model_route_logs
           ORDER BY created_at DESC
           LIMIT ?
         )
         SELECT rr.task_type,
                COUNT(*) AS routes,
                COUNT(DISTINCT f.route_log_id) AS routes_with_fallback,
                SUM(CASE WHEN rr.source = 'evaluator' THEN 1 ELSE 0 END) AS evaluator_routes,
                (
                  SELECT execution_strategy
                  FROM recent_routes rr2
                  WHERE rr2.task_type = rr.task_type
                  GROUP BY execution_strategy
                  ORDER BY COUNT(*) DESC
                  LIMIT 1
                ) AS top_strategy
         FROM recent_routes rr
         LEFT JOIN fallback_logs f ON f.route_log_id = rr.id
         GROUP BY rr.task_type
         ORDER BY routes DESC`,
      )
      .all(routeLimit) as unknown as TaskRow[];

    return rows.map((row) => {
      const routes = Number(row.routes);
      const routesWithFallback = Number(row.routes_with_fallback);
      return {
        taskType: row.task_type,
        routes,
        routesWithFallback,
        fallbackRate: routes === 0 ? 0 : routesWithFallback / routes,
        evaluatorRoutes: Number(row.evaluator_routes),
        topStrategy: row.top_strategy,
      };
    });
  }

  private collectRouteSummary(routeLimit: number): RuntimeStatsSnapshot["summary"] {
    const recent = this.db
      .prepare(
        `SELECT id, source, execution_strategy
         FROM model_route_logs
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(routeLimit) as Array<{ id: string; source: string; execution_strategy: string }>;

    const routeIds = recent.map((r) => r.id);
    let routesWithFallback = 0;
    if (routeIds.length > 0) {
      const placeholders = routeIds.map(() => "?").join(",");
      const row = this.db
        .prepare(
          `SELECT COUNT(DISTINCT route_log_id) AS cnt
           FROM fallback_logs
           WHERE route_log_id IN (${placeholders})`,
        )
        .get(...routeIds) as { cnt: number };
      routesWithFallback = Number(row.cnt);
    }

    const routeCount = recent.length;
    return {
      routeCount,
      routesWithFallback,
      fallbackRate: routeCount === 0 ? 0 : routesWithFallback / routeCount,
      evaluatorOverrides: recent.filter((r) => r.source === "evaluator").length,
      ruleOnlyRoutes: recent.filter((r) => r.execution_strategy === "rule_only").length,
    };
  }

  private buildSuggestions(input: {
    models: ModelRuntimeMetric[];
    taskTypes: TaskTypeRuntimeMetric[];
    summary: RuntimeStatsSnapshot["summary"];
    processMetrics: ClientStats[];
  }): RuntimeStatsSuggestion[] {
    const suggestions: RuntimeStatsSuggestion[] = [];

    for (const model of input.models) {
      if (
        model.calls >= MIN_MODEL_CALLS_FOR_WARN &&
        model.errorRate >= MODEL_ERROR_RATE_WARN
      ) {
        suggestions.push({
          id: `model-error-${model.modelId}`,
          severity: "warn",
          category: "model_reliability",
          message: `模型 ${model.modelId} 错误率偏高，建议检查可用性或调高 routerProfile.defaultLevel / 减少 primary 候选。`,
          evidence: {
            modelId: model.modelId,
            calls: model.calls,
            errorRate: Number(model.errorRate.toFixed(3)),
            fallbackFromCount: model.fallbackFromCount,
          },
        });
      }
      if (model.fallbackFromCount >= 2 && model.calls >= MIN_MODEL_CALLS_FOR_WARN) {
        suggestions.push({
          id: `model-fallback-from-${model.modelId}`,
          severity: "info",
          category: "fallback_pattern",
          message: `模型 ${model.modelId} 多次作为 fallback 源，可考虑为对应 taskType 提高 requiredLevel 或默认协作策略。`,
          evidence: {
            modelId: model.modelId,
            fallbackFromCount: model.fallbackFromCount,
            calls: model.calls,
          },
        });
      }
    }

    for (const task of input.taskTypes) {
      if (task.routes >= MIN_ROUTES_FOR_TASK_WARN && task.fallbackRate >= TASK_FALLBACK_RATE_WARN) {
        suggestions.push({
          id: `task-fallback-${task.taskType}`,
          severity: "warn",
          category: "fallback_pattern",
          message: `任务类型 ${task.taskType} 近期 fallback 比例偏高，建议复核 RuleRouter 规则或默认策略（当前主流策略：${task.topStrategy}）。`,
          evidence: {
            taskType: task.taskType,
            routes: task.routes,
            fallbackRate: Number(task.fallbackRate.toFixed(3)),
            topStrategy: task.topStrategy,
          },
        });
      }
      if (task.evaluatorRoutes >= 3 && task.taskType === "unknown") {
        suggestions.push({
          id: `task-evaluator-unknown`,
          severity: "info",
          category: "routing_source",
          message: `unknown 任务多次由 V3 评估器覆盖，建议补充 RuleRouter 关键词规则以减少启发式覆盖。`,
          evidence: {
            taskType: task.taskType,
            evaluatorRoutes: task.evaluatorRoutes,
            routes: task.routes,
          },
        });
      }
    }

    if (input.summary.fallbackRate >= TASK_FALLBACK_RATE_WARN && input.summary.routeCount >= 10) {
      suggestions.push({
        id: "global-fallback-rate",
        severity: "warn",
        category: "fallback_pattern",
        message: `近期整体 fallback 比例偏高，建议结合模型路由日志与运行报告排查空输出/审查拒绝等触发原因。`,
        evidence: {
          routeCount: input.summary.routeCount,
          routesWithFallback: input.summary.routesWithFallback,
          fallbackRate: Number(input.summary.fallbackRate.toFixed(3)),
        },
      });
    }

    for (const client of input.processMetrics) {
      if (client.calls >= MIN_MODEL_CALLS_FOR_WARN && client.failureRate >= MODEL_ERROR_RATE_WARN) {
        suggestions.push({
          id: `process-error-${client.clientName}`,
          severity: "info",
          category: "process_metrics",
          message: `进程内指标显示客户端 ${client.clientName} 失败率偏高（连通性层），与 SQLite 路由统计对照排查。`,
          evidence: {
            clientName: client.clientName,
            calls: client.calls,
            failureRate: Number(client.failureRate.toFixed(3)),
          },
        });
      }
    }

    return suggestions;
  }
}
