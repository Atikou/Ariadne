import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentHandoffStateCenter } from "../src/assistant/AgentHandoffStateCenter.js";
import { UnifiedAssistantHandoffService } from "../src/app/UnifiedAssistantHandoffService.js";
import {
  CompanionService,
  type CompanionPostCommitFailure,
} from "../src/companion/CompanionService.js";
import { CompanionVectorIndex } from "../src/companion/CompanionVectorIndex.js";
import { DatabaseManager } from "../src/context/DatabaseManager.js";

const temporaryRoots: string[] = [];
const closeables: Array<{ close(): void }> = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const closeable of closeables.splice(0)) closeable.close();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Companion session deletion consistency", () => {
  it("restores exactly the Agent access state retired for a failed deletion", () => {
    const root = temporaryRoot("ariadne-access-retirement-");
    const database = new DatabaseManager(root);
    closeables.push(database);
    const state = new AgentHandoffStateCenter(database.connection);
    const sessionId = "companion-session-1";
    const scope = path.join(root, "workspace");

    const grantProposal = state.create(proposalInput({
      sourceTurnId: "turn-grant",
      sessionId,
      scope,
    }));
    const approval = state.approve({
      proposalId: grantProposal.id,
      agentSessionId: "agent-session-1",
      allowedCapabilities: ["file-read"],
      createSessionReadGrant: true,
    });
    expect(approval?.sessionReadGrant).toBeDefined();
    state.linkAgentSession({
      companionSessionId: sessionId,
      agentSessionId: "agent-session-1",
      workspaceKey: "default",
    });
    const pending = state.create(proposalInput({
      sourceTurnId: "turn-pending",
      sessionId,
      scope,
    }));
    const originalGrant = state.getSessionReadGrant(sessionId);
    const originalLink = state.getLinkedAgentSession(sessionId);

    const retirement = state.retireCompanionSession({
      companionSessionId: sessionId,
      storageRoot: path.join(root, "companion"),
    });

    expect(state.get(pending.id)?.status).toBe("rejected");
    expect(state.getSessionReadGrant(sessionId)?.status).toBe("revoked");
    expect(state.getLinkedAgentSession(sessionId)).toBeNull();
    expect(state.listPendingCompanionSessionDeletions()).toEqual([retirement]);

    const persistedRetirement = state.listPendingCompanionSessionDeletions()[0]!;
    state.restoreCompanionSession(persistedRetirement);

    expect(state.get(pending.id)).toEqual(pending);
    expect(state.getSessionReadGrant(sessionId)).toEqual(originalGrant);
    expect(state.getLinkedAgentSession(sessionId)).toEqual(originalLink);
    expect(state.listPendingCompanionSessionDeletions()).toEqual([]);
    expect(() => state.restoreCompanionSession(persistedRetirement)).toThrow(
      "Companion 会话提案访问恢复发生竞争",
    );
  });

  it("restores retired access when authoritative Companion deletion fails", async () => {
    const deletionError = new Error("companion_primary_delete_failed");
    const order: string[] = [];
    const retirement = { rollback: { companionSessionId: "session-1" } };
    const coordinator = {
      retireCompanionSession: vi.fn(() => {
        order.push("retire");
        return retirement;
      }),
      restoreCompanionSession: vi.fn((received) => {
        order.push("restore");
        expect(received).toBe(retirement);
      }),
    };
    const companion = {
      deleteSession: vi.fn(async () => {
        order.push("delete");
        throw deletionError;
      }),
    };
    const service = new UnifiedAssistantHandoffService({
      coordinator: coordinator as never,
      companion: companion as never,
    });

    await expect(service.deleteCompanionSession({ sessionId: "session-1" }))
      .rejects.toBe(deletionError);
    expect(order).toEqual(["retire", "delete", "restore"]);
  });

  it("clears the durable deletion intent after authoritative deletion succeeds", async () => {
    const order: string[] = [];
    const retirement = {
      deletion: {
        id: "deletion-1",
        companionSessionId: "session-1",
        createdAt: new Date().toISOString(),
      },
      rollback: { companionSessionId: "session-1" },
    };
    const service = new UnifiedAssistantHandoffService({
      coordinator: {
        retireCompanionSession: () => {
          order.push("retire");
          return retirement;
        },
        completeCompanionSessionDeletion: (received: unknown) => {
          order.push("complete");
          expect(received).toBe(retirement);
        },
      } as never,
      companion: {
        deleteSession: async () => {
          order.push("delete");
          return null;
        },
      } as never,
    });

    await expect(service.deleteCompanionSession({ sessionId: "session-1" }))
      .resolves.toBeNull();
    expect(order).toEqual(["retire", "delete", "complete"]);
  });

  it("preserves both failures if access restoration also fails", async () => {
    const deletionError = new Error("companion_primary_delete_failed");
    const restoreError = new Error("agent_access_restore_failed");
    const service = new UnifiedAssistantHandoffService({
      coordinator: {
        retireCompanionSession: () => ({ rollback: { companionSessionId: "session-1" } }),
        restoreCompanionSession: () => {
          throw restoreError;
        },
      } as never,
      companion: {
        deleteSession: async () => {
          throw deletionError;
        },
      } as never,
    });

    const failure = await service.deleteCompanionSession({ sessionId: "session-1" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([deletionError, restoreError]);
  });

  it("reports vector cleanup degradation without undoing authoritative deletion", async () => {
    const root = temporaryRoot("ariadne-derived-cleanup-");
    const failures: CompanionPostCommitFailure[] = [];
    const service = new CompanionService({
      projectRoot: root,
      defaultStorageRoot: path.join(root, "companion"),
      directChat: vi.fn() as never,
      onPostCommitFailure: (failure) => failures.push(failure),
    });
    closeables.push(service);
    const created = service.createSession({ title: "Deletion target" });
    const storage = service.storageManager.get();
    const first = storage.createMessage({
      sessionId: created.session.id,
      role: "user",
      content: "first",
    });
    const last = storage.createMessage({
      sessionId: created.session.id,
      role: "assistant",
      content: "last",
    });
    storage.createSummary({
      sessionId: created.session.id,
      sourceMessageStartId: first.id,
      sourceMessageEndId: last.id,
      summary: "derived summary",
    });
    vi.spyOn(CompanionVectorIndex.prototype, "remove")
      .mockRejectedValue(new Error("raw_backend_path_must_not_escape"));

    const result = await service.deleteSession({ sessionId: created.session.id });

    expect(result?.deleted).toBe(true);
    expect(result?.vectors.primary).toMatchObject({
      degraded: true,
      requiresRebuild: true,
    });
    expect(storage.getSession(created.session.id)).toBeNull();
    expect(failures).toEqual([{
      operation: "delete_session_vectors",
      sessionId: created.session.id,
      attemptedEntries: 1,
      failedEntries: 1,
      requiresRebuild: true,
    }]);
    expect(JSON.stringify(failures)).not.toContain("raw_backend_path_must_not_escape");
  });

  it("returns committed deletion and reopens storage when post-commit detach fails", async () => {
    const root = temporaryRoot("ariadne-detach-recovery-");
    const failures: CompanionPostCommitFailure[] = [];
    const service = new CompanionService({
      projectRoot: root,
      defaultStorageRoot: path.join(root, "companion"),
      directChat: vi.fn() as never,
      onPostCommitFailure: (failure) => failures.push(failure),
    });
    closeables.push(service);
    const created = service.createSession({ title: "Detach failure target" });
    const storage = service.storageManager.get();
    service.storageManager.getUnrestrictedMemory();
    const connection = (storage as unknown as {
      db: { exec(sql: string): void };
    }).db;
    const exec = connection.exec.bind(connection);
    vi.spyOn(connection, "exec").mockImplementation((sql: string) => {
      if (sql.startsWith("DETACH DATABASE")) {
        throw new Error("raw_detach_failure_must_not_escape");
      }
      exec(sql);
    });

    const result = await service.deleteSession({ sessionId: created.session.id });

    expect(result?.deleted).toBe(true);
    expect(failures).toEqual([{
      operation: "delete_session_storage_reset",
      sessionId: created.session.id,
      warningCodes: ["unrestricted_memory_detach_failed"],
      storageResetSucceeded: true,
    }]);
    expect(JSON.stringify(failures)).not.toContain("raw_detach_failure_must_not_escape");
    expect(service.storageManager.get().getSession(created.session.id)).toBeNull();
  });

  it("recovers durable deletion intents according to authoritative session existence", async () => {
    const existing = deletionRetirement("existing-session", "deletion-existing");
    const absent = deletionRetirement("absent-session", "deletion-absent");
    const blocked = deletionRetirement("blocked-session", "deletion-blocked");
    const restoreCompanionSession = vi.fn();
    const completeCompanionSessionDeletion = vi.fn();
    const rebuildVector = vi.fn(async () => ({ rebuilt: true }));
    const service = new UnifiedAssistantHandoffService({
      coordinator: {
        listPendingCompanionSessionDeletions: () => [existing, absent, blocked],
        restoreCompanionSession,
        completeCompanionSessionDeletion,
      } as never,
      companion: {
        hasSession: ({ sessionId }: { sessionId: string }) => {
          if (sessionId === "blocked-session") throw new Error("storage_unavailable");
          return sessionId === "existing-session";
        },
        rebuildVector,
      } as never,
    });

    await expect(service.recoverInterruptedCompanionSessionDeletions()).resolves.toEqual({
      restored: 1,
      completed: 1,
      failed: 1,
    });
    expect(restoreCompanionSession).toHaveBeenCalledWith(existing);
    expect(completeCompanionSessionDeletion).toHaveBeenCalledWith(absent);
    expect(rebuildVector).toHaveBeenCalledOnce();
    expect(restoreCompanionSession).not.toHaveBeenCalledWith(blocked);
    expect(completeCompanionSessionDeletion).not.toHaveBeenCalledWith(blocked);
  });
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function proposalInput(input: {
  sourceTurnId: string;
  sessionId: string;
  scope: string;
}) {
  return {
    sourceTurnId: input.sourceTurnId,
    companionSessionId: input.sessionId,
    reason: "read project context",
    originalRequest: "read project context",
    interpretedTask: "read project context",
    requestedCapabilities: ["file-read"] as const,
    requestedScope: [input.scope],
    risk: "read-only" as const,
    workspaceKey: "default",
  };
}

function deletionRetirement(sessionId: string, deletionId: string) {
  return {
    deletion: {
      id: deletionId,
      companionSessionId: sessionId,
      createdAt: new Date().toISOString(),
    },
    rejectedProposalIds: [],
    removedAgentSessionLink: false,
    rollback: {
      companionSessionId: sessionId,
      rejectedProposals: [],
    },
  };
}
