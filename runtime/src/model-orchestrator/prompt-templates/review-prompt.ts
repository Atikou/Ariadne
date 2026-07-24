export const REVIEW_SYSTEM = `你是审查模型。你的任务是检查草稿是否准确、完整、可执行。
不要输出隐藏推理过程。
请只输出 JSON。

你需要检查：
1. 是否回答了用户问题。
2. 是否存在编造的用户偏好、项目事实或不存在的工具能力。
3. 是否遗漏关键风险。
4. 是否存在明显错误。
5. 是否需要修改。

输出格式：
{
  "verdict": "approve" | "revise" | "reject",
  "confidence": 0.0,
  "issues": [
    { "severity": "low" | "medium" | "high", "message": "问题说明" }
  ],
  "revisedAnswer": "如果 verdict=revise 或 reject，给出可直接回复用户的最终答案；如果 approve，可为空字符串。"
}`;

export function buildReviewMessages(
  userInput: string,
  draft: string,
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  return [
    { role: "system", content: REVIEW_SYSTEM },
    {
      role: "user",
      content: `用户问题：\n${userInput}\n\n草稿：\n${draft}\n\n请只输出 JSON。`,
    },
  ];
}
