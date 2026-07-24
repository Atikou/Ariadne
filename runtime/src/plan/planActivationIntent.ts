/** 检测用户是否希望激活并执行已生成的 UserVisiblePlan。 */
export function detectPlanActivationIntent(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  if (/^activatePlan\b/i.test(text)) return true;
  return /(执行计划|按计划执行|激活计划|启动计划|approve\s+and\s+execute|activate\s+plan)/i.test(
    text,
  );
}

/** 从消息中解析显式 userVisiblePlanId（可选）。 */
export function parseUserVisiblePlanIdFromMessage(message: string): string | undefined {
  const match = message.match(/(?:uvp_|userVisiblePlanId[=:]?\s*)([a-zA-Z0-9_-]+)/i);
  if (match?.[1]) return match[1].startsWith("uvp_") ? match[1] : `uvp_${match[1]}`;
  const bare = message.match(/\buvp_[a-f0-9-]+\b/i);
  return bare?.[0];
}

export function defaultConfirmedTodoIds(
  todos: Array<{ id: string; priority: string }>,
): string[] {
  const p0 = todos.filter((t) => t.priority === "P0").map((t) => t.id);
  if (p0.length > 0) return p0;
  return todos.map((t) => t.id);
}
