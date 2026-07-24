import type { ChatMessage } from "../model/types.js";
import { estimateTokens } from "./DatabaseManager.js";
import type { ContextMessage, ContextPhase, SystemSection } from "./types.js";

export interface PromptBuildInput {
  systemBase: string;
  systemSections: SystemSection[];
  messages: ContextMessage[];
  currentUser?: string;
  phase?: ContextPhase;
  tokenBudget?: number;
}

/** 将 systemSections 与最近消息渲染为模型输入（只读 contextPackage，不修改其内容）。 */
export class PromptBuilder {
  renderSystemSectionsText(sections: SystemSection[], tokenBudget?: number): string {
    return renderSections(sections, tokenBudget);
  }

  build(input: PromptBuildInput): ChatMessage[] {
    const sectionsText = renderSections(input.systemSections, input.tokenBudget);
    const system = [input.systemBase, sectionsText].filter(Boolean).join("\n\n");
    const messages: ChatMessage[] = [{ role: "system", content: system }];
    messages.push(...input.messages.map(toChatMessage));

    if (input.phase === "post_call") {
      return messages;
    }

    if (input.currentUser) {
      const last = input.messages.at(-1);
      if (!last || last.content !== input.currentUser || last.role !== "user") {
        messages.push({ role: "user", content: input.currentUser });
      }
    }

    return finalizePreCallMessages(messages);
  }
}

function toChatMessage(m: ContextMessage): ChatMessage {
  return {
    role: m.role,
    content: m.content,
    name: m.toolName,
    toolCallId: m.toolCallId,
    toolCalls: m.toolCalls,
  };
}

/** pre_call：仅保留 system + 历史 + 最后一条 user，截断其后的 assistant/tool。 */
function finalizePreCallMessages(messages: ChatMessage[]): ChatMessage[] {
  const system = messages[0]?.role === "system" ? messages[0] : undefined;
  const rest = system ? messages.slice(1) : [...messages];
  const lastUserIdx = findLastIndex(rest, (m) => m.role === "user");
  if (lastUserIdx < 0) {
    return system ? [system] : [];
  }
  const trimmed = rest.slice(0, lastUserIdx + 1);
  return system ? [system, ...trimmed] : trimmed;
}

function findLastIndex<T>(items: T[], pred: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (pred(items[i]!)) return i;
  }
  return -1;
}

function renderSections(sections: SystemSection[], tokenBudget?: number): string {
  const sorted = [...sections].sort((a, b) => b.priority - a.priority);
  const blocks: string[] = [];
  let used = 0;
  for (const section of sorted) {
    const lines = [`## ${section.title}`];
    for (const item of section.items ?? []) {
      lines.push(`- ${item.text}`);
    }
    const block = lines.join("\n");
    const tokens = estimateTokens(block);
    if (tokenBudget && used + tokens > tokenBudget) break;
    blocks.push(block);
    used += tokens;
  }
  return blocks.join("\n\n");
}
