/**
 * Trace 回放相关的「叶子」常量与类型。
 *
 * 抽到独立文件，使 traceQuery / traceReader / traceCatalog 都从这里取，
 * 打破 traceQuery ↔ traceReader 之间的 value import 控制流环。
 */

/** 审计回放默认包含的事件类型（过滤 model_call 等噪声）。 */
export const REPLAY_EVENT_TYPES = new Set([
  "run_start",
  "run_end",
  "agent_decision",
  "agent_model_turn",
  "run_usage_summary",
  "task_status_change",
  "tool_audit",
  "agent_tool",
  "scheduler_fire",
  "task_step",
  "background_start",
  "background_done",
  "background_trigger_next",
  "subagent_start",
  "subagent_end",
]);

export const TRACE_REPLAY_CATEGORIES = [
  "run",
  "model",
  "tool",
  "agent",
  "task",
  "background",
  "subagent",
  "scheduler",
] as const;

export type TraceReplayCategory = typeof TRACE_REPLAY_CATEGORIES[number];

export const TRACE_CATEGORY_TYPES: Record<TraceReplayCategory, readonly string[]> = {
  run: ["run_start", "run_end"],
  model: ["agent_model_turn", "run_usage_summary"],
  tool: ["agent_tool", "tool_audit"],
  agent: ["agent_decision"],
  task: ["task_step", "task_status_change"],
  background: ["background_start", "background_done", "background_trigger_next"],
  subagent: ["subagent_start", "subagent_end"],
  scheduler: ["scheduler_fire"],
};

export interface TraceQueryFilter {
  runId?: string;
  sessionId?: string;
  taskId?: string;
  toolCallId?: string;
  type?: string;
  types?: string[];
  category?: TraceReplayCategory;
  replayOnly?: boolean;
}
