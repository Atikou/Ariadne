import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import {
  AGENT_HANDOFF_SCHEMA_VERSION,
  AgentExecutionOutcomeSchema,
  AgentGrantSchema,
  AgentProposalCreateInputSchema,
  AgentProposalListFilterSchema,
  AgentProposalSchema,
  AgentSessionReadGrantSchema,
  capabilitiesToToolPermissions,
  type AgentCapability,
  type AgentExecutionOutcome,
  type AgentGrant,
  type AgentProposal,
  type AgentProposalCreateInput,
  type AgentProposalListFilter,
  type AgentSessionReadGrant,
} from "./AgentHandoffContracts.js";

export class AgentHandoffValidationError extends Error {
  readonly code = "AGENT_HANDOFF_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "AgentHandoffValidationError";
  }
}

export class AgentHandoffConflictError extends Error {
  readonly code = "AGENT_HANDOFF_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "AgentHandoffConflictError";
  }
}

export class AgentHandoffPersistenceError extends Error {
  readonly code = "AGENT_HANDOFF_PERSISTENCE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "AgentHandoffPersistenceError";
  }
}

interface ProposalRow {
  id: string;
  source_turn_id: string;
  companion_session_id: string | null;
  companion_storage_root: string | null;
  agent_session_id: string | null;
  status: string;
  workspace_key: string;
  grant_id: string | null;
  run_id: string | null;
  payload_json: string;
  created_at: string;
  updated_at: string;
  responded_at: string | null;
}

interface GrantRow {
  id: string;
  proposal_id: string;
  status: string;
  payload_json: string;
  created_at: string;
  consumed_at: string | null;
}

interface SessionReadGrantRow {
  id: string;
  companion_session_id: string;
  workspace_key: string;
  status: string;
  payload_json: string;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

interface SessionLinkRow {
  companion_session_id: string;
  agent_session_id: string;
  workspace_key: string;
  created_at: string;
  updated_at: string;
}

interface CompanionSessionDeletionRow {
  id: string;
  companion_session_id: string;
  storage_root: string | null;
  payload_json: string;
  created_at: string;
}

export type AgentProposalPersistenceCreateInput = AgentProposalCreateInput & {
  companionStorageRoot?: string;
};

export interface CompanionSessionDeletionIntent {
  id: string;
  companionSessionId: string;
  storageRoot?: string;
  createdAt: string;
}

export interface CompanionSessionAccessRetirement {
  deletion: CompanionSessionDeletionIntent;
  revokedSessionReadGrantId?: string;
  rejectedProposalIds: string[];
  removedAgentSessionLink: boolean;
  rollback: {
    companionSessionId: string;
    rejectedProposals: Array<{
      before: AgentProposal;
      retired: AgentProposal;
    }>;
    revokedSessionReadGrant?: {
      before: AgentSessionReadGrant;
      retired: AgentSessionReadGrant;
    };
    removedAgentSessionLink?: SessionLinkRow;
  };
}

const PROPOSAL_SELECT = `
  SELECT id, source_turn_id, companion_session_id, companion_storage_root,
         agent_session_id, status,
         workspace_key, grant_id, run_id, payload_json, created_at, updated_at, responded_at
  FROM assistant_agent_proposals`;

const GRANT_SELECT = `
  SELECT id, proposal_id, status, payload_json, created_at, consumed_at
  FROM assistant_agent_grants`;

const SESSION_READ_GRANT_SELECT = `
  SELECT id, companion_session_id, workspace_key, status, payload_json,
         created_at, updated_at, revoked_at
  FROM assistant_session_read_grants`;

export class AgentHandoffStateCenter {
  constructor(private readonly db: DatabaseSync) {}

  recoverInterrupted(): { failedProposals: number; revokedGrants: number } {
    const rows = this.db.prepare(
      `${PROPOSAL_SELECT} WHERE status IN ('approved', 'executing') ORDER BY created_at`,
    ).all() as unknown as ProposalRow[];
    if (rows.length === 0) return { failedProposals: 0, revokedGrants: 0 };
    return this.transaction(() => {
      let failedProposals = 0;
      let revokedGrants = 0;
      for (const row of rows) {
        const proposal = this.parseProposal(row)!;
        const now = new Date().toISOString();
        const outcome = AgentExecutionOutcomeSchema.parse({
          status: "failed",
          error: "Ariadne 重启前，临时 Agent 未产生可审计终态",
        });
        const failed = AgentProposalSchema.parse({
          ...proposal,
          status: "failed",
          outcome,
          updatedAt: now,
        });
        const changed = this.db.prepare(
          `UPDATE assistant_agent_proposals
           SET status='failed', payload_json=?, updated_at=?
           WHERE id=? AND status=?`,
        ).run(JSON.stringify(failed), now, proposal.id, proposal.status);
        if (Number(changed.changes) !== 1) continue;
        failedProposals += 1;

        if (!proposal.grantId) continue;
        const grant = this.getGrant(proposal.grantId);
        if (!grant || grant.status !== "active") continue;
        const revoked = AgentGrantSchema.parse({ ...grant, status: "revoked" });
        const grantChanged = this.db.prepare(
          `UPDATE assistant_agent_grants
           SET status='revoked', payload_json=?
           WHERE id=? AND status='active'`,
        ).run(JSON.stringify(revoked), grant.id);
        revokedGrants += Number(grantChanged.changes);
      }
      return { failedProposals, revokedGrants };
    });
  }

