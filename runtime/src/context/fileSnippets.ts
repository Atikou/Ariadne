/** 从持久化的 tool 消息提取文件路径与代码片段，供 systemSections 注入。 */

import { inferFileSnippetTags } from "./contextTags.js";
import { classifyPathRisk } from "../policy/PathRiskClassifier.js";

export interface FileSnippetItem {
  path: string;
  tool: string;
  preview: string;
  messageId: string;
  tags: string[];
}

const FILE_SNIPPET_TOOLS = new Set(["read_file", "search_text", "git_diff", "apply_patch", "diff_file"]);

function unwrapPayload(parsed: unknown): unknown {
  if (parsed && typeof parsed === "object" && "_untrusted" in parsed) {
    return (parsed as { data?: unknown }).data ?? parsed;
  }
  if (parsed && typeof parsed === "object" && "_truncated" in parsed) {
    const p = parsed as { preview?: string; tool?: string };
    return { path: p.tool ?? "unknown", content: p.preview ?? "" };
  }
  return parsed;
}

function parseToolBody(tool: string, body: string): Array<{ path: string; tool: string; preview: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const data = unwrapPayload(parsed);
  if (!data || typeof data !== "object") return [];

  const record = data as Record<string, unknown>;

  if (tool === "read_file" && typeof record.path === "string") {
    const content = typeof record.content === "string" ? record.content : "";
    return [{ path: record.path, tool, preview: content }];
  }

  if (tool === "search_text" && Array.isArray(record.results)) {
    const out: Array<{ path: string; tool: string; preview: string }> = [];
    for (const hit of record.results as Array<Record<string, unknown>>) {
      if (typeof hit.path !== "string") continue;
      const line = typeof hit.line === "number" ? hit.line : "?";
      const text = typeof hit.text === "string" ? hit.text : "";
      out.push({
        path: hit.path,
        tool,
        preview: `L${line}: ${text}`,
      });
    }
    return out;
  }

  if (tool === "git_diff") {
    const diff = typeof record.diff === "string" ? record.diff : "";
    const path =
      typeof record.path === "string" ? record.path : diff.match(/^diff --git a\/(\S+)/m)?.[1] ?? "git diff";
    return [{ path, tool, preview: diff }];
  }

  if ((tool === "apply_patch" || tool === "diff_file") && typeof record.path === "string") {
    const preview =
      typeof record.diff === "string"
        ? record.diff
        : typeof record.patch === "string"
          ? record.patch
          : JSON.stringify(record).slice(0, 400);
    return [{ path: record.path, tool, preview }];
  }

  return [];
}

/** 解析最近 tool 消息，按路径去重（保留最新），限制条数与预览长度。 */
export function extractFileSnippetsFromToolMessages(
  messages: Array<{ id: string; content: string }>,
  options?: { maxSnippets?: number; maxPreviewChars?: number },
): FileSnippetItem[] {
  const maxSnippets = options?.maxSnippets ?? 5;
  const maxPreviewChars = options?.maxPreviewChars ?? 600;
  const byPath = new Map<string, FileSnippetItem>();

  for (const m of messages) {
    const toolMatch = m.content.match(/^工具「([^」]+)」/);
    if (!toolMatch) continue;
    const tool = toolMatch[1]!;
    if (!FILE_SNIPPET_TOOLS.has(tool)) continue;
    const body = m.content.replace(/^工具「[^」]+」[^:\n]*[：:]?\n?/, "").trim();
    for (const raw of parseToolBody(tool, body)) {
      if (classifyPathRisk(raw.path).kind !== "normal") continue;
      const preview =
        raw.preview.length > maxPreviewChars
          ? `${raw.preview.slice(0, maxPreviewChars)}…`
          : raw.preview;
      byPath.set(raw.path, {
        ...raw,
        preview,
        messageId: m.id,
        tags: inferFileSnippetTags({ path: raw.path, tool: raw.tool }),
      });
    }
  }

  return [...byPath.values()].slice(-maxSnippets);
}
