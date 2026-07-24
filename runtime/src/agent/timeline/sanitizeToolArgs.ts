/** 工具参数脱敏：隐藏 token / apiKey 等敏感字段。 */
export function sanitizeToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const secretKeys = ["token", "apikey", "password", "authorization", "secret", "credential"];
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => {
      const lower = key.toLowerCase();
      if (secretKeys.some((s) => lower.includes(s))) {
        return [key, "***"];
      }
      if (typeof value === "string" && value.length > 500) {
        return [key, `${value.slice(0, 500)}…`];
      }
      return [key, value];
    }),
  );
}
