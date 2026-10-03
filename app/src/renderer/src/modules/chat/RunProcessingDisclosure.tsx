import { useEffect, useId, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileText,
  LoaderCircle,
  TerminalSquare,
  XCircle,
} from 'lucide-react';
import type {
  CompanionMessageReasoning,
  CompanionReasoningSegment,
  RunActivity,
  RunSummary,
} from '@ariadne/protocol/public';
import type { RuntimeRun } from '@renderer/core/runtime/runtime-store';
import type { ToolResultFeatureStore } from '@renderer/core/runtime/features/tool-result-feature-store';

import { MarkdownMessage } from './MarkdownMessage';

export interface RunProcessingDisclosureProps {
  reasoning?: CompanionMessageReasoning | undefined;
  run?: ProcessingRun | undefined;
  activities: RunActivity[];
  messageStatus?: 'streaming' | 'completed' | 'interrupted' | 'failed' | undefined;
  fallbackDurationMs?: number | undefined;
  onOpenActivity?: (() => void) | undefined;
  workspaceId?: string | undefined;
  toolResults?: ToolResultFeatureStore | undefined;
}

type ToolActivity = Extract<RunActivity, { activityType: 'tool' }>;
type SystemActivity = Extract<RunActivity, { activityType: 'system' }>;
type ProcessingRun = RuntimeRun | RunSummary;
type ProcessingItem =
  | { kind: 'narration'; key: string; occurredAt: string; segment: CompanionReasoningSegment }
  | { kind: 'system'; key: string; occurredAt: string; activity: SystemActivity }
  | { kind: 'tools'; key: string; occurredAt: string; activities: ToolActivity[] };

export function RunProcessingDisclosure({
  reasoning,
  run,
  activities,
  messageStatus,
  fallbackDurationMs,
  onOpenActivity,
  workspaceId,
  toolResults,
}: RunProcessingDisclosureProps): React.JSX.Element | null {
  const contentId = useId();
  const open = messageStatus === 'streaming' || isOpenRun(run, reasoning);
  const nowMs = useProcessingClock(open);
  const activelyRunning = run
    ? run.status === 'queued' || run.status === 'running'
    : reasoning?.status === 'streaming';
  const previousOpen = useRef(open);
  const [expanded, setExpanded] = useState(open);

  useEffect(() => {
    if (open) setExpanded(true);
    else if (previousOpen.current) setExpanded(false);
    previousOpen.current = open;
  }, [open]);

  if (!reasoning && !run && activities.length === 0 && fallbackDurationMs === undefined) {
    return null;
  }

  const durationMs = processingDuration({
    run,
    reasoning,
    fallbackDurationMs,
    nowMs,
    active: open,
  });
  const label = processingLabel(run, reasoning, durationMs, open);
  const items = buildProcessingItems(reasoning, activities);
  const hasStructuredNarration = Boolean(reasoning?.segments?.length);

  return (
    <section className={`run-processing-disclosure${open ? ' is-running' : ''}`}>
      <div className="run-processing-heading">
        <button
          type="button"
          className="run-processing-open"
          onClick={onOpenActivity}
          disabled={!run || !onOpenActivity}
        >
          {open
            ? <LoaderCircle className={activelyRunning ? 'is-spinning' : undefined} size={15} />
            : run?.status === 'failed' || run?.status === 'interrupted'
              ? <XCircle size={15} />
              : null}
          <span>{label}</span>
        </button>
        <button
          type="button"
          className="run-processing-toggle"
          aria-label={expanded ? '折叠处理过程' : '展开处理过程'}
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
      </div>
      {expanded && (
        <div
          id={contentId}
          className="run-processing-content"
          aria-live={open ? 'polite' : 'off'}
        >
          {!hasStructuredNarration && reasoning?.content && (
            <MarkdownMessage
              markdown={reasoning.content}
              className="reasoning-markdown"
            />
          )}
          <div className="run-processing-events">
            {items.map((item) => item.kind === 'narration'
              ? (
                  <div key={item.key} className="run-processing-narration">
                    <MarkdownMessage
                      markdown={item.segment.content}
                      className="reasoning-markdown"
                    />
                  </div>
                )
              : item.kind === 'system'
                ? <SystemActivityRow key={item.key} activity={item.activity} />
              : <ToolActivityGroup
                  key={item.key}
                  activities={item.activities}
                  workspaceId={workspaceId}
                  toolResults={toolResults}
                />)}
          </div>
        </div>
      )}
    </section>
  );
}

