import type {
  RunActivity,
  RunActivityEdge,
  RunActivityGraph,
  RunActivityNode,
  RunSummary,
  RunSystemActivity,
} from "@ariadne/protocol/public";

import type {
  ActivityAgentRun,
  ActivityAgentStep,
  ActivitySystemEvent,
  AgentActivityEvent,
} from "../agent/timeline/types.js";

export function projectRunActivityGraph(input: {
  run: ActivityAgentRun;
  sessionId?: string;
  status: RunSummary["status"];
  now?: number;
}): RunActivityGraph {
  const nodes = input.run.steps
    .map((step, index) => projectToolNode(input.run, step, index))
    .filter((node): node is RunActivityNode => Boolean(node));
  const nodeIds = new Set(nodes.map((node) => node.activityId));
  const toolCallIds = new Map(nodes.map((node) => [node.toolCallId, node.activityId]));
  const edges: RunActivityEdge[] = [];
  const edgeKeys = new Set<string>();
  const pushEdge = (
    sourceActivityId: string | undefined,
    targetActivityId: string,
    kind: RunActivityEdge["kind"],
  ) => {
    if (!sourceActivityId || !nodeIds.has(sourceActivityId)) return;
    const edgeId = `${kind}:${sourceActivityId}:${targetActivityId}`;
    if (edgeKeys.has(edgeId)) return;
    edgeKeys.add(edgeId);
    edges.push({
      edgeId,
      runId: input.run.id,
      sourceActivityId,
      targetActivityId,
      kind,
    });
  };

  for (const node of nodes) {
    for (const dependency of node.dependsOnActivityIds) {
      pushEdge(dependency, node.activityId, "sequence");
    }
    const step = input.run.steps.find((candidate) => candidate.id === node.activityId);
    const verifies = step?.metadata?.verifiesToolCallId;
    if (verifies) pushEdge(toolCallIds.get(verifies), node.activityId, "verification");
    pushEdge(node.parentActivityId, node.activityId, "delegation");
  }

  if (input.run.schemaVersion !== 2) {
    for (let index = 1; index < nodes.length; index += 1) {
      pushEdge(nodes[index - 1]?.activityId, nodes[index]!.activityId, "sequence");
    }
  }

  return {
    runId: input.run.id,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    status: input.status,
    timing: projectTiming(input.run, input.now),
    nodes,
    edges,
    systemActivities: (input.run.systemActivities ?? []).map(projectSystemActivity),
    updatedAt: new Date(input.run.updatedAt).toISOString(),
  };
}

export function projectAgentActivityEvent(
  run: ActivityAgentRun,
  event: AgentActivityEvent,
): RunActivity | null {
  if (event.type === "system_activity_changed") {
    return projectSystemActivity(event.activity);
  }
  const stepId = event.type === "step_started"
    ? event.step.id
    : event.type === "step_delta"
      || event.type === "step_completed"
      || event.type === "step_failed"
      || event.type === "step_skipped"
        ? event.stepId
        : undefined;
  if (!stepId) return null;
  const index = run.steps.findIndex((step) => step.id === stepId);
  if (index < 0) return null;
  return projectToolNode(run, run.steps[index]!, index);
}

export function projectTiming(
  run: ActivityAgentRun,
  _now = Date.now(),
): RunActivityGraph["timing"] {
  const activeDurationMs = Math.max(0, run.activeDurationMs ?? legacyDuration(run));
  return {
    activeDurationMs,
    ...(run.activeSince !== undefined
      ? { activeSince: new Date(run.activeSince).toISOString() }
      : {}),
  };
}

function projectToolNode(
  run: ActivityAgentRun,
  step: ActivityAgentStep,
  index: number,
): RunActivityNode | null {
  const toolName = step.metadata?.toolName;
  if (!toolName) return null;
  const toolCallId = step.metadata?.toolCallId ?? `legacy:${step.id}`;
  const startedAtMs = step.startedAt ?? run.createdAt;
  const startedAt = new Date(startedAtMs).toISOString();
  const completedAt = step.endedAt === undefined
    ? undefined
    : new Date(step.endedAt).toISOString();
  return {
    activityType: "tool",
    activityId: step.id,
    runId: run.id,
    toolCallId,
    toolName,
    status: projectStepStatus(step.status),
    title: normalizedToolTitle(step.title, toolName),
    ...(step.content ? { summary: step.content.slice(0, 8_192) } : {}),
    occurredAt: completedAt ?? startedAt,
    startedAt,
    ...(completedAt ? { completedAt } : {}),
    ...(step.endedAt !== undefined
      ? { durationMs: Math.max(0, step.endedAt - startedAtMs) }
      : {}),
    iteration: step.metadata?.iteration ?? index,
    batchId: step.metadata?.batchId ?? `legacy-batch-${index}`,
    laneId: step.metadata?.laneId ?? "main",
    ...(step.metadata?.parentActivityId
      ? { parentActivityId: step.metadata.parentActivityId }
      : {}),
    dependsOnActivityIds: [...new Set(step.metadata?.dependsOnActivityIds ?? [])],
    detailAvailable: run.schemaVersion === 2,
    changedFileCount: new Set(step.metadata?.changedFiles ?? []).size,
  };
}

function projectSystemActivity(activity: ActivitySystemEvent): RunSystemActivity {
  const completedAt = activity.endedAt === undefined
    ? undefined
    : new Date(activity.endedAt).toISOString();
  return {
    activityType: "system",
    activityId: activity.id,
    runId: activity.runId,
    kind: activity.kind,
    status: projectStepStatus(activity.status),
    title: systemActivityTitle(activity),
    ...(activity.summary ? { summary: activity.summary.slice(0, 8_192) } : {}),
    occurredAt: completedAt ?? new Date(activity.startedAt).toISOString(),
    startedAt: new Date(activity.startedAt).toISOString(),
    ...(completedAt ? { completedAt } : {}),
    ...(activity.endedAt !== undefined
      ? { durationMs: Math.max(0, activity.endedAt - activity.startedAt) }
      : {}),
    ...(activity.processedMessages !== undefined
      ? { processedMessages: activity.processedMessages }
      : {}),
    ...(activity.beforeChars !== undefined ? { beforeChars: activity.beforeChars } : {}),
    ...(activity.afterChars !== undefined ? { afterChars: activity.afterChars } : {}),
    ...(activity.summaryType ? { summaryType: activity.summaryType } : {}),
  };
}

function systemActivityTitle(activity: ActivitySystemEvent): string {
  if (activity.kind === "working_context_compaction") {
    if (activity.status === "running") return "正在裁剪模型工作上下文";
    if (activity.status === "failed") return "模型工作上下文裁剪失败";
    return "已裁剪模型工作上下文";
  }
  if (activity.status === "running") return "正在自动压缩上下文";
  if (activity.status === "failed") return "自动压缩上下文失败";
  return "已自动压缩上下文";
}

function projectStepStatus(
  status: ActivityAgentStep["status"],
): RunActivityNode["status"] {
  switch (status) {
    case "pending": return "pending";
    case "running": return "running";
    case "failed": return "failed";
    case "skipped": return "skipped";
    case "success":
    case "warning": return "completed";
  }
}

function normalizedToolTitle(title: string, toolName: string): string {
  const normalized = title.replace(/^正在/u, "").trim();
  return normalized || toolName;
}

function legacyDuration(run: ActivityAgentRun): number {
  const start = run.startedAt ?? run.createdAt;
  const end = run.endedAt ?? run.updatedAt;
  return Math.max(0, end - start);
}
