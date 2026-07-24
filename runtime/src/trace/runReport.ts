import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

import type { FallbackLogRow, RouteLogRow } from "../model-router/route-stores.js";
import { redactValue } from "../util/redact.js";
import { createTraceSegmentReadStream } from "../util/traceSegmentIo.js";
import { resolveFilesForFilter, type TraceCatalog } from "./traceCatalog.js";
import type { TraceEvent } from "./TraceLogger.js";
import type { RunTimelineCategory } from "./traceTimelineTypes.js";

export interface RunUsageReport {
  modelTurns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  toolCalls: number;
  toolFailures: number;
  toolObservationFailures: number;
  toolExecutionErrors: number;
}

export interface RunTimelineEntry {
  time: string;
  category: RunTimelineCategory;
  type: string;
  title: string;
  status?: string;
  detail?: string;
  refs?: Record<string, string | number | boolean | undefined>;
}

export interface RunReport {
  runId: string;
  eventCount: number;
  events: TraceEvent[];
  usage: RunUsageReport;
  timeline: RunTimelineEntry[];
}

export interface EnrichRunTimelineInput {
  sessionId?: string;
  runCreatedAt?: string;
  runUpdatedAt?: string;
  routeLogs?: RouteLogRow[];
  fallbackLogs?: FallbackLogRow[];
}

function accumulateUsage(events: TraceEvent[]): RunUsageReport {
  const usage: RunUsageReport = {
    modelTurns: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    toolCalls: 0,
    toolFailures: 0,
    toolObservationFailures: 0,
    toolExecutionErrors: 0,
  };

  const requestedToolCallIds = new Set<string>();
  const terminalByToolCallId = new Map<
    string,
    { outcomeClass?: string; ok?: boolean; status?: string }
  >();
  let legacyToolAuditCount = 0;

  for (const event of events) {
    const e = event as Record<string, unknown>;
    if (e.type === "agent_model_turn") {
      usage.modelTurns += 1;
      usage.totalInputTokens += Number(e.inputTokens ?? 0);
      usage.totalOutputTokens += Number(e.outputTokens ?? 0);
      usage.totalCostUsd += Number(e.costUsd ?? 0);
    }
    if (e.type === "agent_tool" && typeof e.toolCallId === "string") {
      requestedToolCallIds.add(e.toolCallId);
    }
    if (e.type === "tool_audit") {
      if (typeof e.toolCallId === "string") {
        terminalByToolCallId.set(e.toolCallId, {
          outcomeClass: typeof e.outcomeClass === "string" ? e.outcomeClass : undefined,
          ok: typeof e.ok === "boolean" ? e.ok : undefined,
          status: typeof e.status === "string" ? e.status : undefined,
        });
      } else {
        legacyToolAuditCount += 1;
        const outcomeClass = typeof e.outcomeClass === "string" ? e.outcomeClass : undefined;
        if (outcomeClass === "observation_failure") {
          usage.toolObservationFailures += 1;
          usage.toolFailures += 1;
        } else if (outcomeClass === "execution_error") {
          usage.toolExecutionErrors += 1;
          usage.toolFailures += 1;
        } else if (e.success === false || e.ok === false || e.status === "error") {
          usage.toolFailures += 1;
        }
      }
    }
    if (e.type === "run_usage_summary") {
      usage.modelTurns = Number(e.modelTurns ?? usage.modelTurns);
      usage.totalInputTokens = Number(e.totalInputTokens ?? usage.totalInputTokens);
      usage.totalOutputTokens = Number(e.totalOutputTokens ?? usage.totalOutputTokens);
      usage.totalCostUsd = Number(e.totalCostUsd ?? usage.totalCostUsd);
      usage.toolCalls = Number(e.toolCalls ?? usage.toolCalls);
      usage.toolFailures = Number(e.toolFailures ?? usage.toolFailures);
      usage.toolObservationFailures = Number(e.toolObservationFailures ?? usage.toolObservationFailures);
      usage.toolExecutionErrors = Number(e.toolExecutionErrors ?? usage.toolExecutionErrors);
    }
  }

  if (requestedToolCallIds.size > 0) {
    usage.toolCalls = requestedToolCallIds.size;
  } else if (terminalByToolCallId.size > 0) {
    usage.toolCalls = terminalByToolCallId.size;
  } else {
    usage.toolCalls = legacyToolAuditCount;
  }

  for (const terminal of terminalByToolCallId.values()) {
    const outcomeClass = terminal.outcomeClass;
    if (outcomeClass === "observation_failure") {
      usage.toolObservationFailures += 1;
      usage.toolFailures += 1;
    } else if (outcomeClass === "execution_error") {
      usage.toolExecutionErrors += 1;
      usage.toolFailures += 1;
    } else if (terminal.ok === false || terminal.status === "error") {
      usage.toolFailures += 1;
    }
  }

  return usage;
}

