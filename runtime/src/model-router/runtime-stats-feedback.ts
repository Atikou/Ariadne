import type { DatabaseSync } from "node:sqlite";

import type { ModelProfile, TaskType } from "./types.js";

const DEFAULT_CACHE_TTL_MS = 30_000;
const MIN_CALLS_FOR_PENALTY = 3;
const ERROR_RATE_PENALTY_THRESHOLD = 0.25;
const FALLBACK_FROM_PENALTY_MIN = 2;

export interface RuntimeStatsFeedbackOptions {
  cacheTtlMs?: number;
  minCallsForPenalty?: number;
  errorRatePenaltyThreshold?: number;
}

interface ModelFeedbackMetric {
  modelId: string;
  calls: number;
  errorRate: number;
  fallbackFromCount: number;
}

export interface CandidateRankingResult {
  candidates: ModelProfile[];
  signals: string[];
}

/**
 * V8：读取路由 SQLite 运行指标，在候选排序时降权高错误率/高 fallback 源模型（不改配置、不剔除候选）。
 */
export class RuntimeStatsFeedback {
  private cache: { at: number; metrics: Map<string, ModelFeedbackMetric> } | null = null;

  constructor(
    private readonly db?: DatabaseSync,
    private readonly options: RuntimeStatsFeedbackOptions = {},
  ) {}

  rankCandidates(candidates: ModelProfile[], _taskType?: TaskType): CandidateRankingResult {
    if (candidates.length <= 1 || !this.db) {
      return { candidates, signals: [] };
    }

    const metrics = this.loadMetrics();
    if (metrics.size === 0) {
      return { candidates, signals: [] };
    }

    const minCalls = this.options.minCallsForPenalty ?? MIN_CALLS_FOR_PENALTY;
    const errorThreshold =
      this.options.errorRatePenaltyThreshold ?? ERROR_RATE_PENALTY_THRESHOLD;

    const scored = candidates.map((profile, index) => ({
      profile,
      index,
      penalty: this.scoreProfile(profile, metrics, minCalls, errorThreshold),
    }));

    const reordered = [...scored].sort((a, b) => {
      if (a.penalty !== b.penalty) return a.penalty - b.penalty;
      return a.index - b.index;
    });

    const signals: string[] = [];
    const firstBefore = scored[0]!.profile.id;
    const firstAfter = reordered[0]!.profile.id;
    if (firstBefore !== firstAfter) {
      const demoted = scored.find((s) => s.profile.id === firstBefore);
      if (demoted && demoted.penalty > 0) {
        const metric = metrics.get(firstBefore);
        signals.push(
          `deprioritize:${firstBefore}(penalty=${demoted.penalty}${metric ? `,errorRate=${metric.errorRate.toFixed(2)}` : ""})`,
        );
      }
    }

    for (const entry of reordered) {
      if (entry.penalty > 0 && entry.profile.id !== firstAfter) {
        const metric = metrics.get(entry.profile.id);
        if (metric && metric.calls >= minCalls) {
          signals.push(`penalty:${entry.profile.id}=${entry.penalty}`);
        }
      }
    }

    return {
      candidates: reordered.map((s) => s.profile),
      signals: [...new Set(signals)],
    };
  }

  private scoreProfile(
    profile: ModelProfile,
    metrics: Map<string, ModelFeedbackMetric>,
    minCalls: number,
    errorThreshold: number,
  ): number {
    const metric = metrics.get(profile.id);
    if (!metric || metric.calls < minCalls) return 0;

    let penalty = 0;
    if (metric.errorRate >= errorThreshold) {
      penalty += 100 + Math.round(metric.errorRate * 50);
    }
    if (metric.fallbackFromCount >= FALLBACK_FROM_PENALTY_MIN) {
      penalty += 30 + metric.fallbackFromCount * 5;
    }
    return penalty;
  }

  private loadMetrics(): Map<string, ModelFeedbackMetric> {
    if (!this.db) return new Map();

    const ttl = this.options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    const now = Date.now();
    if (this.cache && now - this.cache.at < ttl) {
      return this.cache.metrics;
    }

    const rows = this.db
      .prepare(
        `SELECT model_id,
                COUNT(*) AS calls,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors
         FROM model_call_logs
         GROUP BY model_id`,
      )
      .all() as Array<{ model_id: string; calls: number; errors: number }>;

    const fallbackFrom = new Map<string, number>();
    for (const row of this.db
      .prepare(
        `SELECT from_model_id AS model_id, COUNT(*) AS cnt FROM fallback_logs GROUP BY from_model_id`,
      )
      .all() as Array<{ model_id: string; cnt: number }>) {
      fallbackFrom.set(row.model_id, Number(row.cnt));
    }

    const metrics = new Map<string, ModelFeedbackMetric>();
    for (const row of rows) {
      const calls = Number(row.calls);
      const errors = Number(row.errors);
      metrics.set(row.model_id, {
        modelId: row.model_id,
        calls,
        errorRate: calls === 0 ? 0 : errors / calls,
        fallbackFromCount: fallbackFrom.get(row.model_id) ?? 0,
      });
    }

    this.cache = { at: now, metrics };
    return metrics;
  }
}

export const noopRuntimeStatsFeedback = new RuntimeStatsFeedback();
