import type { MemoryCandidate, MemoryScope, MemoryType, MessageRecord, SummaryRecord } from "./types.js";

/** 长期记忆抽取接口（可替换为 LLM 实现）。 */
export interface IMemoryExtractor {
  extractFromMessages(messages: MessageRecord[]): Promise<MemoryCandidate[]>;
  extractFromSummary(summary: SummaryRecord): Promise<MemoryCandidate[]>;
}

/** 规则抽取长期记忆（默认、离线可测）。 */
export class RuleMemoryExtractor implements IMemoryExtractor {
  async extractFromMessages(messages: MessageRecord[]): Promise<MemoryCandidate[]> {
    const out: MemoryCandidate[] = [];
    for (const m of messages) {
      if (m.role !== "user") continue;
      const pref = extractPreference(m.content);
      if (pref) {
        out.push({
          scope: "global",
          memoryType: "preference",
          key: pref.key,
          value: pref.value,
          summary: pref.summary,
          importance: 0.7,
          confidence: 0.6,
          source: "extractor",
          sourceId: m.id,
        });
      }
    }
    return dedupeCandidates(out);
  }

  async extractFromSummary(summary: SummaryRecord): Promise<MemoryCandidate[]> {
    const out: MemoryCandidate[] = [];
    for (const pref of summary.content.user_preferences ?? []) {
      out.push({
        scope: "global",
        memoryType: "preference",
        value: pref,
        summary: pref.slice(0, 80),
        importance: 0.75,
        confidence: 0.7,
        source: "summary",
        sourceId: summary.id,
      });
    }
    if (summary.projectId) {
      for (const note of summary.content.project_state ?? []) {
        out.push({
          scope: "project",
          scopeId: summary.projectId,
          memoryType: "project_note",
          value: note,
          summary: note.slice(0, 80),
          importance: 0.6,
          confidence: 0.65,
          source: "summary",
          sourceId: summary.id,
        });
      }
    }
    return dedupeCandidates(out);
  }
}

/** @deprecated 使用 RuleMemoryExtractor；保留类名兼容旧引用。 */
export class MemoryExtractor extends RuleMemoryExtractor {}

/** 用 LLM 抽取长期记忆；解析失败时回退规则抽取。 */
export function createLlmMemoryExtractor(
  chat: (prompt: string) => Promise<string>,
): IMemoryExtractor {
  const fallback = new RuleMemoryExtractor();
  return {
    async extractFromMessages(messages) {
      if (messages.length === 0) return [];
      const llm = await extractViaLlm(chat, buildMessagesPrompt(messages));
      return llm.length > 0 ? llm : fallback.extractFromMessages(messages);
    },
    async extractFromSummary(summary) {
      const llm = await extractViaLlm(chat, buildSummaryPrompt(summary));
      const merged = [...llm, ...(await fallback.extractFromSummary(summary))];
      return dedupeCandidates(merged);
    },
  };
}

async function extractViaLlm(
  chat: (prompt: string) => Promise<string>,
  prompt: string,
): Promise<MemoryCandidate[]> {
  try {
    const raw = await chat(prompt);
    const parsed = parseCandidateJson(raw);
    return dedupeCandidates(parsed);
  } catch {
    return [];
  }
}

function buildMessagesPrompt(messages: MessageRecord[]): string {
  const transcript = messages
    .map((m) => `[${m.role}] ${m.content.slice(0, 500)}`)
    .join("\n");
  return [
    "从以下对话片段提取可长期保存的记忆候选，输出 JSON 数组。",
    "每项字段：scope(global|session|project|task), memoryType, key(optional), value, summary(optional), importance(0-1), confidence(0-1)。",
    "只提取明确偏好、决策、项目事实；不要臆造。只输出 JSON 数组。",
    "",
    transcript,
  ].join("\n");
}

function buildSummaryPrompt(summary: SummaryRecord): string {
  return [
    "从以下结构化会话摘要提取记忆候选，输出 JSON 数组（字段同上）。",
    "只输出 JSON 数组。",
    "",
    JSON.stringify(summary.content),
  ].join("\n");
}

function parseCandidateJson(raw: string): MemoryCandidate[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  const items = JSON.parse(raw.slice(start, end + 1)) as Array<Record<string, unknown>>;
  const out: MemoryCandidate[] = [];
  for (const item of items) {
    const value = String(item.value ?? "").trim();
    if (!value) continue;
    out.push({
      scope: (item.scope as MemoryScope) ?? "global",
      scopeId: item.scopeId ? String(item.scopeId) : undefined,
      memoryType: (item.memoryType as MemoryType) ?? "fact",
      key: item.key ? String(item.key) : undefined,
      value,
      summary: item.summary ? String(item.summary) : undefined,
      importance: typeof item.importance === "number" ? item.importance : 0.6,
      confidence: typeof item.confidence === "number" ? item.confidence : 0.6,
      source: "llm_extractor",
    });
  }
  return out;
}

function dedupeCandidates(candidates: MemoryCandidate[]): MemoryCandidate[] {
  const seen = new Set<string>();
  const out: MemoryCandidate[] = [];
  for (const c of candidates) {
    const key = [
      c.scope,
      c.scopeId ?? "",
      c.memoryType,
      c.key?.trim() || c.value.trim(),
    ].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function extractPreference(
  text: string,
): { key: string; value: string; summary: string } | null {
  const patterns: Array<{ re: RegExp; key: string }> = [
    { re: /偏好使用\s*TypeScript/i, key: "lang_ts" },
    { re: /使用中文|中文回答|中文回复|默认使用中文/i, key: "lang_zh" },
    { re: /本地优先|privacy/i, key: "privacy" },
  ];
  for (const { re, key } of patterns) {
    if (re.test(text)) {
      return { key, value: text.trim().slice(0, 300), summary: text.trim().slice(0, 80) };
    }
  }
  return null;
}
