import { useEffect, useMemo, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import {
  CheckCircle2,
  CircleDot,
  FileDiff,
  LoaderCircle,
  TerminalSquare,
  XCircle,
} from 'lucide-react';
import type {
  RunActivityDetail,
  RunActivityGraph,
  RunActivityNode,
  RunSummary,
} from '@ariadne/protocol/public';

import type { FeaturePanelProps } from '@renderer/core/modules/module-contract';
import {
  activityDetailKey,
  useRuntimeSnapshot,
} from '@renderer/core/runtime/runtime-store';
import { formatRunStatus } from '@renderer/core/runtime/runtime-labels';

import '@xyflow/react/dist/style.css';

interface ActivityNodeData extends Record<string, unknown> {
  activity: RunActivityNode;
}

const nodeTypes = { activity: ActivityGraphNode };

export function SessionActivityPanel({
  moduleId,
  services,
}: FeaturePanelProps): React.JSX.Element {
  const runtime = useRuntimeSnapshot(services.runtime);
  const sessionRuns = runtime.runs.filter(
    (run) => run.sessionId === runtime.selectedSessionId,
  );
  const [selectedRunId, setSelectedRunId] = useState<string | null>(
    sessionRuns.at(-1)?.runId ?? null,
  );
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null);
  const [loadingGraph, setLoadingGraph] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!sessionRuns.some((run) => run.timing.activeSince)) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [sessionRuns]);

  useEffect(() => services.events.subscribe(
    'session-activity:select-run',
    ({ runId, activityId }) => {
      setSelectedRunId(runId);
      setSelectedActivityId(activityId ?? null);
    },
  ), [services]);

  useEffect(() => {
    if (selectedRunId && sessionRuns.some((run) => run.runId === selectedRunId)) return;
    setSelectedRunId(sessionRuns.at(-1)?.runId ?? null);
  }, [selectedRunId, sessionRuns]);

  useEffect(() => {
    if (!selectedRunId) return;
    setLoadingGraph(true);
    setLoadError(null);
    void services.runtime.loadRunActivityGraph(selectedRunId)
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setLoadingGraph(false));
  }, [selectedRunId, services.runtime]);

  const graph = selectedRunId
    ? runtime.activityGraphs[selectedRunId]
    : undefined;
  const selectedDetail = selectedRunId && selectedActivityId
    ? runtime.activityDetails[activityDetailKey(selectedRunId, selectedActivityId)]
    : undefined;

  useEffect(() => {
    if (!selectedRunId || !selectedActivityId) return;
    const node = graph?.nodes.find((candidate) => candidate.activityId === selectedActivityId);
    if (!node?.detailAvailable || selectedDetail) return;
    void services.runtime
      .loadRunActivityDetail(selectedRunId, selectedActivityId)
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : String(error));
      });
  }, [
    graph,
    selectedActivityId,
    selectedDetail,
    selectedRunId,
    services.runtime,
  ]);

  const flow = useMemo(() => graphLayout(graph), [graph]);

  return (
    <section className="session-activity-panel" aria-labelledby={`${moduleId}-title`}>
      <header className="session-activity-header">
        <div>
          <span>SESSION ACTIVITY</span>
          <h1 id={`${moduleId}-title`}>会话活动</h1>
        </div>
        <div className="session-activity-runs" aria-label="本会话运行">
          {sessionRuns.map((run, index) => (
            <button
              type="button"
              key={run.runId}
              className={run.runId === selectedRunId ? 'is-active' : ''}
              onClick={() => {
                setSelectedRunId(run.runId);
                setSelectedActivityId(null);
              }}
            >
              <span>#{index + 1}</span>
              <strong>{formatRunStatus(run.status)}</strong>
              <small>{formatDuration(activeRunDuration(run, now))}</small>
            </button>
          ))}
        </div>
      </header>

      <SystemActivityTimeline graph={graph} />

      <div className="session-activity-workspace">
        <div className="session-activity-canvas">
          {loadingGraph && !graph
            ? <div className="activity-empty"><LoaderCircle className="is-spinning" /> 正在加载活动图…</div>
            : graph && graph.nodes.length > 0
              ? (
                  <ReactFlow
                    nodes={flow.nodes}
                    edges={flow.edges}
                    nodeTypes={nodeTypes}
                    fitView
                    minZoom={0.35}
                    maxZoom={1.6}
                    onNodeClick={(_, node) => setSelectedActivityId(node.id)}
                    nodesDraggable={false}
                    nodesConnectable={false}
                    elementsSelectable
                  >
                    <Background gap={18} size={1} />
                    <Controls showInteractive={false} />
                  </ReactFlow>
                )
              : <div className="activity-empty"><CircleDot /> 本轮还没有工具调用。</div>}
          {loadError && <div className="activity-load-error">{loadError}</div>}
        </div>
        <ActivityInspector
          node={graph?.nodes.find((node) => node.activityId === selectedActivityId)}
          detail={selectedDetail}
        />
      </div>
    </section>
  );
}

