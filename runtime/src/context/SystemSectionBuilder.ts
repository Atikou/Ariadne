import type { FileSnippetItem } from "./fileSnippets.js";
import { isUntrustedCompletionMemoryText, scrubStructuredSummaryContent } from "./contextTrust.js";
import {
  inferMemoryTags,
  inferPlanStepTags,
  inferSummaryTags,
  inferTaskTags,
  inferToolResultTags,
  tagSectionItem,
} from "./contextTags.js";
import type {
  MemoryRecord,
  ProjectRecord,
  RetrievedMemory,
  SemanticHit,
  SummaryRecord,
  SystemSection,
  SystemSectionItem,
  TaskRecord,
  TaskStepRecord,
} from "./types.js";

export interface BuildSystemSectionsInput {
  sessionId: string;
  projectId?: string;
  taskId?: string;
  globalPreferences: MemoryRecord[];
  projectMemories: MemoryRecord[];
  sessionSummary?: SummaryRecord | null;
  chunkSummaries: SummaryRecord[];
  retrievedMemories: RetrievedMemory[];
  semanticHits: SemanticHit[];
  project?: ProjectRecord | null;
  activeTask?: TaskRecord | null;
  planSteps?: TaskStepRecord[];
  fileSnippets?: FileSnippetItem[];
  recentToolSummaries?: string[];
  contextCorrections?: string[];
}

/** 将结构化上下文格式化为可注入模型的 systemSections。 */
export class SystemSectionBuilder {
  build(input: BuildSystemSectionsInput): SystemSection[] {
    const sections: SystemSection[] = [];

    const prefs = dedupeItems(
      input.globalPreferences.map((m) =>
        tagSectionItem(memoryItem(m), "user_preferences", inferMemoryTags(m)),
      ),
      "memory",
    );
    if (prefs.length > 0) {
      sections.push({
        type: "user_preferences",
        title: "用户偏好",
        priority: 100,
        items: prefs,
      });
    }

    if (input.contextCorrections?.length) {
      sections.push({
        type: "context_corrections",
        title: "上下文事实纠偏",
        priority: 98,
        items: input.contextCorrections.map((text, i) => ({
          sourceType: "memory" as const,
          sourceId: `correction-${i}`,
          text,
          tags: ["context_correction", "guard_notice"],
        })),
      });
    }

    const summaryItems = buildSummaryItems(input.sessionSummary, input.chunkSummaries);
    if (summaryItems.length > 0) {
      sections.push({
        type: "session_summary",
        title: "历史摘要",
        priority: 90,
        items: summaryItems,
      });
    }

    if (input.activeTask) {
      const taskText = input.activeTask.summary
        ? `${input.activeTask.goal}（${input.activeTask.status}）— ${input.activeTask.summary}`
        : `${input.activeTask.goal}（${input.activeTask.status}）`;
      sections.push({
        type: "task_state",
        title: "当前任务",
        priority: 85,
        items: [
          tagSectionItem(
            { sourceType: "task", sourceId: input.activeTask.id, text: taskText },
            "task_state",
            inferTaskTags(input.activeTask.status),
          ),
        ],
      });
    }

    if (input.planSteps?.length) {
      const planItems = input.planSteps.map((step) =>
        tagSectionItem(
          {
            sourceType: "task" as const,
            sourceId: step.stepId,
            text: formatPlanStepLine(step),
          },
          "current_plan",
          inferPlanStepTags(step.status),
        ),
      );
      sections.push({
        type: "current_plan",
        title: "当前计划",
        priority: 84,
        items: planItems,
      });
    }

    const projectItems = buildProjectItems(input.project, input.projectMemories);
    if (projectItems.length > 0) {
      sections.push({
        type: "project_context",
        title: "当前项目",
        priority: 80,
        items: projectItems,
      });
    }

    const shownMemoryIds = new Set([
      ...input.globalPreferences.map((m) => m.id),
      ...input.projectMemories.map((m) => m.id),
    ]);
    const memoryItems = dedupeItems(
      input.retrievedMemories
        .filter(
          (r) =>
            !shownMemoryIds.has(r.memory.id) &&
            r.reason !== "fixed_preference" &&
            r.reason !== "project_context" &&
            r.reason !== "task_context",
        )
        .map((r) =>
          tagSectionItem(
            {
              sourceType: "memory" as const,
              sourceId: r.memory.id,
              text: r.memory.summary ?? r.memory.value,
              score: r.score,
            },
            "relevant_memories",
            inferMemoryTags(r.memory),
          ),
        ),
      "memory",
    );
    if (memoryItems.length > 0) {
      sections.push({
        type: "relevant_memories",
        title: "相关长期记忆",
        priority: 70,
        items: memoryItems,
      });
    }

    const semanticItems = dedupeItems(
      input.semanticHits.map((h) =>
        tagSectionItem(
          {
            sourceType: "semantic" as const,
            sourceId: h.item.sourceId,
            text: h.item.summary ?? (h.item.content ?? "").slice(0, 300),
            score: h.score,
          },
          "semantic_results",
          h.item.tags,
        ),
      ),
      "semantic",
    );
    if (semanticItems.length > 0) {
      sections.push({
        type: "semantic_results",
        title: "相关检索结果",
        priority: 60,
        items: semanticItems,
      });
    }

    if (input.fileSnippets?.length) {
      sections.push({
        type: "file_snippets",
        title: "文件与代码片段",
        priority: 52,
        items: input.fileSnippets.map((s) =>
          tagSectionItem(
            {
              sourceType: "file" as const,
              sourceId: s.messageId,
              text: `${s.path}（${s.tool}）\n${s.preview}`,
            },
            "file_snippets",
            s.tags,
          ),
        ),
      });
    }

    if (input.recentToolSummaries?.length) {
      sections.push({
        type: "recent_tool_results",
        title: "最近工具结果",
        priority: 50,
        items: input.recentToolSummaries.map((text, i) => {
          const tool = text.split(":")[0]?.trim() ?? "tool";
          return tagSectionItem(
            {
              sourceType: "tool" as const,
              sourceId: `recent-tool-${i}`,
              text,
            },
            "recent_tool_results",
            inferToolResultTags(tool),
          );
        }),
      });
    }

    sections.push({
      type: "response_rules",
      title: "回复约束",
      priority: 10,
      items: [
        {
          sourceType: "tool",
          text: "优先依据上述摘要与记忆回答；不确定时说明依据不足，勿编造未出现的偏好或项目事实。",
        },
      ],
    });

    return sections.sort((a, b) => b.priority - a.priority);
  }
}

