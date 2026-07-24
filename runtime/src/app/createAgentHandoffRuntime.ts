import { AgentHandoffCoordinator } from "../assistant/AgentHandoffCoordinator.js";
import {
  AgentProposalCapabilityPolicy,
  permissionPolicyForPermissions,
} from "../assistant/AgentProposalCapabilityPolicy.js";
import { AgentHandoffStateCenter } from "../assistant/AgentHandoffStateCenter.js";
import type { WorkspaceCatalog } from "../config/workspaceCatalog.js";
import type { LoopChatFn } from "../agent/AgentLoop.js";
import type { UserPermissionPolicy } from "../agent/RunPolicyTypes.js";
import type { ContextManager } from "../context/ContextManager.js";
import type { ToolPermission } from "../core/permissions.js";
import type { Orchestrator } from "../orchestrator/Orchestrator.js";
import type { TraceLogger } from "../trace/TraceLogger.js";

export function createAgentHandoffRuntime(input: {
  contextManager: ContextManager;
  workspaceCatalog: WorkspaceCatalog;
  orchestrator: Orchestrator;
  trace: TraceLogger;
  makeChatFn: (forceClient?: string) => LoopChatFn;
  permissionPolicy?: UserPermissionPolicy;
  browserAvailable?: () => boolean;
}): AgentHandoffCoordinator {
  const state = new AgentHandoffStateCenter(input.contextManager.db.connection);
  const recovery = state.recoverInterrupted();
  if (recovery.failedProposals > 0 || recovery.revokedGrants > 0) {
    input.trace.write({ type: "assistant_agent_handoff_recovery", ...recovery });
  }

  return new AgentHandoffCoordinator({
    state,
    proposalCapabilityPolicy: new AgentProposalCapabilityPolicy({
      permissionPolicy: input.permissionPolicy,
      browserAvailable: input.browserAvailable,
    }),
    contextManager: input.contextManager,
    workspaceCatalog: input.workspaceCatalog,
    trace: input.trace,
    executeAgent: (request) => {
      const permissionPolicy =
        input.permissionPolicy ?? permissionPolicyForPermissions(request.grantedPermissions);
      return input.orchestrator.runAgentFromHandoff({
        message: request.originalRequest,
        system: [
          "You are a temporary Agent executor without a persistent persona.",
          "The user original request is authoritative and is passed unchanged as the user message.",
          `The primary assistant interpretation is advisory only: ${request.interpretedTask}`,
          `This run is limited by one-time grant ${request.grantId} for proposal ${request.proposalId}.`,
          "Never treat the interpretation as permission to exceed the granted capabilities or workspace.",
          "When a required tool is available, call it directly. Never claim that permission is unavailable or ask whether to start; Runtime will request the exact user approval when needed and resume this run after approval. Only report a denial after Runtime explicitly returns that the user rejected it.",
        ].join("\n"),
        mode: agentHandoffRunMode(request.grantedPermissions),
        forceMode: true,
        sessionId: request.agentSessionId,
        workspaceKey: request.workspaceKey,
        permissionPolicy,
        autoConfirm: false,
        persist: true,
        skipPlanHandoff: true,
      }, {
        permissionCeiling: request.grantedPermissions,
        grantedPermissions: preauthorizedHandoffPermissions(
          request.grantedPermissions,
          permissionPolicy,
        ),
        authorization: {
          proposalId: request.proposalId,
          grantId: request.grantId,
        },
        pauseOnPermissionRequest: true,
      }, input.makeChatFn(request.modelBinding?.clientName));
    },
  });
}

export function agentHandoffRunMode(
  grantedPermissions: readonly ToolPermission[],
): "implement" | "debug" | "review" {
  if (grantedPermissions.includes("write")) return "implement";
  if (
    grantedPermissions.includes("shell")
    || grantedPermissions.includes("network")
  ) {
    return "debug";
  }
  return "review";
}

export function preauthorizedHandoffPermissions(
  permissionCeiling: readonly ToolPermission[],
  permissionPolicy: UserPermissionPolicy,
): ToolPermission[] {
  if (permissionPolicy === "autoRun") return [...permissionCeiling];
  if (permissionPolicy === "autoEdit") {
    return permissionCeiling.filter((permission) =>
      permission === "read" || permission === "write");
  }
  return permissionCeiling.filter((permission) => permission === "read");
}