function SystemActivityTimeline({
  graph,
}: {
  graph: RunActivityGraph | undefined;
}): React.JSX.Element | null {
  if (!graph?.systemActivities.length) return null;
  return (
    <div className="system-activity-timeline">
      {graph.systemActivities.map((activity) => (
        <div
          key={activity.activityId}
          className={`system-activity-item system-activity-item--${activity.status}`}
        >
          {activity.status === 'running'
            ? <LoaderCircle className="is-spinning" />
            : activity.status === 'failed'
              ? <XCircle />
              : <CheckCircle2 />}
          <span>{activity.title}</span>
          {activity.durationMs !== undefined && <small>{formatDuration(activity.durationMs)}</small>}
        </div>
      ))}
    </div>
  );
}

function ActivityGraphNode({ data }: NodeProps<Node<ActivityNodeData>>): React.JSX.Element {
  const activity = data.activity;
  return (
    <div className={`activity-graph-node activity-graph-node--${activity.status}`}>
      <Handle type="target" position={Position.Top} />
      <header>
        {activity.status === 'running'
          ? <LoaderCircle className="is-spinning" />
          : activity.status === 'failed'
            ? <XCircle />
            : <CheckCircle2 />}
        <strong>{activity.toolName}</strong>
      </header>
      <p>{activity.summary ?? activity.title}</p>
      <footer>
        <span>{activity.laneId}</span>
        {activity.durationMs !== undefined && <small>{formatDuration(activity.durationMs)}</small>}
      </footer>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

function ActivityInspector({
  node,
  detail,
}: {
  node: RunActivityNode | undefined;
  detail: RunActivityDetail | undefined;
}): React.JSX.Element {
  if (!node) {
    return <aside className="activity-inspector activity-inspector--empty">选择一个工具节点查看详情。</aside>;
  }
  return (
    <aside className="activity-inspector">
      <header>
        <span>NODE INSPECTOR</span>
        <h2>{node.toolName}</h2>
        <p>{node.summary ?? node.title}</p>
      </header>
      {!detail
        ? <div className="activity-inspector-loading"><LoaderCircle className="is-spinning" /> 正在加载详情…</div>
        : (
            <>
              <InspectorSection title="参数">
                <pre>{JSON.stringify(detail.args ?? {}, null, 2)}</pre>
              </InspectorSection>
              {(detail.command || detail.cwd || detail.exitCode !== undefined) && (
                <InspectorSection title="命令">
                  {detail.cwd && <code>cwd: {detail.cwd}</code>}
                  {detail.command && <pre><TerminalSquare size={13} /> {detail.command}</pre>}
                  {detail.exitCode !== undefined && <code>exit: {detail.exitCode}</code>}
                </InspectorSection>
              )}
              {(detail.outputPreview || detail.stdoutPreview || detail.stderrPreview || detail.errorMessage) && (
                <InspectorSection title="输出">
                  {detail.outputPreview && <pre>{detail.outputPreview}</pre>}
                  {detail.stdoutPreview && <pre>{detail.stdoutPreview}</pre>}
                  {detail.stderrPreview && <pre className="is-error">{detail.stderrPreview}</pre>}
                  {detail.errorMessage && <pre className="is-error">{detail.errorMessage}</pre>}
                </InspectorSection>
              )}
              {detail.permissionAudit && (
                <InspectorSection title="权限审计">
                  <pre>{JSON.stringify(detail.permissionAudit, null, 2)}</pre>
                </InspectorSection>
              )}
              {detail.fileChanges.map((change) => (
                <InspectorSection key={change.path} title="文件变更">
                  <div className="activity-file-heading">
                    <FileDiff size={14} />
                    <code>{change.path}</code>
                    <span>+{change.additions} -{change.deletions}</span>
                  </div>
                  {(change.changedStartLine || change.changedEndLine) && (
                    <small>
                      line {change.changedStartLine ?? '?'} - {change.changedEndLine ?? '?'}
                    </small>
                  )}
                  <div className="activity-file-metadata">
                    {change.checkpointId && <code>checkpoint: {change.checkpointId}</code>}
                    {change.beforeHash && <code>before: {change.beforeHash}</code>}
                    {change.afterHash && <code>after: {change.afterHash}</code>}
                    {change.diffHash && <code>diff: {change.diffHash}</code>}
                    <small>{change.evidence === 'authoritative' ? '权威变更记录' : '观察记录'}</small>
                  </div>
                  {change.diff && <pre className="activity-diff">{change.diff}</pre>}
                  {change.diffTruncated && <small>差异已截断 · {change.diffHash ?? '无可用哈希'}</small>}
                </InspectorSection>
              ))}
              {(detail.redacted || detail.outputTruncated) && (
                <p className="activity-detail-notice">
                  {detail.redacted ? '敏感值已脱敏。' : ''}
                  {detail.outputTruncated ? ' 输出已按上限截断。' : ''}
                </p>
              )}
            </>
          )}
    </aside>
  );
}

function InspectorSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return <section className="activity-inspector-section"><h3>{title}</h3>{children}</section>;
}

function graphLayout(graph: RunActivityGraph | undefined): {
  nodes: Array<Node<ActivityNodeData>>;
  edges: Edge[];
} {
  if (!graph) return { nodes: [], edges: [] };
  const layout = new dagre.graphlib.Graph();
  layout.setDefaultEdgeLabel(() => ({}));
  layout.setGraph({
    rankdir: 'TB',
    ranksep: 72,
    nodesep: 36,
    marginx: 30,
    marginy: 30,
  });
  for (const node of graph.nodes) layout.setNode(node.activityId, { width: 220, height: 106 });
  for (const edge of graph.edges) layout.setEdge(edge.sourceActivityId, edge.targetActivityId);
  dagre.layout(layout);
  return {
    nodes: graph.nodes.map((activity) => {
      const position = layout.node(activity.activityId) as { x: number; y: number };
      return {
        id: activity.activityId,
        type: 'activity',
        position: { x: position.x - 110, y: position.y - 53 },
        data: { activity },
        selected: false,
      };
    }),
    edges: graph.edges.map((edge) => ({
      id: edge.edgeId,
      source: edge.sourceActivityId,
      target: edge.targetActivityId,
      type: edge.kind === 'verification' ? 'smoothstep' : 'default',
      animated: edge.kind === 'delegation',
      label: edge.kind === 'sequence' ? undefined : edge.kind,
      className: `activity-edge activity-edge--${edge.kind}`,
    })),
  };
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function activeRunDuration(run: RunSummary, now: number): number {
  return run.timing.activeDurationMs + (run.timing.activeSince
    ? Math.max(0, now - Date.parse(run.timing.activeSince))
    : 0);
}