function memoryItem(m: MemoryRecord): SystemSectionItem {
  return {
    sourceType: "memory",
    sourceId: m.id,
    text: m.summary ?? m.value,
    score: m.importance,
    tags: inferMemoryTags(m),
  };
}

function buildSummaryItems(
  sessionSummary: SummaryRecord | null | undefined,
  chunkSummaries: SummaryRecord[],
): SystemSectionItem[] {
  const items: SystemSectionItem[] = [];
  if (sessionSummary) {
    const scrubbed = scrubStructuredSummaryContent(sessionSummary.content);
    items.push({
      sourceType: "summary",
      sourceId: sessionSummary.id,
      text: formatStructuredSummary(scrubbed),
      tags: inferSummaryTags(sessionSummary.summaryType, scrubbed),
    });
    return items;
  }
  for (const chunk of chunkSummaries.slice(-3)) {
    const scrubbed = scrubStructuredSummaryContent(chunk.content);
    items.push({
      sourceType: "summary",
      sourceId: chunk.id,
      text: formatStructuredSummary(scrubbed),
      tags: inferSummaryTags(chunk.summaryType, scrubbed),
    });
  }
  return items;
}

function buildProjectItems(
  project: ProjectRecord | null | undefined,
  memories: MemoryRecord[],
): SystemSectionItem[] {
  const items: SystemSectionItem[] = [];
  if (project) {
    const parts = [project.name];
    if (project.description) parts.push(project.description);
    if (project.rootPath) parts.push(`根路径：${project.rootPath}`);
    items.push({ sourceType: "project", sourceId: project.id, text: parts.join("；") });
  }
  for (const m of memories) {
    const text = m.summary ?? m.value;
    if (isUntrustedCompletionMemoryText(text)) continue;
    items.push({
      sourceType: "memory",
      sourceId: m.id,
      text: m.summary ?? m.value,
      score: m.importance,
      tags: inferMemoryTags(m),
    });
  }
  return dedupeItems(items, "memory");
}

function formatStructuredSummary(s: SummaryRecord["content"]): string {
  const parts: string[] = [];
  if (s.current_goal) parts.push(`目标：${s.current_goal}`);
  appendJoin(parts, "决策", s.important_decisions);
  appendJoin(parts, "偏好", s.user_preferences);
  appendJoin(parts, "项目状态", s.project_state);
  appendJoin(parts, "待解决", s.open_questions);
  appendJoin(parts, "近期变更", s.recent_changes);
  return parts.join("；") || "（无摘要文本）";
}

function appendJoin(parts: string[], label: string, items?: string[]): void {
  if (items?.length) parts.push(`${label}：${items.join("、")}`);
}

function formatPlanStepLine(step: TaskStepRecord): string {
  const idx = step.position + 1;
  const confirm = step.needsConfirmation ? "需确认" : "";
  const deps = step.dependsOn?.length ? `依赖:${step.dependsOn.join(",")}` : "";
  const prio = step.priority !== 100 ? `P${step.priority}` : "";
  const tail = [step.status, prio, confirm, deps].filter(Boolean).join("；");
  const goal = step.objective ?? step.description ?? "";
  const desc = goal ? ` — ${goal.slice(0, 100)}` : "";
  const artifacts =
    (step.expectedArtifacts?.length ?? 0) > 0
      ? `；产物:${(step.expectedArtifacts ?? []).slice(0, 2).join("、")}`
      : "";
  return `${idx}. ${step.title}（${tail}）${desc}${artifacts}`;
}

function dedupeItems(items: SystemSectionItem[], kind: string): SystemSectionItem[] {
  const seen = new Set<string>();
  const out: SystemSectionItem[] = [];
  for (const item of items) {
    const key = item.sourceId ? `${kind}:${item.sourceId}` : `${kind}:${item.text.trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
