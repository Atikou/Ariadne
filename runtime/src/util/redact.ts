/** 敏感字段名（小写匹配）。 */
const SENSITIVE_KEY = /password|secret|api[_-]?key|token|authorization|credential|private[_-]?key/i;
const SAFE_METRIC_KEYS = new Set([
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "totalInputTokens",
  "totalOutputTokens",
  "maxInputTokens",
  "maxOutputTokens",
  "promptTokens",
  "completionTokens",
  "totalPromptTokens",
  "totalCompletionTokens",
]);

function isSensitiveKey(key: string): boolean {
  return !SAFE_METRIC_KEYS.has(key) && SENSITIVE_KEY.test(key);
}

/** 常见密钥 / 令牌模式。 */
const SENSITIVE_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  { re: /\bsk-[a-zA-Z0-9]{10,}\b/g, replacement: "[REDACTED_KEY]" },
  { re: /\bBearer\s+[A-Za-z0-9._-]+\b/gi, replacement: "Bearer [REDACTED]" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED_AWS_KEY]" },
  {
    re: /-----BEGIN[\s\S]*?-----END [A-Z ]+-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  {
    re: /(api[_-]?key|password|secret|token)\s*[=:]\s*['"]?[^\s'"]{4,}/gi,
    replacement: "$1=[REDACTED]",
  },
];

export interface SensitiveFinding {
  pattern: string;
}

/** 对字符串中的疑似密钥做脱敏。 */
export function redactString(text: string): string {
  let out = text;
  for (const { re, replacement } of SENSITIVE_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

/** 检测字符串中是否含常见密钥 / token / 私钥片段。 */
export function detectSensitiveString(text: string): SensitiveFinding[] {
  const findings: SensitiveFinding[] = [];
  for (const { re } of SENSITIVE_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) findings.push({ pattern: re.source });
    re.lastIndex = 0;
  }
  return findings;
}

/** 深度检测任意 JSON 值中是否含敏感字段或敏感字符串。 */
export function hasSensitiveValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return detectSensitiveString(value).length > 0;
  if (typeof value === "number" || typeof value === "boolean") return false;
  if (Array.isArray(value)) return value.some((item) => hasSensitiveValue(item));
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(
      ([key, val]) => isSensitiveKey(key) || hasSensitiveValue(val),
    );
  }
  return false;
}

/** 深度脱敏任意 JSON 可序列化值。 */
export function redactValue<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value) as T;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item)) as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = redactValue(val);
      }
    }
    return out as T;
  }
  return value;
}

/** 工具入参预览：深度脱敏后序列化并截断。 */
export function redactPreview(input: unknown, maxLen = 400): string {
  try {
    const json = JSON.stringify(redactValue(input));
    const trimmed = json.length > maxLen ? `${json.slice(0, maxLen)}…` : json;
    return redactString(trimmed);
  } catch {
    return redactString(String(input).slice(0, maxLen));
  }
}