  create(rawInput: AgentProposalPersistenceCreateInput): AgentProposal {
    const input = parseCreateInput(rawInput);
    const existing = this.getBySourceTurnId(input.sourceTurnId);
    if (existing) {
      if (!sameSubmission(existing, input, this.getCompanionStorageRoot(existing.id))) {
        throw new AgentHandoffConflictError("同一 sourceTurnId 已绑定不同的 Agent 提案");
      }
      return existing;
    }

    const { companionStorageRoot, ...proposalInput } = input;
    const now = new Date().toISOString();
    const proposal = AgentProposalSchema.parse({
      schemaVersion: AGENT_HANDOFF_SCHEMA_VERSION,
      id: randomUUID(),
      ...proposalInput,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    this.db.prepare(
      `INSERT INTO assistant_agent_proposals
       (id, source_turn_id, companion_session_id, companion_storage_root,
        agent_session_id, status, workspace_key,
        grant_id, run_id, payload_json, created_at, updated_at, responded_at)
       VALUES (?, ?, ?, ?, NULL, 'pending', ?, NULL, NULL, ?, ?, ?, NULL)`,
    ).run(
      proposal.id,
      proposal.sourceTurnId,
      proposal.companionSessionId ?? null,
      companionStorageRoot ?? null,
      proposal.workspaceKey,
      JSON.stringify(proposal),
      proposal.createdAt,
      proposal.updatedAt,
    );
    return clone(proposal);
  }

  get(id: string): AgentProposal | null {
    const row = this.db.prepare(`${PROPOSAL_SELECT} WHERE id=?`).get(id) as ProposalRow | undefined;
    return this.parseProposal(row);
  }

  getBySourceTurnId(sourceTurnId: string): AgentProposal | null {
    const normalized = sourceTurnId.trim();
    if (!normalized) return null;
    const row = this.db
      .prepare(`${PROPOSAL_SELECT} WHERE source_turn_id=?`)
      .get(normalized) as ProposalRow | undefined;
    return this.parseProposal(row);
  }

  getByRunId(runId: string): AgentProposal | null {
    const normalized = runId.trim();
    if (!normalized) return null;
    const row = this.db
      .prepare(`${PROPOSAL_SELECT} WHERE run_id=?`)
      .get(normalized) as ProposalRow | undefined;
    return this.parseProposal(row);
  }

  getActiveByAgentSessionId(agentSessionId: string): AgentProposal | null {
    const normalized = agentSessionId.trim();
    if (!normalized) return null;
    const row = this.db.prepare(
      `${PROPOSAL_SELECT}
       WHERE agent_session_id=?
         AND status IN ('approved', 'executing', 'waiting_permission', 'waiting_plan_handoff')
       ORDER BY updated_at DESC
       LIMIT 1`,
    ).get(normalized) as ProposalRow | undefined;
    return this.parseProposal(row);
  }

  getCompanionStorageRoot(proposalId: string): string | undefined {
    const normalized = proposalId.trim();
    if (!normalized) return undefined;
    const row = this.db.prepare(
      `SELECT companion_storage_root FROM assistant_agent_proposals WHERE id=?`,
    ).get(normalized) as { companion_storage_root: string | null } | undefined;
    return row?.companion_storage_root ?? undefined;
  }

  listPending(rawFilter?: AgentProposalListFilter): AgentProposal[] {
    const parsed = AgentProposalListFilterSchema.safeParse(rawFilter ?? {});
    if (!parsed.success) throw new AgentHandoffValidationError("Agent 提案查询参数无效");
    const where = ["status='pending'"];
    const args: SQLInputValue[] = [];
    if (parsed.data.companionSessionId) {
      where.push("companion_session_id=?");
      args.push(parsed.data.companionSessionId);
    }
    const rows = this.db.prepare(
      `${PROPOSAL_SELECT} WHERE ${where.join(" AND ")} ORDER BY updated_at DESC`,
    ).all(...args) as unknown as ProposalRow[];
    return rows.map((row) => this.parseProposal(row)!);
  }

  getGrant(id: string): AgentGrant | null {
    const row = this.db.prepare(`${GRANT_SELECT} WHERE id=?`).get(id) as GrantRow | undefined;
    const grant = this.parseGrant(row);
    if (!grant) return null;
    const proposal = this.get(grant.proposalId);
    if (
      !proposal
      || proposal.grantId !== grant.id
      || proposal.workspaceKey !== grant.workspaceKey
      || !sameStringSet(proposal.requestedScope, grant.allowedScope)
      || grant.allowedCapabilities.some((capability) =>
        !proposal.requestedCapabilities.includes(capability))
    ) {
      throw new AgentHandoffPersistenceError("Agent 授权与提案边界不一致");
    }
    return grant;
  }

  getSessionReadGrant(companionSessionId: string): AgentSessionReadGrant | null {
    const normalized = companionSessionId.trim();
    if (!normalized) return null;
    const row = this.db.prepare(
      `${SESSION_READ_GRANT_SELECT} WHERE companion_session_id=?`,
    ).get(normalized) as SessionReadGrantRow | undefined;
    return this.parseSessionReadGrant(row);
  }

  retireCompanionSession(input: {
    companionSessionId: string;
    storageRoot?: string;
  }): CompanionSessionAccessRetirement {
    const normalized = input.companionSessionId.trim();
    if (!normalized) throw new AgentHandoffValidationError("Companion 会话标识不能为空");
    const storageRoot = input.storageRoot?.trim();
    if (input.storageRoot !== undefined && (!storageRoot || storageRoot.length > 1_024)) {
      throw new AgentHandoffValidationError("Companion 会话删除存储根无效");
    }
    return this.transaction(() => {
      const pending = (this.db.prepare(
        `${PROPOSAL_SELECT} WHERE companion_session_id=? AND status='pending' ORDER BY created_at`,
      ).all(normalized) as unknown as ProposalRow[]).map((row) => this.parseProposal(row)!);
      const sessionReadGrant = this.getSessionReadGrant(normalized);
      const sessionLink = this.db.prepare(
        `SELECT companion_session_id, agent_session_id, workspace_key, created_at, updated_at
         FROM assistant_session_links WHERE companion_session_id=?`,
      ).get(normalized) as SessionLinkRow | undefined;
      const now = new Date().toISOString();
      const rejected = pending.map((proposal) => ({
        before: proposal,
        retired: AgentProposalSchema.parse({
          ...proposal,
          status: "rejected",
          respondedAt: now,
          updatedAt: now,
        }),
      }));
      const revoked = sessionReadGrant?.status === "active"
        ? {
            before: sessionReadGrant,
            retired: AgentSessionReadGrantSchema.parse({
              ...sessionReadGrant,
              status: "revoked",
              updatedAt: now,
              revokedAt: now,
            }),
          }
        : undefined;

      for (const proposal of rejected) {
        const changed = this.db.prepare(
          `UPDATE assistant_agent_proposals
           SET status='rejected', payload_json=?, updated_at=?, responded_at=?
           WHERE id=? AND companion_session_id=? AND status='pending'`,
        ).run(
          JSON.stringify(proposal.retired),
          now,
          now,
          proposal.before.id,
          normalized,
        );
        if (Number(changed.changes) !== 1) {
          throw new AgentHandoffConflictError("Companion 会话待处理提案已发生竞争");
        }
      }
      if (revoked) {
        const changed = this.db.prepare(
          `UPDATE assistant_session_read_grants
           SET status='revoked', payload_json=?, updated_at=?, revoked_at=?
           WHERE id=? AND companion_session_id=? AND status='active'`,
        ).run(
          JSON.stringify(revoked.retired),
          now,
          now,
          revoked.before.id,
          normalized,
        );
        if (Number(changed.changes) !== 1) {
          throw new AgentHandoffConflictError("Companion 会话只读授权已发生竞争");
        }
      }
      const removedLink = this.db.prepare(
        `DELETE FROM assistant_session_links WHERE companion_session_id=?`,
      ).run(normalized);
      if (sessionLink && Number(removedLink.changes) !== 1) {
        throw new AgentHandoffConflictError("Companion 会话 Agent 链接已发生竞争");
      }
      const retirement: CompanionSessionAccessRetirement = {
        deletion: {
          id: randomUUID(),
          companionSessionId: normalized,
          ...(storageRoot ? { storageRoot } : {}),
          createdAt: now,
        },
        ...(revoked ? { revokedSessionReadGrantId: revoked.before.id } : {}),
        rejectedProposalIds: rejected.map((proposal) => proposal.before.id),
        removedAgentSessionLink: Number(removedLink.changes) === 1,
        rollback: {
          companionSessionId: normalized,
          rejectedProposals: rejected,
          ...(revoked ? { revokedSessionReadGrant: revoked } : {}),
          ...(sessionLink ? { removedAgentSessionLink: sessionLink } : {}),
        },
      };
      this.db.prepare(
        `INSERT INTO assistant_companion_session_deletions
         (id, companion_session_id, storage_root, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        retirement.deletion.id,
        normalized,
        retirement.deletion.storageRoot ?? null,
        JSON.stringify(retirement),
        retirement.deletion.createdAt,
      );
      return clone(retirement);
    });
  }

  listPendingCompanionSessionDeletions(): CompanionSessionAccessRetirement[] {
    const rows = this.db.prepare(
      `SELECT id, companion_session_id, storage_root, payload_json, created_at
       FROM assistant_companion_session_deletions ORDER BY created_at`,
    ).all() as unknown as CompanionSessionDeletionRow[];
    return rows.map((row) => this.parseCompanionSessionDeletion(row));
  }

  completeCompanionSessionDeletion(retirement: CompanionSessionAccessRetirement): void {
    this.transaction(() => {
      const deleted = this.db.prepare(
        `DELETE FROM assistant_companion_session_deletions
         WHERE id=? AND companion_session_id=?`,
      ).run(
        retirement.deletion.id,
        retirement.deletion.companionSessionId,
      );
      if (Number(deleted.changes) !== 1) {
        throw new AgentHandoffConflictError("Companion 会话删除意图已发生竞争");
      }
    });
  }

  restoreCompanionSession(retirement: CompanionSessionAccessRetirement): void {
    const rollback = retirement.rollback;
    const normalized = rollback.companionSessionId.trim();
    if (!normalized) {
      throw new AgentHandoffValidationError("Companion 会话访问恢复凭据无效");
    }

    this.transaction(() => {
      for (const proposal of rollback.rejectedProposals) {
        const changed = this.db.prepare(
          `UPDATE assistant_agent_proposals
           SET status=?, payload_json=?, updated_at=?, responded_at=?
           WHERE id=? AND companion_session_id=? AND status='rejected'
             AND payload_json=? AND updated_at=? AND responded_at=?`,
        ).run(
          proposal.before.status,
          JSON.stringify(proposal.before),
          proposal.before.updatedAt,
          proposal.before.respondedAt ?? null,
          proposal.before.id,
          normalized,
          JSON.stringify(proposal.retired),
          proposal.retired.updatedAt,
          proposal.retired.respondedAt ?? null,
        );
        if (Number(changed.changes) !== 1) {
          throw new AgentHandoffConflictError("Companion 会话提案访问恢复发生竞争");
        }
      }

      const grant = rollback.revokedSessionReadGrant;
      if (grant) {
        const changed = this.db.prepare(
          `UPDATE assistant_session_read_grants
           SET status=?, payload_json=?, updated_at=?, revoked_at=?
           WHERE id=? AND companion_session_id=? AND status='revoked'
             AND payload_json=? AND updated_at=? AND revoked_at=?`,
        ).run(
          grant.before.status,
          JSON.stringify(grant.before),
          grant.before.updatedAt,
          grant.before.revokedAt ?? null,
          grant.before.id,
          normalized,
          JSON.stringify(grant.retired),
          grant.retired.updatedAt,
          grant.retired.revokedAt ?? null,
        );
        if (Number(changed.changes) !== 1) {
          throw new AgentHandoffConflictError("Companion 会话只读授权恢复发生竞争");
        }
      }

      const link = rollback.removedAgentSessionLink;
      if (link) {
        const restored = this.db.prepare(
          `INSERT INTO assistant_session_links
           (companion_session_id, agent_session_id, workspace_key, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM assistant_session_links WHERE companion_session_id=?
           )`,
        ).run(
          link.companion_session_id,
          link.agent_session_id,
          link.workspace_key,
          link.created_at,
          link.updated_at,
          normalized,
        );
        if (Number(restored.changes) !== 1) {
          throw new AgentHandoffConflictError("Companion 会话 Agent 链接恢复发生竞争");
        }
      }

      const cleared = this.db.prepare(
        `DELETE FROM assistant_companion_session_deletions
         WHERE id=? AND companion_session_id=?`,
      ).run(retirement.deletion.id, normalized);
      if (Number(cleared.changes) !== 1) {
        throw new AgentHandoffConflictError("Companion 会话删除意图恢复发生竞争");
      }
    });
  }

  reject(id: string): AgentProposal | null {
    const proposal = this.get(id);
    if (!proposal || proposal.status !== "pending") return null;
    const now = new Date().toISOString();
    const updated = AgentProposalSchema.parse({
      ...proposal,
      status: "rejected",
      respondedAt: now,
      updatedAt: now,
    });
    const result = this.db.prepare(
      `UPDATE assistant_agent_proposals
       SET status='rejected', payload_json=?, updated_at=?, responded_at=?
       WHERE id=? AND status='pending'`,
    ).run(JSON.stringify(updated), now, now, id);
    return Number(result.changes) === 1 ? clone(updated) : null;
  }

  approve(input: {
    proposalId: string;
    agentSessionId: string;
    allowedCapabilities: AgentCapability[];
    createSessionReadGrant?: boolean;
  }): {
    proposal: AgentProposal;
    grant: AgentGrant;
    sessionReadGrant?: AgentSessionReadGrant;
  } | null {
    const proposal = this.get(input.proposalId);
    if (!proposal || proposal.status !== "pending") return null;
    assertCapabilitySubset(input.allowedCapabilities, proposal.requestedCapabilities);
    const now = new Date().toISOString();
    const sessionGrant = input.createSessionReadGrant
      ? this.prepareSessionReadGrant(proposal, input.allowedCapabilities, now)
      : undefined;
    const grant = AgentGrantSchema.parse({
      schemaVersion: AGENT_HANDOFF_SCHEMA_VERSION,
      id: randomUUID(),
      proposalId: proposal.id,
      allowedCapabilities: input.allowedCapabilities,
      allowedPermissions: capabilitiesToToolPermissions(input.allowedCapabilities),
      allowedScope: proposal.requestedScope,
      workspaceKey: proposal.workspaceKey,
      expiresAfterRun: true,
      status: "active",
      createdAt: now,
    });
    const updated = AgentProposalSchema.parse({
      ...proposal,
      status: "approved",
      agentSessionId: input.agentSessionId,
      grantId: grant.id,
      respondedAt: now,
      updatedAt: now,
    });

    this.transaction(() => {
      const changed = this.db.prepare(
        `UPDATE assistant_agent_proposals
         SET status='approved', agent_session_id=?, workspace_key=?, grant_id=?,
             payload_json=?, updated_at=?, responded_at=?
         WHERE id=? AND status='pending'`,
      ).run(
        input.agentSessionId,
        proposal.workspaceKey,
        grant.id,
        JSON.stringify(updated),
        now,
        now,
        proposal.id,
      );
      if (Number(changed.changes) !== 1) {
        throw new AgentHandoffConflictError("Agent 提案已被其他响应处理");
      }
      this.db.prepare(
        `INSERT INTO assistant_agent_grants
         (id, proposal_id, status, payload_json, created_at, consumed_at)
         VALUES (?, ?, 'active', ?, ?, NULL)`,
      ).run(grant.id, proposal.id, JSON.stringify(grant), now);
      if (sessionGrant?.insert) {
        const value = sessionGrant.value;
        this.db.prepare(
          `INSERT INTO assistant_session_read_grants
           (id, companion_session_id, workspace_key, status, payload_json,
            created_at, updated_at, revoked_at)
           VALUES (?, ?, ?, 'active', ?, ?, ?, NULL)`,
        ).run(
          value.id,
          value.companionSessionId,
          value.workspaceKey,
          JSON.stringify(value),
          value.createdAt,
          value.updatedAt,
        );
      }
    });
    return {
      proposal: clone(updated),
      grant: clone(grant),
      ...(sessionGrant ? { sessionReadGrant: clone(sessionGrant.value) } : {}),
    };
  }

  private prepareSessionReadGrant(
    proposal: AgentProposal,
    allowedCapabilities: readonly AgentCapability[],
    now: string,
  ): { value: AgentSessionReadGrant; insert: boolean } {
    if (
      !proposal.companionSessionId
      || proposal.risk !== "read-only"
      || proposal.requestedCapabilities.length !== 1
      || proposal.requestedCapabilities[0] !== "file-read"
      || allowedCapabilities.length !== 1
      || allowedCapabilities[0] !== "file-read"
    ) {
      throw new AgentHandoffValidationError(
        "本会话只读授权只适用于绑定 Companion 会话且仅请求 file-read 的提案",
      );
    }
    const existing = this.getSessionReadGrant(proposal.companionSessionId);
    if (existing) {
      if (
        existing.status !== "active"
        || existing.workspaceKey !== proposal.workspaceKey
        || !sameStringSet(existing.allowedScope, proposal.requestedScope)
      ) {
        throw new AgentHandoffConflictError("当前 Companion 会话已有不同边界的只读授权");
      }
      return { value: existing, insert: false };
    }
    return {
      value: AgentSessionReadGrantSchema.parse({
        schemaVersion: AGENT_HANDOFF_SCHEMA_VERSION,
        id: randomUUID(),
        companionSessionId: proposal.companionSessionId,
        workspaceKey: proposal.workspaceKey,
        allowedCapabilities: ["file-read"],
        allowedPermissions: ["read"],
        allowedScope: proposal.requestedScope,
        expiresAfterSession: true,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
      insert: true,
    };
  }

  beginExecution(proposalId: string): { proposal: AgentProposal; grant: AgentGrant } {
    const proposal = this.get(proposalId);
    if (!proposal || proposal.status !== "approved" || !proposal.grantId) {
      throw new AgentHandoffConflictError("Agent 提案未处于可启动状态");
    }
    const grant = this.getGrant(proposal.grantId);
    if (!grant || grant.status !== "active") {
      throw new AgentHandoffConflictError("一次性 Agent 授权不存在或已消费");
    }
    const now = new Date().toISOString();
    const consumed = AgentGrantSchema.parse({
      ...grant,
      status: "consumed",
      consumedAt: now,
    });
    const executing = AgentProposalSchema.parse({
      ...proposal,
      status: "executing",
      updatedAt: now,
    });
    this.transaction(() => {
      const proposalUpdate = this.db.prepare(
        `UPDATE assistant_agent_proposals
         SET status='executing', payload_json=?, updated_at=?
         WHERE id=? AND status='approved'`,
      ).run(JSON.stringify(executing), now, proposal.id);
      const grantUpdate = this.db.prepare(
        `UPDATE assistant_agent_grants
         SET status='consumed', payload_json=?, consumed_at=?
         WHERE id=? AND status='active'`,
      ).run(JSON.stringify(consumed), now, grant.id);
      if (Number(proposalUpdate.changes) !== 1 || Number(grantUpdate.changes) !== 1) {
        throw new AgentHandoffConflictError("一次性 Agent 授权竞争失败");
      }
    });
    return { proposal: clone(executing), grant: clone(consumed) };
  }

  bindExecutionRun(proposalId: string, runId: string): AgentProposal {
    const proposal = this.get(proposalId);
    if (!proposal || proposal.status !== "executing") {
      throw new AgentHandoffConflictError("只有 executing 提案可以绑定 Agent Run");
    }
    if (proposal.runId && proposal.runId !== runId) {
      throw new AgentHandoffConflictError("Agent 提案已经绑定到其他 Run");
    }
    if (proposal.runId === runId) return proposal;
    const now = new Date().toISOString();
    const bound = AgentProposalSchema.parse({
      ...proposal,
      runId,
      updatedAt: now,
    });
    const changed = this.db.prepare(
      `UPDATE assistant_agent_proposals
       SET run_id=?, payload_json=?, updated_at=?
       WHERE id=? AND status='executing' AND run_id IS NULL`,
    ).run(runId, JSON.stringify(bound), now, proposal.id);
    if (Number(changed.changes) !== 1) {
      throw new AgentHandoffConflictError("Agent 提案绑定 Run 时发生竞争");
    }
    return clone(bound);
  }

  settle(input: {
    proposalId: string;
    status: "completed" | "failed";
    runId?: string;
    outcome: AgentExecutionOutcome;
  }): AgentProposal {
    const proposal = this.get(input.proposalId);
    if (!proposal || proposal.status !== "executing") {
      throw new AgentHandoffConflictError("只有 executing 提案可以写入 Agent 结果");
    }
    return this.writeOutcomeTransition(proposal, input, ["executing"]);
  }

  settleActiveRun(input: {
    runId: string;
    status: "completed" | "failed";
    outcome: AgentExecutionOutcome;
  }): AgentProposal | null {
    const proposal = this.getByRunId(input.runId);
    if (!proposal) return null;
    if (
      proposal.status !== "executing"
      && proposal.status !== "waiting_permission"
      && proposal.status !== "waiting_plan_handoff"
    ) {
      throw new AgentHandoffConflictError("只有活动中的 Agent 提案可以接收终态结果");
    }
    return this.writeOutcomeTransition(
      proposal,
      input,
      [proposal.status],
    );
  }

  private writeOutcomeTransition(
    proposal: AgentProposal,
    input: {
      status: "completed" | "failed";
      runId?: string;
      outcome: AgentExecutionOutcome;
    },
    sourceStatuses: AgentProposal["status"][],
  ): AgentProposal {
    const outcome = AgentExecutionOutcomeSchema.parse(input.outcome);
    if (outcome.status !== input.status) {
      throw new AgentHandoffValidationError("提案状态必须与 Agent 结果状态一致");
    }
    if (input.status !== "failed" && !input.runId) {
      throw new AgentHandoffValidationError("非失败结果必须绑定 Agent Run");
    }
    const now = new Date().toISOString();
    const settled = AgentProposalSchema.parse({
      ...proposal,
      status: input.status,
      runId: input.runId,
      outcome,
      updatedAt: now,
    });
    const changed = this.db.prepare(
      `UPDATE assistant_agent_proposals
       SET status=?, run_id=?, payload_json=?, updated_at=?
       WHERE id=? AND status IN (${sourceStatuses.map(() => "?").join(",")})`,
    ).run(
      input.status,
      input.runId ?? null,
      JSON.stringify(settled),
      now,
      proposal.id,
      ...sourceStatuses,
    );
    if (Number(changed.changes) !== 1) {
      throw new AgentHandoffConflictError("Agent 提案结果竞争失败");
    }
    return clone(settled);
  }

  getLinkedAgentSession(companionSessionId: string): {
    agentSessionId: string;
    workspaceKey: string;
  } | null {
    const row = this.db.prepare(
      `SELECT agent_session_id, workspace_key
       FROM assistant_session_links WHERE companion_session_id=?`,
    ).get(companionSessionId) as { agent_session_id: string; workspace_key: string } | undefined;
    return row
      ? { agentSessionId: row.agent_session_id, workspaceKey: row.workspace_key }
      : null;
  }

  linkAgentSession(input: {
    companionSessionId: string;
    agentSessionId: string;
    workspaceKey: string;
  }): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO assistant_session_links
       (companion_session_id, agent_session_id, workspace_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(companion_session_id) DO UPDATE SET
         agent_session_id=excluded.agent_session_id,
         workspace_key=excluded.workspace_key,
         updated_at=excluded.updated_at`,
    ).run(
      input.companionSessionId,
      input.agentSessionId,
      input.workspaceKey,
      now,
      now,
    );
  }

  private parseCompanionSessionDeletion(
    row: CompanionSessionDeletionRow,
  ): CompanionSessionAccessRetirement {
    let raw: unknown;
    try {
      raw = JSON.parse(row.payload_json);
    } catch {
      throw new AgentHandoffPersistenceError("Companion 会话删除意图 JSON 无法解析");
    }
    if (!isRecord(raw) || !isRecord(raw.deletion) || !isRecord(raw.rollback)) {
      throw new AgentHandoffPersistenceError("Companion 会话删除意图载荷无效");
    }

    const deletion: CompanionSessionDeletionIntent = {
      id: requiredString(raw.deletion.id, "Companion 会话删除意图标识"),
      companionSessionId: requiredString(
        raw.deletion.companionSessionId,
        "Companion 会话删除意图会话标识",
      ),
      ...(raw.deletion.storageRoot === undefined
        ? {}
        : {
            storageRoot: requiredString(
              raw.deletion.storageRoot,
              "Companion 会话删除意图存储根",
            ),
          }),
      createdAt: requiredTimestamp(
        raw.deletion.createdAt,
        "Companion 会话删除意图创建时间",
      ),
    };
    if (
      deletion.id !== row.id
      || deletion.companionSessionId !== row.companion_session_id
      || (deletion.storageRoot ?? null) !== row.storage_root
      || deletion.createdAt !== row.created_at
      || raw.rollback.companionSessionId !== deletion.companionSessionId
    ) {
      throw new AgentHandoffPersistenceError("Companion 会话删除意图索引列与载荷不一致");
    }

    if (!Array.isArray(raw.rollback.rejectedProposals)) {
      throw new AgentHandoffPersistenceError("Companion 会话删除提案恢复载荷无效");
    }
    const rejectedProposals = raw.rollback.rejectedProposals.map((entry) => {
      if (!isRecord(entry)) {
        throw new AgentHandoffPersistenceError("Companion 会话删除提案恢复载荷无效");
      }
      const before = parseValue(entry.before, AgentProposalSchema, "Companion 会话删除原提案");
      const retired = parseValue(entry.retired, AgentProposalSchema, "Companion 会话删除退役提案");
      const expected = AgentProposalSchema.parse({
        ...before,
        status: "rejected",
        respondedAt: retired.updatedAt,
        updatedAt: retired.updatedAt,
      });
      if (
        before.status !== "pending"
        || before.companionSessionId !== deletion.companionSessionId
        || JSON.stringify(expected) !== JSON.stringify(retired)
      ) {
        throw new AgentHandoffPersistenceError("Companion 会话删除提案恢复边界无效");
      }
      return { before, retired };
    });

    let revokedSessionReadGrant:
      CompanionSessionAccessRetirement["rollback"]["revokedSessionReadGrant"];
    if (raw.rollback.revokedSessionReadGrant !== undefined) {
      const entry = raw.rollback.revokedSessionReadGrant;
      if (!isRecord(entry)) {
        throw new AgentHandoffPersistenceError("Companion 会话删除授权恢复载荷无效");
      }
      const before = parseValue(
        entry.before,
        AgentSessionReadGrantSchema,
        "Companion 会话删除原授权",
      );
      const retired = parseValue(
        entry.retired,
        AgentSessionReadGrantSchema,
        "Companion 会话删除退役授权",
      );
      const expected = AgentSessionReadGrantSchema.parse({
        ...before,
        status: "revoked",
        updatedAt: retired.updatedAt,
        revokedAt: retired.updatedAt,
      });
      if (
        before.status !== "active"
        || before.companionSessionId !== deletion.companionSessionId
        || JSON.stringify(expected) !== JSON.stringify(retired)
      ) {
        throw new AgentHandoffPersistenceError("Companion 会话删除授权恢复边界无效");
      }
      revokedSessionReadGrant = { before, retired };
    }

    let removedAgentSessionLink: SessionLinkRow | undefined;
    if (raw.rollback.removedAgentSessionLink !== undefined) {
      const link = raw.rollback.removedAgentSessionLink;
      if (!isRecord(link)) {
        throw new AgentHandoffPersistenceError("Companion 会话删除链接恢复载荷无效");
      }
      removedAgentSessionLink = {
        companion_session_id: requiredString(
          link.companion_session_id,
          "Companion 会话删除链接会话标识",
        ),
        agent_session_id: requiredString(
          link.agent_session_id,
          "Companion 会话删除链接 Agent 标识",
        ),
        workspace_key: requiredString(
          link.workspace_key,
          "Companion 会话删除链接工作区",
        ),
        created_at: requiredTimestamp(
          link.created_at,
          "Companion 会话删除链接创建时间",
        ),
        updated_at: requiredTimestamp(
          link.updated_at,
          "Companion 会话删除链接更新时间",
        ),
      };
      if (removedAgentSessionLink.companion_session_id !== deletion.companionSessionId) {
        throw new AgentHandoffPersistenceError("Companion 会话删除链接恢复边界无效");
      }
    }

    const rejectedProposalIds = rejectedProposals.map((entry) => entry.before.id);
    if (
      !Array.isArray(raw.rejectedProposalIds)
      || JSON.stringify(raw.rejectedProposalIds) !== JSON.stringify(rejectedProposalIds)
      || raw.removedAgentSessionLink !== Boolean(removedAgentSessionLink)
      || (
        raw.revokedSessionReadGrantId
        !== revokedSessionReadGrant?.before.id
      )
    ) {
      throw new AgentHandoffPersistenceError("Companion 会话删除恢复摘要与载荷不一致");
    }

    return {
      deletion,
      ...(revokedSessionReadGrant
        ? { revokedSessionReadGrantId: revokedSessionReadGrant.before.id }
        : {}),
      rejectedProposalIds,
      removedAgentSessionLink: Boolean(removedAgentSessionLink),
      rollback: {
        companionSessionId: deletion.companionSessionId,
        rejectedProposals,
        ...(revokedSessionReadGrant ? { revokedSessionReadGrant } : {}),
        ...(removedAgentSessionLink ? { removedAgentSessionLink } : {}),
      },
    };
  }

  private parseProposal(row: ProposalRow | undefined): AgentProposal | null {
    if (!row) return null;
    const proposal = parseJson(row.payload_json, AgentProposalSchema, "Agent 提案");
    const matches = proposal.id === row.id
      && proposal.sourceTurnId === row.source_turn_id
      && (proposal.companionSessionId ?? null) === row.companion_session_id
      && (proposal.agentSessionId ?? null) === row.agent_session_id
      && proposal.status === row.status
      && proposal.workspaceKey === row.workspace_key
      && (proposal.grantId ?? null) === row.grant_id
      && (proposal.runId ?? null) === row.run_id
      && proposal.createdAt === row.created_at
      && proposal.updatedAt === row.updated_at
      && (proposal.respondedAt ?? null) === row.responded_at;
    if (!matches) throw new AgentHandoffPersistenceError("Agent 提案索引列与载荷不一致");
    return clone(proposal);
  }

  private parseGrant(row: GrantRow | undefined): AgentGrant | null {
    if (!row) return null;
    const grant = parseJson(row.payload_json, AgentGrantSchema, "Agent 授权");
    const matches = grant.id === row.id
      && grant.proposalId === row.proposal_id
      && grant.status === row.status
      && grant.createdAt === row.created_at
      && (grant.consumedAt ?? null) === row.consumed_at;
    if (!matches) throw new AgentHandoffPersistenceError("Agent 授权索引列与载荷不一致");
    return clone(grant);
  }

  private parseSessionReadGrant(row: SessionReadGrantRow | undefined): AgentSessionReadGrant | null {
    if (!row) return null;
    const grant = parseJson(
      row.payload_json,
      AgentSessionReadGrantSchema,
      "会话只读授权",
    );
    const matches = grant.id === row.id
      && grant.companionSessionId === row.companion_session_id
      && grant.workspaceKey === row.workspace_key
      && grant.status === row.status
      && grant.createdAt === row.created_at
      && grant.updatedAt === row.updated_at
      && (grant.revokedAt ?? null) === row.revoked_at;
    if (!matches) throw new AgentHandoffPersistenceError("会话只读授权索引列与载荷不一致");
    return clone(grant);
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function parseCreateInput(
  input: AgentProposalPersistenceCreateInput,
): AgentProposalPersistenceCreateInput {
  const { companionStorageRoot, ...proposalInput } = input;
  const parsed = AgentProposalCreateInputSchema.safeParse(proposalInput);
  if (!parsed.success) throw new AgentHandoffValidationError("Agent 提案创建参数无效");
  const storageRoot = companionStorageRoot?.trim();
  if (companionStorageRoot !== undefined && (!storageRoot || storageRoot.length > 1_024)) {
    throw new AgentHandoffValidationError("Companion 存储绑定无效");
  }
  return {
    ...parsed.data,
    ...(storageRoot ? { companionStorageRoot: storageRoot } : {}),
  };
}

function assertCapabilitySubset(
  allowed: readonly AgentCapability[],
  requested: readonly AgentCapability[],
): void {
  if (allowed.length === 0 || allowed.some((capability) => !requested.includes(capability))) {
    throw new AgentHandoffValidationError("批准能力必须是提案请求能力的非空子集");
  }
}

function sameSubmission(
  proposal: AgentProposal,
  input: AgentProposalPersistenceCreateInput,
  storedCompanionStorageRoot: string | undefined,
): boolean {
  return proposal.companionSessionId === input.companionSessionId
    && storedCompanionStorageRoot === input.companionStorageRoot
    && proposal.originalRequest === input.originalRequest
    && proposal.interpretedTask === input.interpretedTask
    && proposal.reason === input.reason
    && proposal.risk === input.risk
    && proposal.workspaceKey === input.workspaceKey
    && JSON.stringify(proposal.modelBinding) === JSON.stringify(input.modelBinding)
    && JSON.stringify(proposal.requestedCapabilities) === JSON.stringify(input.requestedCapabilities)
    && JSON.stringify(proposal.requestedScope) === JSON.stringify(input.requestedScope);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function parseJson<T>(
  payloadJson: string,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  label: string,
): T {
  let raw: unknown;
  try {
    raw = JSON.parse(payloadJson);
  } catch {
    throw new AgentHandoffPersistenceError(`${label}持久化 JSON 无法解析`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new AgentHandoffPersistenceError(`${label}持久化载荷无效`);
  return parsed.data;
}

function parseValue<T>(
  value: unknown,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  label: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AgentHandoffPersistenceError(`${label}载荷无效`);
  return parsed.data;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AgentHandoffPersistenceError(`${label}无效`);
  }
  return value;
}

function requiredTimestamp(value: unknown, label: string): string {
  const timestamp = requiredString(value, label);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new AgentHandoffPersistenceError(`${label}无效`);
  }
  return timestamp;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
