import type { MessageStore, SummaryStore } from "./stores.js";
import { isUntrustedCompletionMemoryText, scrubStructuredSummaryContent } from "./contextTrust.js";
import type { MessageRecord, StructuredSummary, SummarizeFn, SummaryRecord } from "./types.js";

export interface SummaryManagerOptions {
  messageThreshold?: number;
  chunkBatchSize?: number;
  summarize?: SummarizeFn;
}

/** 历史摘要：超过阈值时将旧消息压缩为 chunk_summary。 */
export class SummaryManager {
  private readonly threshold: number;
  private readonly batchSize: number;
  private readonly summarize: SummarizeFn;

  constructor(
    private readonly messages: MessageStore,
    private readonly summaries: SummaryStore,
    options: SummaryManagerOptions = {},
  ) {
    this.threshold = options.messageThreshold ?? 20;
    this.batchSize = options.chunkBatchSize ?? 10;
    this.summarize = options.summarize ?? defaultSummarize;
  }

  needsCompression(sessionId: string): boolean {
    const endId = this.summaries.lastChunkEndMessageId(sessionId);
    const pending = this.messages.getUnsummarized(sessionId, endId);
    return pending.length > this.threshold;
  }

  async compressIfNeeded(sessionId: string): Promise<SummaryRecord | null> {
    if (!this.needsCompression(sessionId)) return null;
    const endId = this.summaries.lastChunkEndMessageId(sessionId);
    const pending = this.messages.getUnsummarized(sessionId, endId);
    const batch = pending.slice(0, this.batchSize);
    if (batch.length === 0) return null;

    const content = await this.summarize(batch);
    const record = this.summaries.save({
      sessionId,
      summaryType: "chunk_summary",
      content,
      startMessageId: batch[0]!.id,
      endMessageId: batch[batch.length - 1]!.id,
    });
    this.messages.markSummarized(
      batch.map((m) => m.id),
      record.id,
    );

    const remaining = this.messages.getUnsummarized(sessionId, record.endMessageId);
    if (remaining.length > this.threshold) {
      return this.compressIfNeeded(sessionId);
    }
    return record;
  }

  ensureSessionSummary(sessionId: string): SummaryRecord | null {
    const existing = this.summaries.latestByType(sessionId, "session_summary");
    const chunks = this.summaries
      .listBySession(sessionId)
      .filter((s) => s.summaryType === "chunk_summary");
    if (chunks.length === 0) return existing;

    const merged: StructuredSummary = scrubStructuredSummaryContent({
      current_goal: chunks[chunks.length - 1]?.content.current_goal,
      important_decisions: unique(
        chunks.flatMap((c) => scrubStructuredSummaryContent(c.content).important_decisions ?? []),
      ),
      user_preferences: unique(chunks.flatMap((c) => c.content.user_preferences ?? [])),
      project_state: unique(
        chunks.flatMap((c) => scrubStructuredSummaryContent(c.content).project_state ?? []),
      ),
      open_questions: unique(chunks.flatMap((c) => c.content.open_questions ?? [])),
      recent_changes: unique(
        chunks.flatMap((c) => scrubStructuredSummaryContent(c.content).recent_changes ?? []),
      ),
      important_files: unique(chunks.flatMap((c) => c.content.important_files ?? [])),
      tool_results: unique(chunks.flatMap((c) => c.content.tool_results ?? []).slice(-5)),
      errors_seen: unique(chunks.flatMap((c) => c.content.errors_seen ?? []).slice(-5)),
    });

    return this.summaries.save({
      sessionId,
      summaryType: "session_summary",
      content: merged,
      endMessageId: chunks[chunks.length - 1]?.endMessageId,
    });
  }
}

async function defaultSummarize(messages: MessageRecord[]): Promise<StructuredSummary> {
  const userLines = messages.filter((m) => m.role === "user").map((m) => m.content.slice(0, 200));
  const assistantLines = messages
    .filter((m) => {
      if (m.role !== "assistant") return false;
      return (
        m.trusted === true &&
        (m.messageKind === "final_answer" || m.messageKind === "conversational_reply")
      );
    })
    .map((m) => m.content.slice(0, 200))
    .filter((line) => !isUntrustedCompletionMemoryText(line));
  const toolLines = messages
    .filter((m) => m.role === "tool" && m.trusted === true && m.ledgerBacked === true)
    .map((m) => m.content.slice(0, 160));

  return {
    current_goal: userLines[0] ?? "（无明确目标）",
    important_decisions: assistantLines.slice(0, 3),
    user_preferences: [],
    project_state: [],
    open_questions: [],
    recent_changes: userLines.slice(-3),
    important_files: extractFiles(messages),
    tool_results: toolLines.slice(-3),
    errors_seen: messages
      .filter((m) => /失败|error|错误/i.test(m.content))
      .map((m) => m.content.slice(0, 120))
      .slice(-3),
  };
}

function extractFiles(messages: MessageRecord[]): string[] {
  const found = new Set<string>();
  for (const m of messages) {
    const matches = m.content.match(/[\w./\\-]+\.(ts|tsx|js|json|md)/gi) ?? [];
    for (const f of matches) found.add(f);
  }
  return [...found].slice(0, 10);
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}
