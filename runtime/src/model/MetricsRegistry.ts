import type { ModelLocation } from "./types.js";
import type { ModelCallOutcome } from "./modelCancellation.js";

/** 单次模型调用的指标。 */
export interface CallMetric {
  clientName: string;
  model: string;
  location: ModelLocation;
  success: boolean;
  outcome?: ModelCallOutcome;
  latencyMs: number;
  /** 本次请求消息条数，作为上下文规模的近似。 */
  contextMessages: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  strategy?: string;
  taskType?: string;
  error?: string;
}

/** 按客户端聚合后的统计。 */
export interface ClientStats {
  clientName: string;
  location: ModelLocation;
  calls: number;
  failures: number;
  cancellations: number;
  timeouts: number;
  runtimeCrashes: number;
  failureRate: number;
  avgLatencyMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  lastError?: string;
}

interface MutableStats {
  clientName: string;
  location: ModelLocation;
  calls: number;
  failures: number;
  cancellations: number;
  timeouts: number;
  runtimeCrashes: number;
  latencySum: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  lastError?: string;
}

/**
 * 进程内调用指标聚合：延迟、token、价格、失败率。
 * 同时保留最近若干条原始记录，便于在测试台展示。
 */
export class MetricsRegistry {
  private readonly stats = new Map<string, MutableStats>();
  private readonly recent: CallMetric[] = [];
  private readonly maxRecent: number;

  constructor(maxRecent = 100) {
    this.maxRecent = maxRecent;
  }

  record(metric: CallMetric): void {
    let s = this.stats.get(metric.clientName);
    if (!s) {
      s = {
        clientName: metric.clientName,
        location: metric.location,
        calls: 0,
        failures: 0,
        cancellations: 0,
        timeouts: 0,
        runtimeCrashes: 0,
        latencySum: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      };
      this.stats.set(metric.clientName, s);
    }

    s.calls += 1;
    s.latencySum += metric.latencyMs;
    const outcome = metric.outcome ?? (metric.success ? "completed" : "runtime_crash");
    if (outcome === "cancelled") {
      s.cancellations += 1;
    } else if (!metric.success) {
      s.failures += 1;
      s.lastError = metric.error;
      if (outcome === "timeout") s.timeouts += 1;
      else s.runtimeCrashes += 1;
    }
    s.inputTokens += metric.inputTokens ?? 0;
    s.outputTokens += metric.outputTokens ?? 0;
    s.costUsd += metric.costUsd ?? 0;

    this.recent.push(metric);
    if (this.recent.length > this.maxRecent) this.recent.shift();
  }

  snapshot(): ClientStats[] {
    return [...this.stats.values()].map((s) => ({
      clientName: s.clientName,
      location: s.location,
      calls: s.calls,
      failures: s.failures,
      cancellations: s.cancellations,
      timeouts: s.timeouts,
      runtimeCrashes: s.runtimeCrashes,
      failureRate: s.calls - s.cancellations === 0 ? 0 : s.failures / (s.calls - s.cancellations),
      avgLatencyMs: s.calls === 0 ? 0 : Math.round(s.latencySum / s.calls),
      totalInputTokens: s.inputTokens,
      totalOutputTokens: s.outputTokens,
      totalCostUsd: Number(s.costUsd.toFixed(6)),
      lastError: s.lastError,
    }));
  }

  recentCalls(): CallMetric[] {
    return [...this.recent].reverse();
  }
}
