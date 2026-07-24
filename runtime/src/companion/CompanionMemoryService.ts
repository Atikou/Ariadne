import {
  CompanionMemoryCollectionSchema,
  type CompanionMemory,
  type CompanionMemoryCandidate,
  type CompanionMemoryCollection,
  type CompanionMemoryKind,
  type CompanionOutputMode,
} from "./CompanionMemoryContracts.js";
import type { CompanionStorage } from "./CompanionStorage.js";
import {
  classifyMemorySensitivity,
  evaluateCompanionMemoryPolicy,
  hasDependencyMemoryRisk,
} from "./CompanionMemoryPolicy.js";

export interface CompanionMemoryExtractionResult {
  candidate?: CompanionMemoryCandidate;
  memory?: CompanionMemory;
  skippedReason?: string;
}

export class CompanionMemoryService {
  constructor(private readonly storage: CompanionStorage) {}

  extractFromUserMessage(input: {
    message: string;
    sessionId?: string;
    sourceMessageId?: string;
    outputMode: CompanionOutputMode;
  }): CompanionMemoryExtractionResult {
    const parsed = parseExplicitMemory(input.message);
    if (!parsed) return { skippedReason: "no_explicit_memory_intent" };
    const policy = evaluateCompanionMemoryPolicy({
      value: parsed.value,
      summary: parsed.summary,
      key: parsed.key,
      kind: parsed.kind,
      outputMode: input.outputMode,
      requestedStatus: "confirmed",
    });
    if (!policy.allowed) return { skippedReason: policy.blockedReason ?? "memory_policy_blocked" };
    if (parsed.kind === "relationship" && hasDependencyMemoryRisk(input.message)) {
      return { skippedReason: "dependency_memory_blocked" };
    }

    const existing = this.storage
      .listMemories({
        status: "confirmed",
        outputMode: input.outputMode,
        includeUnrestrictedForUnrestricted: input.outputMode === "unrestricted",
        limit: 200,
      })
      .find((m) => (parsed.key && m.key === parsed.key) || m.value === parsed.value);
    if (existing) return { memory: existing, skippedReason: "already_confirmed" };

    const candidate = this.storage.createMemoryCandidate({
      sessionId: input.sessionId,
      sourceMessageId: input.sourceMessageId,
      kind: parsed.kind,
      key: parsed.key,
      value: parsed.value,
      summary: parsed.summary,
      outputMode: input.outputMode,
      reason: parsed.reason,
      sensitivity: policy.sensitivity,
      status: "candidate",
    });

    const memory = policy.statusDecision === "confirmed" ? this.storage.confirmMemoryCandidate(candidate.id) ?? undefined : undefined;
    return { candidate: this.storage.getMemoryCandidate(candidate.id) ?? candidate, memory };
  }

  list(input?: {
    outputMode?: CompanionOutputMode;
    sessionId?: string;
    includeCandidates?: boolean;
  }): CompanionMemoryCollection {
    const outputMode = input?.outputMode ?? "bounded";
    return CompanionMemoryCollectionSchema.parse({
      candidates: input?.includeCandidates === false
        ? []
        : this.storage.listMemoryCandidates({
            status: "candidate",
            outputMode,
            sessionId: input?.sessionId,
            limit: 200,
          }),
      memories: this.storage.listMemories({
        status: "confirmed",
        outputMode,
        includeUnrestrictedForUnrestricted: outputMode === "unrestricted",
        limit: 200,
      }),
    });
  }

}

function parseExplicitMemory(message: string): {
  kind: CompanionMemoryKind;
  key?: string;
  value: string;
  summary: string;
  reason: string;
} | null {
  const text = message.trim();
  const patterns: Array<{
    re: RegExp;
    kind: CompanionMemoryKind;
    key: string;
    summaryPrefix: string;
    reason: string;
  }> = [
    { re: /(?:请)?记住(?:一下)?[：:，, ]*(.+)$/i, kind: "fact", key: "remembered_fact", summaryPrefix: "用户希望记住", reason: "explicit_remember" },
    { re: /以后(?:请)?叫我[：:，, ]*(.+)$/i, kind: "preference", key: "preferred_name", summaryPrefix: "用户希望被称呼为", reason: "explicit_name" },
    { re: /以后(?:请)?称呼我(?:为)?[：:，, ]*(.+)$/i, kind: "preference", key: "preferred_name", summaryPrefix: "用户希望被称呼为", reason: "explicit_name" },
    { re: /我喜欢[：:，, ]*(.+)$/i, kind: "preference", key: "likes", summaryPrefix: "用户喜欢", reason: "explicit_preference" },
    { re: /我不喜欢[：:，, ]*(.+)$/i, kind: "preference", key: "dislikes", summaryPrefix: "用户不喜欢", reason: "explicit_preference" },
    { re: /我的([^，。,.]{1,20})是[：:，, ]*(.+)$/i, kind: "fact", key: "user_fact", summaryPrefix: "用户事实", reason: "explicit_fact" },
    { re: /remember (?:that )?(.+)$/i, kind: "fact", key: "remembered_fact", summaryPrefix: "User asked to remember", reason: "explicit_remember" },
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern.re);
    const raw = match?.[2] ?? match?.[1];
    const value = raw?.trim();
    if (!value || value.length < 2 || value.length > 240) continue;
    const key = pattern.key === "user_fact" && match?.[1] ? `user_${match[1].trim()}` : pattern.key;
    return {
      kind: pattern.kind,
      key,
      value,
      summary: `${pattern.summaryPrefix}：${value}`,
      reason: pattern.reason,
    };
  }
  return null;
}

export { classifyMemorySensitivity };
