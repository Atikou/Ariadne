import type { ChatMessage } from "../model/types.js";
import type { CompanionMemory, CompanionMessage, CompanionOutputMode, CompanionSummary } from "./types.js";
import type { PersonaProfile } from "./PersonaRuntime.js";
import {
  COMPANION_AGENT_PROPOSAL_CLOSE,
  COMPANION_AGENT_PROPOSAL_OPEN,
} from "./CompanionTurnProtocol.js";

export function composeCompanionMessages(input: {
  persona: PersonaProfile;
  currentUserMessage: string;
  recentMessages: CompanionMessage[];
  summaries: CompanionSummary[];
  memories?: CompanionMemory[];
  outputMode?: CompanionOutputMode;
  agentProposalEnabled?: boolean;
}): ChatMessage[] {
  const history = input.recentMessages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m): ChatMessage => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    }));
  const summaryText = input.summaries.map((s) => `- ${s.summary}`).join("\n");
  const memoryText = (input.memories ?? []).map((m) => `- ${m.summary}`).join("\n");
  const outputMode = input.outputMode ?? "bounded";
  if (outputMode === "unrestricted") {
    const rawSystem = [
      input.persona.systemPrompt,
      summaryText ? `\n相关会话摘要（来自独立会话窗口的压缩背景）：\n${summaryText}` : "",
      memoryText ? `\n相关长期记忆：\n${memoryText}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return [
      { role: "system", content: rawSystem },
      ...history,
      { role: "user", content: input.currentUserMessage },
    ];
  }

  const system = [
    input.persona.systemPrompt,
    "",
    "输出要求：",
    "- 普通对话直接输出自然语言，不要添加 JSON 包装，也不要输出 tool call。",
    ...(input.agentProposalEnabled
      ? [
          "- 当用户的请求确实需要读取或修改文件、浏览网页、运行命令等现实操作时，不要声称已经执行；改为提交一次临时 Agent 能力请求，由系统核对用户权限边界，只有权限不足时才向用户确认。用户明确说“交给 Agent”时也使用提案。",
          `- 提案必须是整条响应的唯一内容，格式严格为：${COMPANION_AGENT_PROPOSAL_OPEN} 换行 单个 JSON 对象 换行 ${COMPANION_AGENT_PROPOSAL_CLOSE}。`,
          "- JSON 只允许 reason、interpretedTask、requestedCapabilities、risk 四个字段；requestedCapabilities 只能从 file-read、file-write、browser、shell 中选择且不得重复；risk 只能是 read-only、write、destructive。",
          "- requestedCapabilities 必须完整列出 AI 判断完成当前请求所需的最小能力集合；系统只会按用户边界裁剪，不会替你补充能力。需要读取项目内容时申请 file-read，确实需要写入、浏览器或命令时再分别申请 file-write、browser、shell。",
          "- reason 只说明已经开始准备的具体操作与必要性；不得声称“无法直接执行”“只能生成内容”或要求用户再发送文字确认，授权交互由系统界面负责。interpretedTask 只描述准备完成的任务，不得把它写成授权。",
          "- 需要工具或权限时必须直接输出上述结构化能力请求，不要先用自然语言声称“没有权限”“没权限”“无法执行”，也不要询问“是否开始”“是否确认”或说“确认后再做”。只有系统明确返回用户拒绝后，才可说明相关操作因拒绝而未执行。",
          "- 不得输出 sourceTurnId、originalRequest、companionStorageRoot、workspaceKey、requestedScope、grant、工具名称或任何可执行句柄；这些字段只能由后端绑定。",
          "- 只需建议、解释或讨论时仍输出普通自然语言，不要过度提案。",
        ]
      : [
          "- 当前对话不能创建持久化 Agent 提案；只输出自然语言。需要现实操作时，请用户在普通持久化会话中确认交给 Agent。",
        ]),
    "- 语气要自然、有人味，不要机械免责声明；现实边界只在需要时自然出现，不要标语化。",
    summaryText ? `\n相关会话摘要（来自独立会话窗口的压缩背景；其他窗口原始消息不会直接注入）：\n${summaryText}` : "",
    memoryText ? `\n相关长期记忆（用户确认或明确要求记住，仅在相关时自然使用）：\n${memoryText}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return [
    { role: "system", content: system },
    ...history,
    { role: "user", content: input.currentUserMessage },
  ];
}