function eventTime(event: TraceEvent): string {
  const e = event as Record<string, unknown>;
  return typeof e.time === "string" ? e.time : "";
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function workspaceAccessOf(event: Record<string, unknown>):
  | {
      crossWorkspace?: boolean;
      matchedRoot?: string;
      grantId?: string;
      pathRisk?: string;
    }
  | undefined {
  const access = event.workspaceAccess;
  if (!access || typeof access !== "object" || Array.isArray(access)) return undefined;
  const record = access as Record<string, unknown>;
  return {
    crossWorkspace: typeof record.crossWorkspace === "boolean" ? record.crossWorkspace : undefined,
    matchedRoot: str(record.matchedRoot),
    grantId: str(record.grantId),
    pathRisk: str(record.pathRisk),
  };
}

/** 将单条 trace 事件映射为时间线条目。 */
export function mapTraceEventToTimelineEntry(event: TraceEvent): RunTimelineEntry | null {
  const e = event as Record<string, unknown>;
  const type = String(e.type ?? "");
  const time = eventTime(event);
  if (!type) return null;

  if (type === "run_start") {
    return {
      time,
      category: "run",
      type,
      title: `Run 开始 · ${str(e.kind) ?? "unknown"}`,
      status: "started",
      refs: { sessionId: str(e.sessionId), taskId: str(e.taskId) },
    };
  }
  if (type === "run_end") {
    return {
      time,
      category: "run",
      type,
      title: `Run 结束 · ${str(e.kind) ?? "unknown"}`,
      status: str(e.status) ?? "ended",
      detail: str(e.error),
    };
  }
  if (type === "agent_model_turn") {
    const client = str(e.client) ?? str(e.clientName) ?? "-";
    const model = str(e.model) ?? str(e.modelName) ?? "-";
    return {
      time,
      category: "model",
      type,
      title: `模型轮次 #${num(e.iteration) ?? "?"} · ${client}/${model}`,
      status: e.error ? "error" : "ok",
      detail: e.error ? str(e.error) : `tokens ${num(e.inputTokens) ?? 0}/${num(e.outputTokens) ?? 0} · $${num(e.costUsd) ?? 0}`,
      refs: {
        iteration: num(e.iteration),
        latencyMs: num(e.latencyMs),
        toolCallId: str(e.toolCallId),
      },
    };
  }
  if (type === "model_call") {
    return {
      time,
      category: "model",
      type,
      title: `模型调用 · ${str(e.client) ?? "-"}/${str(e.model) ?? "-"}`,
      status: e.success === false ? "error" : "ok",
      detail: str(e.error),
      refs: { routeLogId: str(e.routeLogId), role: str(e.role), latencyMs: num(e.latencyMs) },
    };
  }
  if (type === "run_usage_summary") {
    return {
      time,
      category: "model",
      type,
      title: "运行用量摘要",
      status: "summary",
      detail: `模型 ${num(e.modelTurns) ?? 0} 轮 · 工具 ${num(e.toolCalls) ?? 0} 次 · $${num(e.totalCostUsd) ?? 0}`,
    };
  }
  if (type === "agent_decision") {
    return {
      time,
      category: "agent",
      type,
      title: `Agent 决策 · ${str(e.action) ?? "unknown"}`,
      status: str(e.action),
      detail: str(e.tool) ? `tool=${str(e.tool)}` : str(e.parseError),
      refs: { iteration: num(e.iteration), tool: str(e.tool) },
    };
  }
  if (type === "agent_tool") {
    const access = workspaceAccessOf(e);
    return {
      time,
      category: "tool",
      type,
      title: `${access?.crossWorkspace ? "跨工作区工具" : "Agent 工具"} · ${str(e.tool) ?? "unknown"}`,
      status: "requested",
      detail: access?.crossWorkspace ? `root=${access.matchedRoot ?? "-"}` : undefined,
      refs: {
        iteration: num(e.iteration),
        toolCallId: str(e.toolCallId),
        crossWorkspace: access?.crossWorkspace,
        matchedRoot: access?.matchedRoot,
        grantId: access?.grantId,
        pathRisk: access?.pathRisk,
      },
    };
  }
  if (type === "tool_audit") {
    const outcomeClass = str(e.outcomeClass);
    const outcomeKind = str(e.outcomeKind);
    const access = workspaceAccessOf(e);
    return {
      time,
      category: "tool",
      type,
      title: `${access?.crossWorkspace ? "跨工作区审计" : "工具审计"} · ${str(e.tool) ?? "unknown"}`,
      status: outcomeClass ?? str(e.status) ?? "unknown",
      detail: outcomeKind
        ? `${outcomeKind}${access?.matchedRoot ? ` · root=${access.matchedRoot}` : ""}${str(e.error) ? ` · ${str(e.error)}` : ""}`
        : str(e.error) ?? str(e.code),
      refs: {
        toolCallId: str(e.toolCallId),
        permission: str(e.permission),
        riskTier: str(e.riskTier),
        durationMs: num(e.durationMs),
        outcomeClass,
        outcomeKind,
        crossWorkspace: access?.crossWorkspace,
        matchedRoot: access?.matchedRoot,
        grantId: access?.grantId,
        pathRisk: access?.pathRisk,
      },
    };
  }
  if (type === "path_access_decision") {
    return {
      time,
      category: "tool",
      type,
      title: `${e.crossWorkspace === true ? "跨工作区路径决策" : "路径决策"} · ${str(e.tool) ?? "unknown"}`,
      status: e.allowed === true ? "allowed" : e.needsConfirmation === true ? "permission_required" : "denied",
      detail: `${str(e.reason) ?? "unknown"} · ${str(e.normalizedPath) ?? ""}`,
      refs: {
        toolCallId: str(e.toolCallId),
        operation: str(e.operation),
        matchedRoot: str(e.matchedRoot),
        workspaceScopeId: str(e.workspaceScopeId),
        grantId: str(e.grantId),
        pathRisk: str(e.pathRisk),
        crossWorkspace: e.crossWorkspace === true,
      },
    };
  }
  if (type === "task_step") {
    return {
      time,
      category: "task",
      type,
      title: `任务步骤 · ${str(e.step) ?? "unknown"}`,
      status: str(e.status) ?? "unknown",
      detail: str(e.error),
      refs: { toolCallId: str(e.toolCallId) },
    };
  }
  if (type === "task_status_change") {
    return {
      time,
      category: "task",
      type,
      title: `任务状态 · ${str(e.scope) ?? "task"}`,
      status: `${str(e.from)} → ${str(e.to)}`,
      detail: str(e.stepTitle) ?? str(e.error),
      refs: { stepId: str(e.stepId), taskId: str(e.taskId) },
    };
  }
  if (type === "subagent_start" || type === "subagent_end") {
    return {
      time,
      category: "subagent",
      type,
      title: type === "subagent_start" ? `子 Agent 开始 · ${str(e.role) ?? "-"}` : `子 Agent 结束 · ${str(e.role) ?? "-"}`,
      status: str(e.status) ?? (type === "subagent_start" ? "started" : "ended"),
      detail: str(e.error),
      refs: { subAgentId: str(e.subAgentId), durationMs: num(e.durationMs) },
    };
  }
  if (type === "background_start" || type === "background_done" || type === "background_trigger_next") {
    return {
      time,
      category: "background",
      type,
      title:
        type === "background_start"
          ? "后台任务启动"
          : type === "background_done"
            ? "后台任务结束"
            : "后台触发后续",
      status: str(e.status) ?? type,
      detail: str(e.command) ?? str(e.error),
      refs: { taskId: str(e.taskId) },
    };
  }
  if (type === "scheduler_fire") {
    return {
      time,
      category: "notification",
      type,
      title: `调度触发 · ${str(e.triggerId) ?? "-"}`,
      status: str(e.kind) ?? "fired",
      detail: str(e.goal),
    };
  }

  return {
    time,
    category: "other",
    type,
    title: type,
    status: str(e.status),
  };
}

export function buildRunTimeline(events: TraceEvent[]): RunTimelineEntry[] {
  const entries = events
    .map(mapTraceEventToTimelineEntry)
    .filter((entry): entry is RunTimelineEntry => entry != null);
  return sortTimeline(entries);
}

export function sortTimeline(entries: RunTimelineEntry[]): RunTimelineEntry[] {
  return [...entries].sort((a, b) => {
    if (a.time && b.time) return a.time.localeCompare(b.time);
    if (a.time) return -1;
    if (b.time) return 1;
    return 0;
  });
}

function withinRunWindow(
  ts: string,
  runCreatedAt?: string,
  runUpdatedAt?: string,
): boolean {
  if (!runCreatedAt) return true;
  if (ts < runCreatedAt) return false;
  if (runUpdatedAt && ts > runUpdatedAt) {
    const slack = new Date(runUpdatedAt).getTime() + 60_000;
    return new Date(ts).getTime() <= slack;
  }
  return true;
}

export function enrichRunTimeline(
  base: RunTimelineEntry[],
  input: EnrichRunTimelineInput = {},
): RunTimelineEntry[] {
  const extra: RunTimelineEntry[] = [];

  for (const route of input.routeLogs ?? []) {
    if (!withinRunWindow(route.createdAt, input.runCreatedAt, input.runUpdatedAt)) continue;
    extra.push({
      time: route.createdAt,
      category: "routing",
      type: "route_decision",
      title: `路由决策 · ${route.executionStrategy}`,
      status: route.risk,
      detail: route.reason,
      refs: {
        routeLogId: route.id,
        taskType: route.taskType,
        selectedModelId: route.selectedModelId ?? route.finalModelId,
        fallbackNote: route.fallbackNote,
      },
    });
  }

  for (const fb of input.fallbackLogs ?? []) {
    if (!withinRunWindow(fb.createdAt, input.runCreatedAt, input.runUpdatedAt)) continue;
    extra.push({
      time: fb.createdAt,
      category: "fallback",
      type: "model_fallback",
      title: `模型升级 · ${fb.fromModelId} → ${fb.toModelId}`,
      status: fb.triggerType,
      detail: fb.reason,
      refs: {
        routeLogId: fb.routeLogId,
        fromStrategy: fb.fromStrategy,
        toStrategy: fb.toStrategy,
      },
    });
  }

  return sortTimeline([...base, ...extra]);
}

/** 扫描 trace 文件，收集指定 runId 的事件（上限 maxEvents 条）并构建时间线。 */
export async function buildRunReport(
  traceFileOrDir: string,
  runId: string,
  maxEvents = 500,
  catalog?: TraceCatalog,
): Promise<RunReport | null> {
  const resolvedCatalog = catalog ?? resolveCatalogFromTracePath(traceFileOrDir);
  const files = resolveFilesForFilter(resolvedCatalog, { runId, replayOnly: false });
  const targets = files.length > 0 ? files : existsSync(traceFileOrDir) ? [traceFileOrDir] : [];
  if (targets.length === 0) return null;

  const events: TraceEvent[] = [];

  for (const file of targets) {
    if (!existsSync(file)) continue;
    const rl = createInterface({ input: createTraceSegmentReadStream(file) });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as TraceEvent & { runId?: string };
        if (parsed.runId !== runId) continue;
        events.push(redactValue(parsed));
        if (events.length >= maxEvents) break;
      } catch {
        // skip corrupt line
      }
    }
    if (events.length >= maxEvents) break;
  }

  if (events.length === 0) return null;

  const timeline = buildRunTimeline(events);
  return {
    runId,
    eventCount: events.length,
    events,
    usage: accumulateUsage(events),
    timeline,
  };
}

export interface EnrichRunReportInput {
  sessionId?: string;
  runCreatedAt?: string;
  runUpdatedAt?: string;
  routeLogs?: RouteLogRow[];
  fallbackLogs?: FallbackLogRow[];
}

/** 在 trace 时间线基础上合并路由决策与 fallback 记录。 */
export function enrichRunReport(
  report: RunReport,
  input: EnrichRunReportInput = {},
): RunReport {
  return {
    ...report,
    timeline: enrichRunTimeline(report.timeline, input),
  };
}

function resolveCatalogFromTracePath(traceFileOrDir: string): TraceCatalog {
  const base = path.basename(traceFileOrDir);
  const dir = path.dirname(traceFileOrDir);
  if (base === "trace-current.jsonl") return { tracesDir: path.dirname(dir) };
  if (base === "trace.jsonl") return { tracesDir: dir };
  return { tracesDir: traceFileOrDir };
}
