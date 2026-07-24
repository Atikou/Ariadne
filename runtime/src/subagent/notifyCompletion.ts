import type { NotificationQueue } from "../background/NotificationQueue.js";
import type { SubAgentStatus } from "./types.js";

export function enqueueSubAgentCompletionNotification(
  queue: NotificationQueue,
  input: {
    subAgentId: string;
    goal: string;
    parentTaskId?: string;
    status: SubAgentStatus;
    answer: string;
    error?: string;
  },
): void {
  const level = input.status === "completed" ? "info" : input.status === "cancelled" ? "warn" : "error";
  const message = input.error
    ? `子 Agent ${input.status}：${input.goal.slice(0, 80)} — ${input.error}`
    : `子 Agent ${input.status}：${input.goal.slice(0, 80)} — ${input.answer.slice(0, 200)}`;
  void queue.enqueue({
    source: "subagent",
    level,
    message,
    taskId: input.parentTaskId,
    dedupeKey: `subagent:${input.subAgentId}`,
    payload: { subAgentId: input.subAgentId, status: input.status },
  });
}
