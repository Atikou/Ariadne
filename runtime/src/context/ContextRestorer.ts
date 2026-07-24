import { extractFileSnippetsFromToolMessages } from "./fileSnippets.js";
import { flattenTaggedFragments } from "./contextTags.js";
import {
  buildContextCorrections,
  evaluateContextMessageTrust,
  toContextCorrectionMessage,
} from "./contextTrust.js";
import type { MemoryManager } from "./MemoryManager.js";
import type { MemoryRetriever } from "./MemoryRetriever.js";
import type { SemanticRetriever } from "./SemanticRetriever.js";
import type { RunFactsLookup } from "./runFactsLookup.js";
import type { SystemSectionBuilder } from "./SystemSectionBuilder.js";
import type { MessageStore, ProjectStore, SessionStore, SummaryStore, TaskStore } from "./stores.js";
import type { ContextMessage, ContextPackage, ContextTrustExcludedMessage, RestoreContextInput } from "./types.js";

export interface ContextRestorerOptions {
  recentMessageCount?: number;
}

/**
 * 收集上下文数据并返回 ContextPackage；不写死 system 文本。
 * 历史消息经 contextTrust 过滤，虚假完成注入纠偏摘要。
 */
export class ContextRestorer {
  private readonly recentCount: number;

  constructor(
    private readonly sessions: SessionStore,
    private readonly messages: MessageStore,
    private readonly summaries: SummaryStore,
    private readonly projects: ProjectStore,
    private readonly tasks: TaskStore,
    private readonly memoryRetriever: MemoryRetriever,
    private readonly semanticRetriever: SemanticRetriever,
    private readonly sectionBuilder: SystemSectionBuilder,
    private readonly memoryManager: MemoryManager,
    private readonly runFactsLookup: RunFactsLookup,
    options: ContextRestorerOptions = {},
  ) {
    this.recentCount = options.recentMessageCount ?? 10;
  }

  async restore(input: RestoreContextInput): Promise<ContextPackage> {
    const session = this.sessions.get(input.sessionId);
    const projectId = input.projectId ?? session?.projectId;
    const taskId = input.taskId ?? session?.activeTaskId;

    const sessionSummary = this.summaries.latestByType(input.sessionId, "session_summary");
    const chunkSummaries = this.summaries
      .listBySession(input.sessionId)
      .filter((s) => s.summaryType === "chunk_summary")
      .slice(-3);

    const recent = this.messages.getRecentUnsummarized(input.sessionId, this.recentCount);
    const excluded: Array<{
      message: (typeof recent)[number];
      decision: ReturnType<typeof evaluateContextMessageTrust>;
    }> = [];
    const chatMessages: ContextMessage[] = [];
    const trustExcluded: ContextTrustExcludedMessage[] = [];
    let includedFromHistory = 0;

    for (const m of recent) {
      const decision = evaluateContextMessageTrust(m, this.runFactsLookup);
      if (decision.include) {
        includedFromHistory += 1;
        chatMessages.push({
          id: m.id,
          role: normalizeMessageRole(m.role),
          content: m.content,
          createdAt: m.createdAt,
          messageKind: decision.envelope.messageKind,
          uiVisible: decision.envelope.uiVisible,
          contentEnvelope: decision.envelope.contentEnvelope,
          runId: decision.envelope.runId ?? m.runId,
          toolName: m.toolName,
          toolCallId: m.toolCallId,
          toolCalls: m.toolCalls,
        });
      } else {
        excluded.push({ message: m, decision });
        trustExcluded.push({
          messageId: m.id,
          role: m.role,
          reason: decision.reason,
          preview: previewMessage(m.content),
        });
      }
    }

    const correctionTexts = buildContextCorrections(
      excluded.map((e) => ({ message: e.message, decision: e.decision })),
    );
    for (let i = 0; i < correctionTexts.length; i += 1) {
      const correction = toContextCorrectionMessage(correctionTexts[i]!, i);
      chatMessages.push({
        id: correction.id,
        role: "system",
        content: correction.content,
        createdAt: correction.createdAt,
        messageKind: correction.messageKind,
        uiVisible: correction.uiVisible,
        contentEnvelope: correction.contentEnvelope,
        runId: correction.runId,
      });
    }

    const userInput = input.userInput ?? "";
    const retrievedMemories = userInput
      ? await this.memoryRetriever.retrieve({
          userInput,
          sessionId: input.sessionId,
          projectId,
          taskId,
        })
      : [];

    const semanticHits = userInput
      ? await this.semanticRetriever.search({
          query: userInput,
          sessionId: input.sessionId,
          projectId,
          taskId,
        })
      : [];

    const project = projectId ? this.projects.get(projectId) : null;
    const activeTask = taskId
      ? this.tasks.get(taskId)
      : this.tasks.getActiveForSession(input.sessionId);
    const planSteps = activeTask ? this.tasks.listSteps(activeTask.id) : [];
    const globalPreferences = this.memoryManager.listGlobalPreferences(10);
    const projectMemories = projectId
      ? this.memoryManager.listProjectMemories(projectId, 10)
      : [];
    const recentToolsRaw = this.messages.listRecentByRole(input.sessionId, "tool", 8);
    const recentTools = recentToolsRaw.filter(
      (m) => evaluateContextMessageTrust(m, this.runFactsLookup).include,
    );
    const fileSnippets = extractFileSnippetsFromToolMessages(recentTools);
    const recentToolSummaries = summarizeToolMessages(recentTools);

    const systemSections = this.sectionBuilder.build({
      sessionId: input.sessionId,
      projectId,
      taskId,
      globalPreferences,
      projectMemories,
      sessionSummary,
      chunkSummaries,
      retrievedMemories,
      semanticHits,
      project,
      activeTask,
      planSteps,
      fileSnippets,
      recentToolSummaries,
      contextCorrections: correctionTexts,
    });

    return {
      sessionId: input.sessionId,
      projectId,
      taskId,
      systemSections,
      taggedFragments: flattenTaggedFragments(systemSections),
      messages: chatMessages,
      summaries: sessionSummary ? [sessionSummary, ...chunkSummaries] : chunkSummaries,
      memories: retrievedMemories,
      semanticHits,
      projectContext: project ?? undefined,
      activeTask: activeTask ?? undefined,
      contextTrust: {
        includedCount: includedFromHistory,
        excludedCount: trustExcluded.length,
        excluded: trustExcluded,
        corrections: correctionTexts,
      },
    };
  }
}

function previewMessage(content: string | null | undefined): string {
  const trimmed = (content ?? "").trim();
  if (trimmed.length <= 120) return trimmed;
  return `${trimmed.slice(0, 120)}…`;
}

function normalizeMessageRole(role: string): ContextMessage["role"] {
  if (role === "assistant") return "assistant";
  if (role === "tool") return "tool";
  if (role === "system") return "system";
  return "user";
}

function summarizeToolMessages(messages: Array<{ id: string; content: string }>): string[] {
  return messages.map((m) => {
    const match = m.content.match(/^工具「([^」]+)」/);
    const tool = match?.[1] ?? "tool";
    const body = m.content.replace(/^工具「[^」]+」[^:\n]*[：:]?\n?/, "").trim();
    const preview = body.length > 180 ? `${body.slice(0, 180)}…` : body;
    return `${tool}: ${preview}`;
  });
}
