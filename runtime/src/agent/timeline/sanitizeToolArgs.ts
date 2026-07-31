import type { JsonValue } from "@ariadne/protocol/public";

const SECRET_KEY = /(token|api[_-]?key|password|authorization|secret|credential|cookie)/iu;
const AUTH_VALUE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu;
const ENV_SECRET = /\b([A-Z0-9_]*(?:TOKEN|KEY|PASSWORD|SECRET|CREDENTIAL)[A-Z0-9_]*)=([^\s;&|]+)/giu;
const MAX_TEXT_CHARS = 64 * 1024;
const MAX_ARG_TEXT_CHARS = 8 * 1024;
const MAX_DEPTH = 8;

export interface SanitizedActivityValue {
  value: JsonValue;
  redacted: boolean;
  truncated: boolean;
}

export function sanitizeToolArgs(args: Record<string, unknown>): Record<string, JsonValue> {
  return sanitizeActivityValue(args, MAX_ARG_TEXT_CHARS).value as Record<string, JsonValue>;
}

export function sanitizeActivityValue(
  input: unknown,
  maxStringChars = MAX_TEXT_CHARS,
): SanitizedActivityValue {
  let redacted = false;
  let truncated = false;

  const visit = (value: unknown, key: string | undefined, depth: number): JsonValue => {
    if (key && SECRET_KEY.test(key)) {
      redacted = true;
      return "***";
    }
    if (depth > MAX_DEPTH) {
      truncated = true;
      return "[depth truncated]";
    }
    if (value === undefined) return null;
    if (value === null || typeof value === "boolean" || typeof value === "number") {
      return Number.isFinite(value as number) || typeof value !== "number" ? value : String(value);
    }
    if (typeof value === "string") {
      let text = redactActivityText(value);
      if (text !== value) redacted = true;
      if (text.length > maxStringChars) {
        text = `${text.slice(0, maxStringChars)}\n…[truncated]`;
        truncated = true;
      }
      return text;
    }
    if (Array.isArray(value)) {
      return value.slice(0, 2_000).map((item) => visit(item, undefined, depth + 1));
    }
    if (value && typeof value === "object") {
      const output: Record<string, JsonValue> = {};
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>).slice(0, 2_000)) {
        output[childKey] = visit(childValue, childKey, depth + 1);
      }
      return output;
    }
    return String(value);
  };

  return { value: visit(input, undefined, 0), redacted, truncated };
}

export function redactActivityText(value: string): string {
  return value
    .replace(AUTH_VALUE, "$1 ***")
    .replace(ENV_SECRET, "$1=***");
}