function SystemActivityRow({ activity }: { activity: SystemActivity }): React.JSX.Element {
  return (
    <div className={`run-processing-event run-processing-event--${activity.status}`}>
      {activity.status === 'running'
        ? <LoaderCircle className="is-spinning" />
        : activity.status === 'failed'
          ? <XCircle />
          : <FileText />}
      <span>{activity.title}</span>
      {activity.durationMs !== undefined && (
        <small>{formatProcessingDuration(activity.durationMs)}</small>
      )}
    </div>
  );
}

function ToolActivityGroup({
  activities,
  workspaceId,
  toolResults,
}: {
  activities: ToolActivity[];
  workspaceId?: string | undefined;
  toolResults?: ToolResultFeatureStore | undefined;
}): React.JSX.Element {
  const running = activities.some((activity) => activity.status === 'running');
  const failed = activities.some((activity) => activity.status === 'failed');
  const durationMs = Math.max(
    ...activities.map((activity) => activity.durationMs ?? 0),
  );
  const label = activities.length > 1
    ? running
      ? `正在运行 ${activities.length} 个工具`
      : failed
        ? `运行 ${activities.length} 个工具时有失败`
        : `运行了 ${activities.length} 个工具`
    : toolActivityLabel(activities[0]!);
  const status = running ? 'running' : failed ? 'failed' : 'completed';
  return <div className={`run-processing-tool-group run-processing-event--${status}`}>
    <div className="run-processing-event run-processing-tool-group-heading">
      {running
        ? <LoaderCircle className="is-spinning" />
        : failed
          ? <XCircle />
          : <TerminalSquare />}
      <span>{label}</span>
      {durationMs > 0 && <small>{formatProcessingDuration(durationMs)}</small>}
    </div>
    <div className="run-processing-tool-items">
      {activities.map((activity) => <ToolActivityRow
        key={activity.activityId}
        activity={activity}
        workspaceId={workspaceId}
        toolResults={toolResults}
      />)}
    </div>
  </div>;
}

