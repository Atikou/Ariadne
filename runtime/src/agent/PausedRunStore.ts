import type { DatabaseSync } from "node:sqlite";

import type { ChatMessage } from "../model/types.js";
import type { AgentToolStep } from "./toolStep.js";
import type {
  AgentRunMode,
  AgentWorkflowDebugAnalysis,
  AgentWorkflowInternalPlan,
  AgentWorkflowProposal,
  AgentWorkflowRefactorPlan,
  UserPermissionPolicy,
} from "./RunPolicyTypes.js";
import type { AgentIntentType, AgentWorkflowType } from "./IntentTypes.js";
import type { CapabilityEscalationRecord } from "./CapabilityEscalation.js";
import type { BudgetLedgerSnapshot } from "./BudgetManager.js";
import type { CachedToolResult } from "./recovery/RunToolResultCache.js";
import type { CompletionCriterionInput } from "./completion/TaskCompletionContract.js";
import type { ToolPermission } from "../core/permissions.js";

export interface AgentHandoffAuthorizationContext {
  proposalId: string;
  grantId: string;
}

export interface FailedActionMemoryState {
  tool: string;
  inputKey: string;
  outcomeKind: string;
  path?: string;
  executedCount: number;
  blockedCount: number;
  lastMessage: string;
}

export interface PausedRunRuntimeState {
  entryIntent?: AgentIntentType;
  entryWorkflowType?: AgentWorkflowType;
  reconciledIntent?: AgentIntentType;
  reconciledWorkflowType?: AgentWorkflowType;
  capabilityEscalations?: CapabilityEscalationRecord[];
  budgetLedger?: BudgetLedgerSnapshot;
  failedActionMemoryState?: FailedActionMemoryState[];
  toolCacheEntries?: CachedToolResult[];
}

/**
 * 暂停中的 Agent Run 对话快照。
 *
 * 第一性原则：权限暂停不是“结束本轮 + 下次重新喊话”，而是“就地冻结同一段对话”。
 * 用户批准后用这份快照忠实地继续：要么执行那个被批准的工具，要么按已批准计划进入执行阶段，
 * 全程复用同一条 `messages` 链，不再合成假的用户续跑消息、也不再用正则去猜权限。
 */
export interface PausedRunSnapshot {
  runId: string;
  sessionId?: string;
  /** 本轮真实目标（用户原始消息）。 */
  goal: string;
  system?: string;
  /** 暂停时刻的完整对话消息链（含模型发起工具调用的那条 assistant 消息，不含被阻塞工具的结果）。 */
  messages: ChatMessage[];
  /** 已完成的工具步骤（不含被阻塞的那一步）。 */
  steps: AgentToolStep[];
  /** 暂停前已生成的工作流产物；恢复时用于保持写入门禁状态一致。 */
  workflowProposals?: AgentWorkflowProposal[];
  workflowDebugAnalyses?: AgentWorkflowDebugAnalysis[];
  workflowRefactorPlans?: AgentWorkflowRefactorPlan[];
  workflowInternalPlans?: AgentWorkflowInternalPlan[];
  /** 暂停前由可信任务层注入的验收合同，恢复后不得丢失或由客户端覆盖。 */
  completionCriteria?: CompletionCriterionInput[];
  /** 暂停时已用的模型轮次。 */
  modelTurns: number;
  /** 工具级 JIT 暂停：被阻塞、待批准后执行的工具调用。 */
  pendingAction?: { tool: string; input?: Record<string, unknown> };
  /** 原始运行模式（工具级续跑沿用）。 */
  mode: AgentRunMode;
  /** 原始权限策略（工具级续跑沿用）。 */
  permissionPolicy: UserPermissionPolicy;
  /** 暂停前已经过全部上限求交集的权限集合；恢复时只能继续缩小，禁止重新放大。 */
  permissionCeiling?: ToolPermission[];
  /** Server-issued Run grant preserved across an exact permission pause. */
  runGrantedPermissions?: ToolPermission[];
  /** 由后端签发的统一助手提案关联；用户请求体不能构造。 */
  handoffAuthorization?: AgentHandoffAuthorizationContext;
  /** 计划→执行交接：恢复后切换到的模式（一般为 implement）。 */
  resumeMode?: AgentRunMode;
  /** 暂停时的运行时状态（escalation / 预算 / 缓存 / 熔断）。 */
  runtimeState?: PausedRunRuntimeState;
  createdAt: string;
}

/** 暂停 Run 快照存储。传入数据库时持久化到 memory.db；否则使用进程内 Map。 */
export class PausedRunStore {
  private readonly snapshots = new Map<string, PausedRunSnapshot>();

  constructor(private readonly db?: DatabaseSync) {}

  usesConnection(db: DatabaseSync): boolean {
    return this.db === db;
  }

  save(snapshot: PausedRunSnapshot): void {
    if (this.db) {
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO paused_run_snapshots
           (run_id, session_id, status, snapshot_json, created_at, updated_at)
           VALUES (?, ?, 'paused', ?, ?, ?)
           ON CONFLICT(run_id) DO UPDATE SET
             session_id=excluded.session_id,
             status='paused',
             snapshot_json=excluded.snapshot_json,
             updated_at=excluded.updated_at`,
        )
        .run(
          snapshot.runId,
          snapshot.sessionId ?? null,
          JSON.stringify(snapshot),
          snapshot.createdAt || now,
          now,
        );
      return;
    }
    this.snapshots.set(snapshot.runId, snapshot);
  }

  get(runId: string): PausedRunSnapshot | null {
    if (this.db) {
      const row = this.db
        .prepare(
          `SELECT snapshot_json FROM paused_run_snapshots
           WHERE run_id=? AND status='paused'`,
        )
        .get(runId) as { snapshot_json: string } | undefined;
      return this.parseSnapshot(row);
    }
    return this.snapshots.get(runId) ?? null;
  }

  /** 取出并移除：恢复开始时调用，避免对同一快照重复续跑。 */
  take(runId: string): PausedRunSnapshot | null {
    if (this.db) {
      const snapshot = this.get(runId);
      if (snapshot) this.delete(runId);
      return snapshot;
    }
    const snapshot = this.snapshots.get(runId);
    if (snapshot) this.snapshots.delete(runId);
    return snapshot ?? null;
  }

  delete(runId: string): void {
    if (this.db) {
      this.db.prepare(`DELETE FROM paused_run_snapshots WHERE run_id=?`).run(runId);
      return;
    }
    this.snapshots.delete(runId);
  }

  /** 会话是否仍有未恢复的暂停快照（含已批准待 resume 的场景）。 */
  hasPausedForSession(sessionId: string): boolean {
    return this.getFirstPausedRunIdForSession(sessionId) != null;
  }

  getFirstPausedRunIdForSession(sessionId: string): string | null {
    if (this.db) {
      const row = this.db
        .prepare(
          `SELECT run_id FROM paused_run_snapshots
           WHERE session_id=? AND status='paused'
           ORDER BY updated_at DESC
           LIMIT 1`,
        )
        .get(sessionId) as { run_id: string } | undefined;
      return row?.run_id ?? null;
    }
    for (const snapshot of this.snapshots.values()) {
      if (snapshot.sessionId === sessionId) return snapshot.runId;
    }
    return null;
  }

  private parseSnapshot(row: { snapshot_json: string } | undefined): PausedRunSnapshot | null {
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.snapshot_json) as PausedRunSnapshot;
      if (!parsed || typeof parsed !== "object" || typeof parsed.runId !== "string") return null;
      return parsed;
    } catch {
      return null;
    }
  }
}

export const defaultPausedRunStore = new PausedRunStore();
