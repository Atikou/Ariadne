/**
 * 识别用户粘贴的 Agent 工具步骤失败/执行输出（测试台 step 卡片、Timeline 摘要等）。
 * 此类消息应沿用会话内上一轮工作流，而非重新推断为 chat/answer。
 */
export function isAgentStepFailureFeedback(message?: string): boolean {
  const text = (message ?? "").trim();
  if (!text) return false;

  const hasStepHeader = /(?:^|\n)#\d+\s+[a-z_]+/im.test(text);
  const hasToolError =
    /\[error\]/i.test(text) ||
    /\bENOENT\b/.test(text) ||
    /(?:^|\n)失败\b/m.test(text) ||
    /工具「[^」]+」(?:未执行|执行失败)/.test(text);
  const hasStepMeta = /(?:^|\n)入参\s*\{/.test(text) || /(?:^|\n)想法：/.test(text);

  return (hasStepHeader && (hasToolError || hasStepMeta)) || (hasToolError && hasStepMeta);
}

/** 浏览器/终端/构建工具输出的运行诊断信息（非独立问答）。 */
export function isRuntimeDiagnosticFeedback(message?: string): boolean {
  const text = (message ?? "").trim();
  if (!text) return false;
  return (
    /localhost|127\.0\.0\.1/i.test(text) ||
    /\bPort \d+ is in use\b/i.test(text) ||
    /\bVITE v[\d.]+/i.test(text) ||
    /Could not auto-determine entry point/i.test(text) ||
    /找不到.*网页|无法访问此网站|ERR_CONNECTION_REFUSED/i.test(text) ||
    /npm ERR!|error TS\d+|Traceback|stack trace/i.test(text)
  );
}
