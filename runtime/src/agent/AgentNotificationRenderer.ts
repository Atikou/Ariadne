import { readMergeCount } from "../background/NotificationQueue.js";
import type { AgentNotification } from "../background/types.js";

/** 将安全点消费的通知格式化为可回灌给模型的系统运行态消息。 */
export function renderNotifications(notes: AgentNotification[]): string {
  const lines = notes.map((n) => {
    const merged = readMergeCount(n.payload);
    const mergeHint = merged > 1 ? ` [合并×${merged}]` : "";
    return `- [${n.source}/${n.level}]${mergeHint} ${n.timestamp}: ${n.message}`;
  });
  return [
    "系统通知（后台任务等，已在安全点注入，请勿打断当前工具链）：",
    ...lines,
    "请酌情纳入下一步推理；若与当前任务无关可忽略。",
  ].join("\n");
}
