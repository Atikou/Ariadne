import type { DatabaseManager } from "./DatabaseManager.js";

export interface RunToolLedgerFacts {
  attemptedShellCalls?: number;
  successfulShellCalls?: number;
  attemptedWriteCalls?: number;
  successfulWriteCalls?: number;
  blockedShellCalls?: number;
  blockedWriteCalls?: number;
}

export interface RunExecutionFacts {
  runId: string;
  goal?: string;
  status?: string;
  completionStatus?: string;
  stopReason?: string;
  toolLedger?: RunToolLedgerFacts;
  guardedAnswer?: string;
  rawModelAnswer?: string;
}

/** 从 runs.result_json 回查副作用与 Guard 事实（旧消息 runId 升级用）。 */
export class RunFactsLookup {
  constructor(private readonly db: DatabaseManager) {}

  get(runId: string | undefined): RunExecutionFacts | null {
    if (!runId?.trim()) return null;
    const row = this.db.connection
      .prepare(`SELECT id, goal, status, result_json FROM runs WHERE id=?`)
      .get(runId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return parseRunRow(row);
  }
}

export function parseRunResultJson(resultJson: string | undefined): {
  executionMeta?: Record<string, unknown>;
  answer?: string;
} | null {
  if (!resultJson?.trim()) return null;
  try {
    const parsed = JSON.parse(resultJson) as {
      executionMeta?: Record<string, unknown>;
      answer?: string;
    };
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function parseRunRow(row: Record<string, unknown>): RunExecutionFacts {
  const runId = String(row.id);
  const parsed = parseRunResultJson(row.result_json ? String(row.result_json) : undefined);
  const meta = parsed?.executionMeta;
  const toolLedger = meta?.toolLedger as RunToolLedgerFacts | undefined;
  return {
    runId,
    goal: row.goal ? String(row.goal) : undefined,
    status: row.status ? String(row.status) : undefined,
    completionStatus: meta?.completionStatus ? String(meta.completionStatus) : undefined,
    stopReason: meta?.stopReason ? String(meta.stopReason) : undefined,
    toolLedger,
    guardedAnswer: meta?.guardedAnswer ? String(meta.guardedAnswer) : undefined,
    rawModelAnswer: meta?.rawModelAnswer ? String(meta.rawModelAnswer) : undefined,
  };
}

export function runFactsIndicateTrustedCompletion(facts: RunExecutionFacts): boolean {
  if (facts.completionStatus === "misleading_completion") return false;
  if (facts.completionStatus === "historical_reference") return false;
  if (facts.completionStatus === "awaiting_permission") return false;
  if (facts.completionStatus === "blocked_by_policy") return false;
  if (facts.completionStatus === "completed_partial") return false;
  if (facts.stopReason === "misleading_completion") return false;
  if (facts.completionStatus === "completed_success") {
    const ledger = facts.toolLedger;
    if (!ledger) return false;
    const shellOk = (ledger.successfulShellCalls ?? 0) > 0;
    const writeOk = (ledger.successfulWriteCalls ?? 0) > 0;
    return shellOk || writeOk;
  }
  if (facts.stopReason === "completed" && facts.completionStatus !== "completed_partial") {
    const ledger = facts.toolLedger;
    if (!ledger) return false;
    return (ledger.successfulShellCalls ?? 0) > 0 || (ledger.successfulWriteCalls ?? 0) > 0;
  }
  return false;
}

export function runFactsIndicateMisleadingCompletion(facts: RunExecutionFacts): boolean {
  return (
    facts.completionStatus === "misleading_completion" ||
    facts.stopReason === "misleading_completion" ||
    (facts.completionStatus === "completed_partial" &&
      Boolean(facts.rawModelAnswer) &&
      !facts.guardedAnswer)
  );
}
