import type { LoopChatFn } from "../agent/AgentLoop.js";
import type { NormalizedDelegatedTask } from "./delegatedTask.js";
import { buildDelegatedTaskSystemPrompt } from "./taskPrompt.js";
import { limitsToRunBudget } from "./delegatedTask.js";

/** 文件已预读时走单次分析：不要求 ReAct JSON 协议。 */
export async function runSingleShotReview(
  task: NormalizedDelegatedTask,
  userContent: string,
  preloaded: string,
  chat: LoopChatFn,
  extras?: { sensitive?: boolean; signal?: AbortSignal },
): Promise<string> {
  const budget = limitsToRunBudget(task.limits, task.toolPolicy.writeAllowed);
  const response = await chat(
    {
      messages: [
        {
          role: "system",
          content: [
            buildDelegatedTaskSystemPrompt(task, budget),
            "目标文件内容已在用户消息中给出。请直接输出分析结论（中文，可用 Markdown 列表）。",
            "禁止再要求调用工具；不要输出 JSON；不要重复粘贴整份源码。",
          ].join("\n"),
        },
        {
          role: "user",
          content: [userContent, preloaded].filter(Boolean).join("\n\n"),
        },
      ],
      temperature: 0.2,
      signal: extras?.signal,
    },
    { sensitive: extras?.sensitive },
  );
  return response.content.trim() || "（模型未返回内容）";
}

/** 纯文本只读子任务：单次模型调用，跳过 AgentLoop / 工作流预扫描。 */
export async function runLightweightTextTask(
  task: NormalizedDelegatedTask,
  userContent: string,
  chat: LoopChatFn,
  extras?: { sensitive?: boolean; signal?: AbortSignal },
): Promise<string> {
  const budget = limitsToRunBudget(task.limits, false);
  const response = await chat(
    {
      messages: [
        {
          role: "system",
          content: [
            buildDelegatedTaskSystemPrompt(task, budget),
            "这是轻量只读子任务：直接给出结论，不要调用工具，不要输出 ReAct JSON。",
            "用中文简洁回答；若 outputContract 要求 JSON，可输出单层 JSON 对象，但不要包在字符串里。",
          ].join("\n"),
        },
        {
          role: "user",
          content: userContent,
        },
      ],
      temperature: 0.2,
      signal: extras?.signal,
    },
    { sensitive: extras?.sensitive },
  );
  return response.content.trim() || "（模型未返回内容）";
}
