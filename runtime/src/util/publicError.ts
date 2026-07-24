import { redactString } from "./redact.js";

export interface PublicErrorInfo {
  code: string;
  message: string;
}

/** 将内部异常收敛为可公开错误；堆栈、本机绝对路径和凭据只能进入脱敏 trace。 */
export function toPublicError(error: unknown, fallback = "内部执行失败"): PublicErrorInfo {
  const rawCode =
    typeof error === "object" && error != null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  const code = /^[A-Z][A-Z0-9_]{2,63}$/.test(rawCode) ? rawCode : "INTERNAL_ERROR";
  const rawMessage = error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
  const withoutStack = rawMessage
    .split(/\r?\n/)
    .filter((line) => !/^\s*at\s+(?:async\s+)?/.test(line))
    .join("\n")
    .trim() || fallback;
  const withoutWindowsPaths = withoutStack.replace(/[A-Za-z]:\\[^\r\n]+/g, "[local path]");
  const withoutPosixPaths = withoutWindowsPaths.replace(/(?:^|\s)\/(?:[^\s/]+\/)+[^\s)\]}]+/g, " [local path]");
  return {
    code,
    message: redactString(withoutPosixPaths).slice(0, 500),
  };
}
