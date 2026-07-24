/** 路由用上下文 token 粗估（字符数 / 3，与 ContextAnalyzer 一致）。 */
export function estimateTokensFromText(text: string): number {
  return Math.max(0, Math.ceil(text.trim().length / 3));
}

export function estimateRouterContextTokens(
  messages: ReadonlyArray<{ role: string; content: string }>,
): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string" && msg.content.length > 0) {
      total += estimateTokensFromText(msg.content);
    }
  }
  return total;
}
