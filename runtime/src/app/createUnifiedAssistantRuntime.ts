import type { WorkspaceCatalog } from "../config/workspaceCatalog.js";
import type { UserPermissionPolicy } from "../agent/RunPolicyTypes.js";
import { CompanionService, type CompanionServiceDeps } from "../companion/CompanionService.js";
import type { ContextManager } from "../context/ContextManager.js";
import type { Orchestrator } from "../orchestrator/Orchestrator.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import { createAgentHandoffRuntime } from "./createAgentHandoffRuntime.js";
import { UnifiedAssistantHandoffService } from "./UnifiedAssistantHandoffService.js";

export function createUnifiedAssistantRuntime(input: {
  projectRoot: string;
  companionDataDir: string;
  directChat: CompanionServiceDeps["directChat"];
  contextManager: ContextManager;
  workspaceCatalog: WorkspaceCatalog;
  orchestrator: Orchestrator;
  trace: TraceLogger;
  permissionPolicy?: UserPermissionPolicy;
}) {
  const agentHandoffCoordinator = createAgentHandoffRuntime(input);
  let companionService: CompanionService | undefined;
  const unifiedAssistantHandoffService = new UnifiedAssistantHandoffService({
    coordinator: agentHandoffCoordinator,
    companion: {
      presentAgentResult: (result) => {
        if (!companionService) throw new Error("unified_companion_service_not_ready");
        return companionService.presentAgentResult(result);
      },
      deleteSession: (request) => {
        if (!companionService) throw new Error("unified_companion_service_not_ready");
        return companionService.deleteSession(request);
      },
      hasSession: (request) => {
        if (!companionService) throw new Error("unified_companion_service_not_ready");
        return companionService.hasSession(request);
      },
      rebuildVector: (request) => {
        if (!companionService) throw new Error("unified_companion_service_not_ready");
        return companionService.rebuildVector(request);
      },
    },
  });
  companionService = new CompanionService({
    projectRoot: input.projectRoot,
    defaultStorageRoot: input.companionDataDir,
    directChat: input.directChat,
    proposeAgentHandoff: (submission) =>
      unifiedAssistantHandoffService.submitFromCompanion(submission),
    onPostCommitFailure: (failure) => {
      input.trace.write({
        type: "companion_session_delete_post_commit_failure",
        ...failure,
      });
    },
  });
  companionService.start();
  void unifiedAssistantHandoffService.recoverInterruptedCompanionSessionDeletions()
    .then((deletionRecovery) => {
      if (
        deletionRecovery.restored > 0
        || deletionRecovery.completed > 0
        || deletionRecovery.failed > 0
      ) {
        input.trace.write({
          type: "companion_session_deletion_recovery",
          ...deletionRecovery,
        });
      }
    })
    .catch(() => {
      input.trace.write({
        type: "companion_session_deletion_recovery",
        restored: 0,
        completed: 0,
        failed: 1,
        persistenceInvalid: true,
      });
    });
  return {
    agentHandoffCoordinator,
    companionService,
    unifiedAssistantHandoffService,
  };
}
