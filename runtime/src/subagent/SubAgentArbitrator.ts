import type { LoopChatFn } from "../agent/AgentLoop.js";
import type { SubAgentConflict, SubAgentRunResult, SubAgentWriteConflict } from "./types.js";
import { parseWriteFilePickHints } from "./writeFileVersionPick.js";

export interface SubAgentArbitrationInput {
  task: string;
  results: SubAgentRunResult[];
  textConflicts: SubAgentConflict[];
  writeConflicts: SubAgentWriteConflict[];
  sensitive?: boolean;
}

export interface SubAgentWriteFilePick {
  path: string;
  changeId?: string;
  taskId?: string;
  manual?: boolean;
}

export interface SubAgentArbitrationResult {
  applied: boolean;
  summary: string;
  skippedReason?: string;
  writeFilePicks?: SubAgentWriteFilePick[];
}

export async function arbitrateSubAgentConflicts(
  chat: LoopChatFn,
  input: SubAgentArbitrationInput,
): Promise<SubAgentArbitrationResult> {
  if (input.textConflicts.length === 0 && input.writeConflicts.length === 0) {
    return { applied: false, summary: "", skippedReason: "无冲突，跳过仲裁" };
  }

  const lines = [
    "你是父 Agent 的冲突仲裁助手。多个子 Agent 对同一任务给出了冲突结论或写入了同一文件。",
    "请用中文输出：",
    "1. 冲突摘要（各子任务分歧点）",
    "2. 更可信的一方或折中结论（说明依据）",
    "3. 对写入冲突：建议保留哪份修改、是否需人工复核、下一步验证",
    "4. 每个写入冲突在文末单独一行（便于自动选版）：",
    "   WRITE_PICK: path=<相对路径> changeId=<uuid> taskId=<子任务id>",
    "   无法判断则：WRITE_PICK: path=<相对路径> manual=true",
    "不要调用工具，直接给出 final 建议。",
    "",
    `父任务：${input.task.trim()}`,
    "",
    "文本冲突：",
    input.textConflicts.length
      ? input.textConflicts
          .map(
            (c) =>
              `- 主题 ${c.topic}：${c.reason}\n  ${c.excerpts.map((e) => `${e.goal.slice(0, 30)}: ${e.text}`).join(" | ")}`,
          )
          .join("\n")
      : "（无）",
    "",
    "写入冲突：",
    input.writeConflicts.length
      ? input.writeConflicts
          .map((w) => `- ${w.path}（${w.taskIds.length} 个任务）：${w.reason}`)
          .join("\n")
      : "（无）",
    "",
    "各子 Agent 完整回答：",
    input.results
      .map((r) => `[${r.goal.slice(0, 40)}] ${r.status}\n${r.error ? `错误：${r.error}\n` : ""}${r.answer}`)
      .join("\n\n---\n\n"),
  ];

  const response = await chat(
    {
      messages: [{ role: "user", content: lines.join("\n") }],
      temperature: 0.2,
      maxTokens: 2048,
    },
    { sensitive: input.sensitive },
  );

  const summary = response.content.trim() || "（仲裁模型未返回内容）";
  const writeFilePicks = parseWriteFilePickHints(summary);
  return {
    applied: true,
    summary,
    writeFilePicks: writeFilePicks.length > 0 ? writeFilePicks : undefined,
  };
}
