import type {
  CollaborationRunRow,
  FallbackLogRow,
  ModelCallLogRow,
  RouteLogRow,
} from "./route-stores.js";

export type PipelineGraphNodeKind =
  | "entry"
  | "rule"
  | "decision"
  | "strategy"
  | "model"
  | "collaboration"
  | "fallback";

export interface PipelineGraphNode {
  id: string;
  kind: PipelineGraphNodeKind;
  label: string;
  meta?: Record<string, unknown>;
}

export interface PipelineGraphEdge {
  from: string;
  to: string;
  label?: string;
}

export interface PipelineGraph {
  nodes: PipelineGraphNode[];
  edges: PipelineGraphEdge[];
  mermaid: string;
}

export function buildPipelineGraph(input: {
  route: RouteLogRow;
  calls: ModelCallLogRow[];
  collaborations: CollaborationRunRow[];
  fallbacks: FallbackLogRow[];
}): PipelineGraph {
  const nodes: PipelineGraphNode[] = [];
  const edges: PipelineGraphEdge[] = [];
  const { route, calls, collaborations, fallbacks } = input;

  const push = (node: PipelineGraphNode) => {
    if (!nodes.some((n) => n.id === node.id)) nodes.push(node);
  };
  const link = (from: string, to: string, label?: string) => {
    edges.push({ from, to, label });
  };

  push({ id: "user", kind: "entry", label: "用户输入" });
  push({
    id: "rule",
    kind: "rule",
    label: `RuleRouter · ${route.taskType}`,
    meta: { taskType: route.taskType, risk: route.risk },
  });
  link("user", "rule");

  push({
    id: "decision",
    kind: "decision",
    label: `DecisionEngine · ${route.source}`,
    meta: { source: route.source, level: route.selectedLevel },
  });
  link("rule", "decision");

  push({
    id: "strategy",
    kind: "strategy",
    label: route.executionStrategy,
    meta: { strategy: route.executionStrategy, reason: route.reason },
  });
  link("decision", "strategy");

  if (route.executionStrategy === "parallel_vote") {
    const voteIds = [route.draftModelId, route.finalModelId].filter(Boolean) as string[];
    for (const modelId of voteIds) {
      const nodeId = `vote:${modelId}`;
      push({ id: nodeId, kind: "model", label: `投票 ${modelId}`, meta: { role: "vote" } });
      link("strategy", nodeId, "parallel");
    }
    if (route.reviewModelId) {
      const judgeId = `judge:${route.reviewModelId}`;
      push({
        id: judgeId,
        kind: "model",
        label: `裁决 ${route.reviewModelId}`,
        meta: { role: "judge" },
      });
      for (const modelId of voteIds) {
        link(`vote:${modelId}`, judgeId);
      }
    }
  } else if (route.executionStrategy === "local_draft_remote_review") {
    if (route.draftModelId) {
      push({
        id: `draft:${route.draftModelId}`,
        kind: "model",
        label: `草稿 ${route.draftModelId}`,
        meta: { role: "draft" },
      });
      link("strategy", `draft:${route.draftModelId}`);
    }
    if (route.reviewModelId) {
      push({
        id: `review:${route.reviewModelId}`,
        kind: "model",
        label: `审查 ${route.reviewModelId}`,
        meta: { role: "review" },
      });
      if (route.draftModelId) link(`draft:${route.draftModelId}`, `review:${route.reviewModelId}`);
      else link("strategy", `review:${route.reviewModelId}`);
    }
  } else if (route.selectedModelId) {
    push({
      id: `model:${route.selectedModelId}`,
      kind: "model",
      label: route.selectedModelId,
      meta: { role: "primary" },
    });
    link("strategy", `model:${route.selectedModelId}`);
  }

  for (const collab of collaborations) {
    const cid = `collab:${collab.id}`;
    push({
      id: cid,
      kind: "collaboration",
      label: `${collab.strategy} · ${collab.status}`,
      meta: {
        ...(collab.verdict == null ? {} : { verdict: collab.verdict }),
        ...(collab.confidence == null ? {} : { confidence: collab.confidence }),
      },
    });
    link("strategy", cid);
  }

  for (const call of calls) {
    const mid = `call:${call.modelId}:${call.role}`;
    push({
      id: mid,
      kind: "model",
      label: `${call.role} ${call.modelId}`,
      meta: { status: call.status, callLogId: call.id },
    });
    link("strategy", mid, call.role);
  }

  for (const fb of fallbacks) {
    const fid = `fallback:${fb.id}`;
    push({
      id: fid,
      kind: "fallback",
      label: `${fb.fromStrategy} → ${fb.toStrategy}`,
      meta: { trigger: fb.triggerType, reason: fb.reason },
    });
    link("strategy", fid, fb.triggerType);
    if (fb.toModelId) {
      const toId = `model:${fb.toModelId}`;
      push({ id: toId, kind: "model", label: fb.toModelId, meta: { role: "fallback_target" } });
      link(fid, toId);
    }
  }

  return { nodes, edges, mermaid: toMermaid(nodes, edges) };
}

function toMermaid(nodes: PipelineGraphNode[], edges: PipelineGraphEdge[]): string {
  const lines = ["flowchart LR"];
  for (const n of nodes) {
    const shape =
      n.kind === "strategy"
        ? `{{${escapeMermaid(n.label)}}}`
        : n.kind === "fallback"
          ? `([${escapeMermaid(n.label)}])`
          : `[${escapeMermaid(n.label)}]`;
    lines.push(`  ${sanitizeId(n.id)}${shape}`);
  }
  for (const e of edges) {
    const label = e.label ? `|${escapeMermaid(e.label)}|` : "";
    lines.push(`  ${sanitizeId(e.from)} -->${label} ${sanitizeId(e.to)}`);
  }
  return lines.join("\n");
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, "_");
}

function escapeMermaid(text: string): string {
  return text.replace(/"/g, "'").replace(/\[/g, "(").replace(/\]/g, ")");
}
