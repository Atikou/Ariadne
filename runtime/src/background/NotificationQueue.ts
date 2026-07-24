import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  AgentNotificationSchema,
  NotificationJournalLineSchema,
  normalizeNotificationPayload,
  type AgentNotification,
  type NotificationConsumeRecord,
  type NotificationJournalLine,
  type NotificationLevel,
  type NotificationPriority,
  type NotificationSource,
} from "./NotificationContracts.js";

export interface EnqueueNotificationInput {
  source: NotificationSource;
  level: NotificationLevel;
  message: string;
  priority?: NotificationPriority;
  taskId?: string;
  runId?: string;
  dedupeKey?: string;
  mergeKey?: string;
  payload?: Record<string, unknown>;
}

/**
 * 线程安全（单进程）通知队列：内存态 + JSONL 持久化。
 * 主 Agent 仅在安全点调用 drain() 消费未读通知。
 *
 * - dedupeKey：同一逻辑事件原地更新（保留 id）
 * - mergeKey：多条不同事件折叠为一条待办（保留 id，payload.mergeCount 递增）
 */
export class NotificationQueue {
  private readonly items = new Map<string, AgentNotification>();
  private readonly consumed = new Set<string>();

  constructor(private readonly journalFile: string) {
    mkdirSync(path.dirname(journalFile), { recursive: true });
    this.replay();
  }

  enqueue(input: EnqueueNotificationInput): AgentNotification {
    if (input.dedupeKey) {
      const existing = this.findPending((n) => n.dedupeKey === input.dedupeKey);
      if (existing) {
        return this.commit(this.mergeInto(existing, input, { incrementMergeCount: false }));
      }
    }

    if (input.mergeKey) {
      const existing = this.findPending((n) => n.mergeKey === input.mergeKey);
      if (existing) {
        return this.commit(this.mergeInto(existing, input, { incrementMergeCount: true }));
      }
    }

    const notification: AgentNotification = {
      id: randomUUID(),
      consumed: false,
      timestamp: new Date().toISOString(),
      priority: input.priority ?? "normal",
      ...input,
      payload: normalizeNotificationPayload(
        input.payload ? { ...input.payload, mergeCount: 1 } : { mergeCount: 1 },
      ),
    };
    return this.commit(notification);
  }

  /** 返回全部未消费通知并标记为已消费（安全点调用）。 */
  drain(): AgentNotification[] {
    return this.consumePending([...this.items.values()].filter((n) => !this.consumed.has(n.id)));
  }

  /**
   * 仅消费属于该 run 的通知（或未绑定 run 的全局通知），避免并发运行互相「偷」掉
   * 对方的 run 级通知导致漏投。runId 缺省时退化为 drain()。
   */
  drainForRun(runId: string | undefined): AgentNotification[] {
    if (!runId) return this.drain();
    return this.consumePending(
      [...this.items.values()].filter(
        (n) => !this.consumed.has(n.id) && (n.runId === runId || n.runId === undefined),
      ),
    );
  }

  private consumePending(candidates: AgentNotification[]): AgentNotification[] {
    const pending = this.sort(candidates);
    if (pending.length === 0) return [];

    const ids = pending.map((n) => n.id);
    for (const id of ids) {
      this.consumed.add(id);
      const item = this.items.get(id);
      if (item) item.consumed = true;
    }

    const record: NotificationConsumeRecord = {
      op: "consume",
      ids,
      time: new Date().toISOString(),
    };
    this.append(record);
    return pending;
  }

  listPending(): AgentNotification[] {
    return this.sort([...this.items.values()].filter((n) => !this.consumed.has(n.id)));
  }

  listAll(): AgentNotification[] {
    return this.sort([...this.items.values()]);
  }

  private findPending(predicate: (n: AgentNotification) => boolean): AgentNotification | undefined {
    return [...this.items.values()].find((n) => !this.consumed.has(n.id) && predicate(n));
  }

  private mergeInto(
    existing: AgentNotification,
    input: EnqueueNotificationInput,
    opts: { incrementMergeCount: boolean },
  ): AgentNotification {
    const prevCount = readMergeCount(existing.payload);
    const mergeCount = opts.incrementMergeCount ? prevCount + 1 : prevCount;
    const mergedMessages = [
      ...readMergedMessages(existing.payload),
      input.message,
    ].slice(-5);

    return {
      ...existing,
      ...input,
      id: existing.id,
      consumed: false,
      timestamp: new Date().toISOString(),
      priority: maxPriority(existing.priority, input.priority),
      message: formatMergedMessage(input.message, mergeCount),
      payload: normalizeNotificationPayload({
        ...(existing.payload ?? {}),
        ...(input.payload ?? {}),
        mergeCount,
        mergedMessages,
        latestMessage: input.message,
      }),
    };
  }

  private commit(notification: AgentNotification): AgentNotification {
    const validated = AgentNotificationSchema.parse(notification);
    this.items.set(validated.id, validated);
    this.append(validated);
    return validated;
  }

  private sort(items: AgentNotification[]): AgentNotification[] {
    return items.sort((a, b) => {
      const byPriority = priorityWeight(b.priority) - priorityWeight(a.priority);
      if (byPriority !== 0) return byPriority;
      return a.timestamp.localeCompare(b.timestamp);
    });
  }

  private replay(): void {
    if (!existsSync(this.journalFile)) return;
    const text = readFileSync(this.journalFile, "utf-8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const result = NotificationJournalLineSchema.safeParse(raw);
      if (!result.success) continue;
      const parsed = result.data;
      if ("op" in parsed && parsed.op === "consume") {
        for (const id of parsed.ids) {
          this.consumed.add(id);
          const item = this.items.get(id);
          if (item) item.consumed = true;
        }
        continue;
      }
      const n = parsed as AgentNotification;
      if (!n.id) continue;
      this.items.set(n.id, { ...n, priority: n.priority ?? "normal", consumed: this.consumed.has(n.id) });
    }
  }

  private append(line: NotificationJournalLine): void {
    const validated = NotificationJournalLineSchema.parse(line);
    appendFileSync(this.journalFile, `${JSON.stringify(validated)}\n`, "utf-8");
  }
}

export function readMergeCount(payload: Record<string, unknown> | undefined): number {
  const n = payload?.mergeCount;
  return typeof n === "number" && n > 0 ? n : 1;
}

export function readMergedMessages(payload: Record<string, unknown> | undefined): string[] {
  const raw = payload?.mergedMessages;
  return Array.isArray(raw) ? raw.filter((m): m is string => typeof m === "string") : [];
}

export function formatMergedMessage(latestMessage: string, mergeCount: number): string {
  if (mergeCount <= 1) return latestMessage;
  return `${latestMessage}（同类通知已合并 ${mergeCount} 条）`;
}

function priorityWeight(priority: NotificationPriority | undefined): number {
  if (priority === "high") return 3;
  if (priority === "low") return 1;
  return 2;
}

function maxPriority(
  a: NotificationPriority | undefined,
  b: NotificationPriority | undefined,
): NotificationPriority {
  return priorityWeight(a) >= priorityWeight(b) ? (a ?? "normal") : (b ?? "normal");
}