function ToolActivityRow({
  activity,
  workspaceId,
  toolResults,
}: {
  activity: ToolActivity;
  workspaceId?: string | undefined;
  toolResults?: ToolResultFeatureStore | undefined;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<Awaited<ReturnType<ToolResultFeatureStore['loadDetail']>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canLoad = Boolean(
    workspaceId
      && toolResults
      && activity.detailAvailable
      && (activity.status === 'completed' || activity.status === 'failed'),
  );

  const toggleDetail = async (): Promise<void> => {
    if (!canLoad || loading) return;
    setExpanded((value) => !value);
    if (detail !== null || expanded) return;
    setLoading(true);
    setError(null);
    try {
      const loaded = await toolResults!.loadDetail(
        activity.runId,
        workspaceId!,
        activity.activityId,
      );
      setDetail(loaded);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取工具结果。');
    } finally {
      setLoading(false);
    }
  };

  const loadMore = async (): Promise<void> => {
    if (!detail || detail.complete || loading || !toolResults || !workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const next = await toolResults.loadDetail(
        activity.runId,
        workspaceId,
        activity.activityId,
        detail.nextCursor,
      );
      if (
        next.digest !== detail.digest
        || next.cursor !== detail.nextCursor
        || next.presentation.kind !== detail.presentation.kind
      ) throw new Error('protected_tool_result_page_drift');
      setDetail({ ...next, content: `${detail.content}${next.content}` });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法继续读取工具结果。');
    } finally {
      setLoading(false);
    }
  };

  return <div className={`run-processing-tool${expanded ? ' is-expanded' : ''}`}>
    <button
      type="button"
      className="run-processing-tool-button"
      onClick={() => { void toggleDetail(); }}
      disabled={!canLoad || loading}
      aria-expanded={expanded}
    >
      {activity.status === 'running'
        ? <LoaderCircle className="is-spinning" />
        : activity.status === 'failed'
          ? <XCircle />
          : <TerminalSquare />}
      <span className="run-processing-tool-copy">
        <strong>{activity.title}</strong>
        <small>{activity.toolName}{activity.summary ? ` · ${activity.summary}` : ''}</small>
      </span>
      {activity.durationMs !== undefined && <small>{formatProcessingDuration(activity.durationMs)}</small>}
      {canLoad && <span className="run-processing-tool-toggle">{expanded ? '收起' : '查看'}</span>}
    </button>
    {expanded && <div className="run-processing-tool-detail" aria-busy={loading}>
      {loading && <span role="status">正在读取工具结果…</span>}
      {error && <span role="alert">{error}</span>}
      {detail && <>
        <div className="run-processing-tool-meta">
          <span>{detail.status === 'failed' ? '失败' : '完成'}</span>
          <span>{formatBytes(detail.totalBytes)}</span>
          {detail.complete ? null : <span>结果仍有后续内容</span>}
        </div>
        <pre>{formatToolDetailContent(detail.content)}</pre>
        {!detail.complete && <button
          type="button"
          className="run-processing-tool-more"
          disabled={loading}
          onClick={() => { void loadMore(); }}
        >{loading ? '正在读取…' : '继续读取结果'}</button>}
      </>}
    </div>}
  </div>;
}

function toolActivityLabel(activity: ToolActivity): string {
  if (activity.status === 'running') return `正在${activity.title}`;
  if (activity.status === 'failed') return `${activity.title}失败`;
  return `已${activity.title}`;
}

function formatToolDetailContent(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content) as unknown, null, 2);
  } catch {
    return content;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function buildProcessingItems(
  reasoning: CompanionMessageReasoning | undefined,
  activities: RunActivity[],
): ProcessingItem[] {
  const items: ProcessingItem[] = (reasoning?.segments ?? []).map((segment) => ({
    kind: 'narration',
    key: `narration:${segment.segmentId}`,
    occurredAt: segment.occurredAt,
    segment,
  }));
  const toolGroups = new Map<string, ToolActivity[]>();
  for (const activity of activities) {
    if (activity.activityType === 'system') {
      items.push({
        kind: 'system',
        key: `system:${activity.activityId}`,
        occurredAt: activity.occurredAt,
        activity,
      });
      continue;
    }
    const groupKey = `${activity.iteration}:${activity.batchId}:${activity.laneId}`;
    const group = toolGroups.get(groupKey) ?? [];
    group.push(activity);
    toolGroups.set(groupKey, group);
  }
  for (const [groupKey, group] of toolGroups) {
    group.sort(compareOccurredAt);
    items.push({
      kind: 'tools',
      key: `tools:${groupKey}`,
      occurredAt: group[0]!.occurredAt,
      activities: group,
    });
  }
  return items.sort(compareOccurredAt);
}

function compareOccurredAt(
  left: { occurredAt: string },
  right: { occurredAt: string },
): number {
  return Date.parse(left.occurredAt) - Date.parse(right.occurredAt);
}

function isOpenRun(
  run: ProcessingRun | undefined,
  reasoning: CompanionMessageReasoning | undefined,
): boolean {
  if (reasoning?.status === 'streaming') return true;
  if (!run) return false;
  return !['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status);
}

function processingDuration(input: {
  run?: ProcessingRun | undefined;
  reasoning?: CompanionMessageReasoning | undefined;
  fallbackDurationMs?: number | undefined;
  nowMs: number;
  active: boolean;
}): number {
  if (input.run) {
    const activeSinceMs = input.run.timing.activeSince
      ? Date.parse(input.run.timing.activeSince)
      : Number.NaN;
    const currentActiveDuration = Number.isFinite(activeSinceMs)
      ? Math.max(0, input.nowMs - activeSinceMs)
      : 0;
    const runDurationMs = input.run.timing.activeDurationMs + currentActiveDuration;
    return input.active || input.fallbackDurationMs === undefined
      ? runDurationMs
      : Math.max(runDurationMs, input.fallbackDurationMs);
  }
  if (input.fallbackDurationMs !== undefined) return input.fallbackDurationMs;
  if (!input.reasoning) return 0;
  if (input.active) {
    const startedAtMs = Date.parse(input.reasoning.startedAt);
    return Number.isFinite(startedAtMs)
      ? Math.max(0, input.nowMs - startedAtMs)
      : input.reasoning.durationMs ?? 0;
  }
  return input.reasoning.durationMs ?? 0;
}

function processingLabel(
  run: ProcessingRun | undefined,
  reasoning: CompanionMessageReasoning | undefined,
  durationMs: number,
  active: boolean,
): string {
  const status: string | undefined = run?.status;
  if (status === 'waiting_permission') return '等待权限确认';
  if (status === 'waiting_decision') return '等待决定';
  if (status === 'waiting_plan_handoff') return '等待计划确认';
  if (status === 'waiting_budget') return '等待追加预算';
  if (status === 'waiting_children') return '等待子任务';
  if (status === 'cancelling') return '正在取消';
  if (status === 'paused') return '处理已暂停';
  const duration = formatProcessingDuration(durationMs);
  if (run?.status === 'failed') return `处理失败 ${duration}`;
  if (run?.status === 'cancelled' || run?.status === 'interrupted') {
    return `处理已中断 ${duration}`;
  }
  if (active || run?.status === 'queued' || run?.status === 'running' || reasoning?.status === 'streaming') {
    return `正在处理 ${duration}`;
  }
  return `已处理 ${duration}`;
}

function useProcessingClock(running: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return undefined;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);

  return nowMs;
}

export function formatProcessingDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
