import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { ModelProfile } from "./types.js";

export type AgentProtocolQualificationStatus =
  | "unknown"
  | "probation"
  | "qualified"
  | "quarantined";

export interface AgentProtocolQualificationRecord {
  modelId: string;
  profileFingerprint: string;
  protocolVersion: number;
  status: AgentProtocolQualificationStatus;
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  lastCheckedAt?: string;
  qualifiedAt?: string;
  quarantinedAt?: string;
  quarantineUntil?: string;
  reason?: string;
}

export interface AgentProtocolQualificationOptions {
  successesToQualify?: number;
  failuresToQuarantine?: number;
  quarantineMs?: number;
  now?: () => Date;
}

const PROTOCOL_VERSION = 1;
const DEFAULT_SUCCESSES_TO_QUALIFY = 2;
const DEFAULT_FAILURES_TO_QUARANTINE = 2;
const DEFAULT_QUARANTINE_MS = 15 * 60_000;

/**
 * Agent 协议运行资格缓存。配置声明只是必要条件；真实严格协议结果决定 qualified/quarantined。
 * quarantine 只供 Agent 路由使用，不改变普通聊天模型可用性。
 */
export class AgentProtocolQualificationStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly options: AgentProtocolQualificationOptions = {},
  ) {}

  get(profile: ModelProfile): AgentProtocolQualificationRecord {
    const fingerprint = profileFingerprint(profile);
    const row = this.db
      .prepare(`SELECT * FROM model_agent_protocol_qualification WHERE model_id=?`)
      .get(profile.id) as Record<string, unknown> | undefined;
    if (!row || String(row.profile_fingerprint) !== fingerprint) {
      return this.reset(profile, fingerprint);
    }
    const record = mapRow(row);
    if (
      record.status === "quarantined" &&
      record.quarantineUntil &&
      Date.parse(record.quarantineUntil) <= this.now().getTime()
    ) {
      return this.write({
        ...record,
        status: "probation",
        consecutiveFailures: 0,
        quarantineUntil: undefined,
        reason: "隔离期已结束，进入观察期",
      });
    }
    return record;
  }

  isAdmitted(profile: ModelProfile): boolean {
    return this.get(profile).status !== "quarantined";
  }

  recordSuccess(profile: ModelProfile): AgentProtocolQualificationRecord {
    const current = this.get(profile);
    const successCount = current.successCount + 1;
    const qualified = successCount >= (this.options.successesToQualify ?? DEFAULT_SUCCESSES_TO_QUALIFY);
    return this.write({
      ...current,
      status: qualified ? "qualified" : "probation",
      successCount,
      consecutiveFailures: 0,
      lastCheckedAt: this.now().toISOString(),
      qualifiedAt: qualified ? current.qualifiedAt ?? this.now().toISOString() : current.qualifiedAt,
      quarantinedAt: undefined,
      quarantineUntil: undefined,
      reason: qualified ? "严格 AgentAction 协议运行验证通过" : "严格协议成功，继续观察",
    });
  }

  recordFailure(profile: ModelProfile, reason: string): AgentProtocolQualificationRecord {
    const current = this.get(profile);
    const consecutiveFailures = current.consecutiveFailures + 1;
    const quarantined =
      consecutiveFailures >=
      (this.options.failuresToQuarantine ?? DEFAULT_FAILURES_TO_QUARANTINE);
    const now = this.now();
    return this.write({
      ...current,
      status: quarantined ? "quarantined" : "probation",
      failureCount: current.failureCount + 1,
      consecutiveFailures,
      lastCheckedAt: now.toISOString(),
      quarantinedAt: quarantined ? now.toISOString() : undefined,
      quarantineUntil: quarantined
        ? new Date(now.getTime() + (this.options.quarantineMs ?? DEFAULT_QUARANTINE_MS)).toISOString()
        : undefined,
      reason,
    });
  }

  list(profiles: readonly ModelProfile[]): AgentProtocolQualificationRecord[] {
    return profiles.map((profile) => this.get(profile));
  }

  private reset(profile: ModelProfile, fingerprint = profileFingerprint(profile)): AgentProtocolQualificationRecord {
    return this.write({
      modelId: profile.id,
      profileFingerprint: fingerprint,
      protocolVersion: PROTOCOL_VERSION,
      status: "unknown",
      successCount: 0,
      failureCount: 0,
      consecutiveFailures: 0,
      reason: "尚未获得真实 AgentAction 运行样本",
    });
  }

  private write(record: AgentProtocolQualificationRecord): AgentProtocolQualificationRecord {
    this.db
      .prepare(
        `INSERT INTO model_agent_protocol_qualification (
           model_id, profile_fingerprint, protocol_version, status, success_count, failure_count,
           consecutive_failures, last_checked_at, qualified_at, quarantined_at, quarantine_until,
           reason, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(model_id) DO UPDATE SET
           profile_fingerprint=excluded.profile_fingerprint,
           protocol_version=excluded.protocol_version,
           status=excluded.status,
           success_count=excluded.success_count,
           failure_count=excluded.failure_count,
           consecutive_failures=excluded.consecutive_failures,
           last_checked_at=excluded.last_checked_at,
           qualified_at=excluded.qualified_at,
           quarantined_at=excluded.quarantined_at,
           quarantine_until=excluded.quarantine_until,
           reason=excluded.reason,
           updated_at=excluded.updated_at`,
      )
      .run(
        record.modelId,
        record.profileFingerprint,
        record.protocolVersion,
        record.status,
        record.successCount,
        record.failureCount,
        record.consecutiveFailures,
        record.lastCheckedAt ?? null,
        record.qualifiedAt ?? null,
        record.quarantinedAt ?? null,
        record.quarantineUntil ?? null,
        record.reason ?? null,
        this.now().toISOString(),
      );
    return record;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

export function profileFingerprint(profile: ModelProfile): string {
  const stable = JSON.stringify({
    id: profile.id,
    provider: profile.provider,
    supportsTools: profile.supportsTools,
    supportsJsonMode: profile.supportsJsonMode,
    declaredCapabilities: profile.declaredCapabilities,
    maxInputTokens: profile.maxInputTokens,
  });
  return createHash("sha256").update(stable).digest("hex");
}

function mapRow(row: Record<string, unknown>): AgentProtocolQualificationRecord {
  return {
    modelId: String(row.model_id),
    profileFingerprint: String(row.profile_fingerprint),
    protocolVersion: Number(row.protocol_version),
    status: String(row.status) as AgentProtocolQualificationStatus,
    successCount: Number(row.success_count),
    failureCount: Number(row.failure_count),
    consecutiveFailures: Number(row.consecutive_failures),
    lastCheckedAt: optionalString(row.last_checked_at),
    qualifiedAt: optionalString(row.qualified_at),
    quarantinedAt: optionalString(row.quarantined_at),
    quarantineUntil: optionalString(row.quarantine_until),
    reason: optionalString(row.reason),
  };
}

function optionalString(value: unknown): string | undefined {
  return value == null ? undefined : String(value);
}
