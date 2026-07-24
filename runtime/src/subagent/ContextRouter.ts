import type { NormalizedDelegatedTask } from "./delegatedTask.js";
import type { ExecutionRoute } from "./executionRoute.js";

export interface PackagedSubAgentContext {
  userContent: string;
  tokenEstimate: number;
}

/**
 * 为子任务准备最小必要上下文，不继承主 Agent 全量对话历史。
 */
export class ContextRouter {
  package(task: NormalizedDelegatedTask, route?: ExecutionRoute): PackagedSubAgentContext {
    const maxTokens = route?.contextPolicy?.maxTokens ?? 8_000;
    const sections: string[] = [];

    sections.push(`## 子任务目标\n${task.goal.trim()}`);

    if (task.instructions.trim() && task.instructions.trim() !== task.goal.trim()) {
      sections.push(`## 执行说明\n${task.instructions.trim()}`);
    }

    if (task.input.trim()) {
      sections.push(`## 输入\n${task.input.trim()}`);
    }

    const ctx = task.context;
    if (ctx?.files?.length) {
      sections.push(`## 相关文件\n${ctx.files.map((f) => `- ${f}`).join("\n")}`);
    }
    if (ctx?.snippets?.length) {
      sections.push(`## 代码片段\n${ctx.snippets.join("\n\n---\n\n")}`);
    }
    if (ctx?.logs?.length) {
      sections.push(`## 日志\n${ctx.logs.join("\n\n")}`);
    }
    if (ctx?.previousResults?.length) {
      sections.push(`## 前序子任务结果\n${ctx.previousResults.join("\n\n")}`);
    }
    if (ctx?.projectFacts?.length) {
      sections.push(`## 项目事实\n${ctx.projectFacts.map((f) => `- ${f}`).join("\n")}`);
    }

    let userContent = sections.join("\n\n");
    const tokenEstimate = Math.ceil(userContent.length / 3);
    if (tokenEstimate > maxTokens) {
      const budgetChars = maxTokens * 3;
      userContent = `${userContent.slice(0, budgetChars)}\n\n（上下文已按预算截断）`;
    }

    return { userContent, tokenEstimate: Math.min(tokenEstimate, maxTokens) };
  }
}

export const defaultContextRouter = new ContextRouter();
