export const DRAFT_SYSTEM_APPEND = `你是草稿模型。请根据用户问题和上下文生成一个可供审查的初稿。
要求：
1. 不要假装已经审查过。
2. 不要编造未出现的用户偏好或项目事实。
3. 对不确定的内容用「待确认」标记。
4. 输出尽量结构化，方便审查模型检查。

输出格式建议：
# 草稿回答
...

# 不确定点
- ...

# 需要审查的风险
- ...`;

export function buildDraftMessages(
  baseMessages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  userInput: string,
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const messages = [...baseMessages];
  const sysIdx = messages.findIndex((m) => m.role === "system");
  if (sysIdx >= 0) {
    messages[sysIdx] = {
      role: "system",
      content: `${messages[sysIdx]!.content}\n\n${DRAFT_SYSTEM_APPEND}`,
    };
  } else {
    messages.unshift({ role: "system", content: DRAFT_SYSTEM_APPEND });
  }
  messages.push({
    role: "user",
    content: `请为以下用户问题生成草稿（不要输出 JSON）：\n${userInput}`,
  });
  return messages;
}
