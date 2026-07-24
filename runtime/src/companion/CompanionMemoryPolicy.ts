import {
  CompanionMemoryPolicyDecisionSchema,
  type CompanionMemoryPolicyDecision,
  type CompanionMemoryKind,
  type CompanionMemorySensitivity,
  type CompanionMemoryStatus,
  type CompanionOutputMode,
} from "./CompanionMemoryContracts.js";

export interface NormalizedCompanionMemoryInput {
  kind: CompanionMemoryKind;
  key?: string;
  value: string;
  summary: string;
  importance?: number;
  confidence?: number;
}

const SENSITIVE_PATTERN =
  /(密码|密钥|私钥|身份证|银行卡|信用卡|api[_ -]?key|access[_ -]?token|secret|password|credential|\.pem|\.key)/i;
const DEPENDENCY_PATTERN =
  /(只靠你|只能依赖你|你属于我|我属于你|不要找别人|别找别人|只有你懂我|只要你|永远陪我|你永远不会离开)/i;

const MEMORY_KINDS = new Set<CompanionMemoryKind>(["preference", "fact", "boundary", "relationship", "style"]);
const MEMORY_STATUSES = new Set<CompanionMemoryStatus>(["candidate", "confirmed", "rejected", "deleted"]);

export function normalizeCompanionMemoryInput(input: {
  kind?: CompanionMemoryKind;
  key?: string;
  value?: string;
  summary?: string;
  importance?: number;
  confidence?: number;
}): NormalizedCompanionMemoryInput {
  const value = input.value?.trim();
  if (!value) throw new Error("value 不能为空");
  if (value.length < 2) throw new Error("value 至少需要 2 个字符");
  if (value.length > 500) throw new Error("value 不能超过 500 个字符");
  const summary = input.summary?.trim() || value;
  if (summary.length > 500) throw new Error("summary 不能超过 500 个字符");
  const kind = input.kind ?? "fact";
  if (!MEMORY_KINDS.has(kind)) throw new Error(`非法 memory kind：${String(kind)}`);
  const normalized: NormalizedCompanionMemoryInput = {
    kind,
    key: input.key?.trim() || undefined,
    value,
    summary,
  };
  if (input.importance !== undefined) normalized.importance = normalizeScore(input.importance, "importance");
  if (input.confidence !== undefined) normalized.confidence = normalizeScore(input.confidence, "confidence");
  return normalized;
}

export function assertCompanionMemoryStatus(status: unknown): asserts status is CompanionMemoryStatus | undefined {
  if (status === undefined) return;
  if (!MEMORY_STATUSES.has(status as CompanionMemoryStatus)) {
    throw new Error(`非法 memory status：${String(status)}`);
  }
}

export function evaluateCompanionMemoryPolicy(input: {
  value: string;
  summary?: string;
  key?: string;
  kind?: CompanionMemoryKind;
  outputMode: CompanionOutputMode;
  requestedStatus?: CompanionMemoryStatus;
}): CompanionMemoryPolicyDecision {
  const text = `${input.key ?? ""} ${input.summary ?? ""} ${input.value}`.trim();
  const sensitivity = classifyMemorySensitivity(text);
  const dependencyBlocked = hasDependencyMemoryRisk(`${input.value} ${input.summary ?? ""}`);

  if (input.outputMode === "unrestricted") {
    const vectorEligible = sensitivity !== "high" && sensitivity !== "critical";
    return CompanionMemoryPolicyDecisionSchema.parse({
      allowed: true,
      statusDecision: input.requestedStatus === "candidate" ? "candidate" : "confirmed",
      sensitivity,
      vectorEligible,
    });
  }

  if (dependencyBlocked) {
    return CompanionMemoryPolicyDecisionSchema.parse({
      allowed: false,
      statusDecision: "blocked",
      sensitivity,
      blockedReason: "dependency_memory_blocked",
      vectorEligible: false,
    });
  }

  if (sensitivity === "high" || sensitivity === "critical") {
    return CompanionMemoryPolicyDecisionSchema.parse({
      allowed: false,
      statusDecision: "blocked",
      sensitivity,
      blockedReason: "sensitive_memory",
      vectorEligible: false,
    });
  }

  if (sensitivity === "medium") {
    return CompanionMemoryPolicyDecisionSchema.parse({
      allowed: true,
      statusDecision: "candidate",
      sensitivity,
      vectorEligible: false,
    });
  }

  return CompanionMemoryPolicyDecisionSchema.parse({
    allowed: true,
    statusDecision: input.requestedStatus === "candidate" ? "candidate" : "confirmed",
    sensitivity,
    vectorEligible: input.requestedStatus !== "candidate",
  });
}

export function classifyMemorySensitivity(value: string): CompanionMemorySensitivity {
  if (SENSITIVE_PATTERN.test(value)) return "critical";
  if (/住址|地址|电话|手机号|邮箱|病历|诊断|药物/i.test(value)) return "high";
  if (/焦虑|抑郁|创伤|亲密关系|家庭矛盾/i.test(value)) return "medium";
  return "low";
}

export function hasDependencyMemoryRisk(value: string): boolean {
  return (
    DEPENDENCY_PATTERN.test(value)
    || /only you|depend on you|belong to|don't leave|never leave|no one else/i.test(value)
  );
}

function normalizeScore(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} 必须在 0 到 1 之间`);
  }
  return value;
}
