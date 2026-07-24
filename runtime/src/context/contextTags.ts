import path from "node:path";

import type {
  MemoryScope,
  MemoryType,
  StructuredSummary,
  SummaryType,
  SystemSectionItem,
  SystemSectionType,
} from "./types.js";

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  md: "markdown",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  html: "html",
  css: "css",
  sql: "sql",
};

/** 合并并去重标签。 */
export function mergeTags(...groups: Array<string[] | undefined>): string[] {
  const set = new Set<string>();
  for (const group of groups) {
    for (const tag of group ?? []) {
      const trimmed = tag.trim();
      if (trimmed) set.add(trimmed);
    }
  }
  return [...set];
}

export function scopeTag(scope: MemoryScope): string {
  return `scope:${scope}`;
}

export function inferMemoryTags(input: {
  memoryType: MemoryType;
  scope: MemoryScope;
}): string[] {
  return mergeTags(["memory", `memory:${input.memoryType}`, scopeTag(input.scope)]);
}

export function inferSummaryTags(
  summaryType: SummaryType,
  content?: StructuredSummary,
): string[] {
  const tags = ["summary", `summary:${summaryType}`];
  if (content?.errors_seen?.length) tags.push("error");
  if (content?.important_decisions?.length) tags.push("decision");
  if (content?.important_files?.length || content?.recent_changes?.length) {
    tags.push("file-change");
  }
  if (content?.tool_results?.length) tags.push("tool-result");
  return mergeTags(tags);
}

export function inferFileSnippetTags(input: { path: string; tool: string }): string[] {
  const tags = ["code-fragment", `tool:${input.tool}`];
  const ext = path.extname(input.path).slice(1).toLowerCase();
  if (ext) tags.push(`ext:${ext}`);
  const lang = LANG_BY_EXT[ext];
  if (lang) tags.push(`lang:${lang}`);
  if (input.tool === "git_diff" || input.tool === "apply_patch" || input.tool === "diff_file") {
    tags.push("diff");
  }
  if (input.tool === "search_text") tags.push("search-hit");
  return mergeTags(tags);
}

export function inferToolResultTags(toolName: string): string[] {
  return mergeTags(["tool-result", `tool:${toolName}`]);
}

export function inferTaskTags(status?: string): string[] {
  const tags = ["task"];
  if (status) tags.push(`task:${status}`);
  return mergeTags(tags);
}

export function inferPlanStepTags(status?: string): string[] {
  const tags = ["plan", "plan-step"];
  if (status) tags.push(`step:${status}`);
  return mergeTags(tags);
}

export function sectionTypeTag(sectionType: SystemSectionType): string {
  return `section:${sectionType}`;
}

/** 为 systemSection 条目附加标签（便于按标签重组上下文）。 */
export function tagSectionItem(
  item: SystemSectionItem,
  sectionType: SystemSectionType,
  extra?: string[],
): SystemSectionItem {
  const base = mergeTags([sectionTypeTag(sectionType)], item.tags, extra);
  return { ...item, tags: base.length > 0 ? base : undefined };
}

/** 标签过滤：filterTags 为空则放行；否则 item 至少命中一个 filter 标签。 */
export function matchesTagFilter(
  itemTags: string[] | undefined,
  filterTags: string[] | undefined,
): boolean {
  if (!filterTags?.length) return true;
  if (!itemTags?.length) return false;
  const set = new Set(itemTags);
  return filterTags.some((t) => set.has(t));
}

/** 从 ContextPackage sections 扁平化为可检索片段列表。 */
export function flattenTaggedFragments(
  sections: Array<{ type: SystemSectionType; items: SystemSectionItem[] }>,
): Array<{
  id: string;
  tags: string[];
  sourceType: SystemSectionItem["sourceType"];
  sourceId?: string;
  sectionType: SystemSectionType;
  text: string;
}> {
  const out: Array<{
    id: string;
    tags: string[];
    sourceType: SystemSectionItem["sourceType"];
    sourceId?: string;
    sectionType: SystemSectionType;
    text: string;
  }> = [];
  for (const section of sections) {
    const items = section.items ?? [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]!;
      const tags = mergeTags([sectionTypeTag(section.type)], item.tags);
      out.push({
        id: item.sourceId ?? `${section.type}:${i}`,
        tags,
        sourceType: item.sourceType,
        sourceId: item.sourceId,
        sectionType: section.type,
        text: item.text,
      });
    }
  }
  return out;
}
