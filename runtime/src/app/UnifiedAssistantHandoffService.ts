import type { AgentHandoffCoordinator } from "../assistant/AgentHandoffCoordinator.js";
import type {
  AgentProposal,
  AgentProposalRespondInput,
} from "../assistant/AgentHandoffContracts.js";
import {
  CompanionAgentProposalSubmissionResultSchema,
  type CompanionAgentProposalSubmission,
  type CompanionAgentProposalSubmissionResult,
} from "../companion/CompanionAgentProposalOutboxContracts.js";
import {
  CompanionAgentResultDeliverySchema,
  type CompanionAgentResultDelivery,
} from "../companion/CompanionAgentResultContracts.js";
import type { CompanionService } from "../companion/CompanionService.js";
import type { CompanionSessionDeleteResult } from "../companion/CompanionSessionContracts.js";
import type { ApiResult } from "../core/apiResult.js";
import { toPublicError } from "../util/publicError.js";
import {
  UnifiedAgentProposalResponseSchema,
  type UnifiedAgentProposalResponse,
} from "./UnifiedAssistantHandoffContracts.js";

export interface UnifiedAssistantHandoffServiceDeps {
  coordinator: Pick<
    AgentHandoffCoordinator,
    "respond"
      | "recordResumedExecution"
      | "getCompanionStorageRoot"
      | "submitFromCompanion"
      | "tryUseSessionReadGrant"
      | "getApplicableSessionReadGrant"
      | "retireCompanionSession"
      | "restoreCompanionSession"
      | "listPendingCompanionSessionDeletions"
      | "completeCompanionSessionDeletion"
  >;
  companion: Pick<
    CompanionService,
    "presentAgentResult" | "deleteSession" | "hasSession" | "rebuildVector"
  >;
}

/** Application boundary joining the one-way Agent state flow to Companion presentation. */
export class UnifiedAssistantHandoffService {
  constructor(private readonly deps: UnifiedAssistantHandoffServiceDeps) {}

  async submitFromCompanion(
    input: CompanionAgentProposalSubmission,
  ): Promise<CompanionAgentProposalSubmissionResult> {
    const created = this.deps.coordinator.submitFromCompanion(input);
    const response = await this.deps.coordinator.tryUseSessionReadGrant(created.id);
    const proposal = response?.proposal ?? created;
    const sessionReadGrant = response?.sessionReadGrant
      ?? this.deps.coordinator.getApplicableSessionReadGrant(proposal.id)
      ?? undefined;
    const companionPresentation = sessionReadGrant && proposal.outcome
      ? await this.deliver(proposal)
      : undefined;
    return CompanionAgentProposalSubmissionResultSchema.parse({
      proposal,
      ...(sessionReadGrant ? { sessionReadGrant } : {}),
      ...(companionPresentation ? { companionPresentation } : {}),
    });
  }

  async respond(
    proposalId: string,
    input: AgentProposalRespondInput,
  ): Promise<UnifiedAgentProposalResponse | null> {
    const response = await this.deps.coordinator.respond(proposalId, input);
    if (!response) return null;
    const companionPresentation = response.proposal.outcome
      ? await this.deliver(response.proposal)
      : undefined;
    return UnifiedAgentProposalResponseSchema.parse({
      ...response,
      ...(companionPresentation ? { companionPresentation } : {}),
    });
  }

  async recordResumedExecution(runId: string, result: ApiResult): Promise<ApiResult> {
    const proposal = this.deps.coordinator.recordResumedExecution(runId, result);
    if (!proposal?.outcome) return result;
    const companionPresentation = await this.deliver(proposal);
    const body = isRecord(result.body)
      ? { ...result.body, companionPresentation }
      : { result: result.body, companionPresentation };
    return { ...result, body };
  }

  async deleteCompanionSession(input: {
    storageRoot?: string;
    sessionId: string;
  }): Promise<CompanionSessionDeleteResult | null> {
    const retirement = this.deps.coordinator.retireCompanionSession({
      companionSessionId: input.sessionId,
      ...(input.storageRoot ? { storageRoot: input.storageRoot } : {}),
    });
    let result: CompanionSessionDeleteResult | null;
    try {
      result = await this.deps.companion.deleteSession(input);
    } catch (deletionError) {
      try {
        this.deps.coordinator.restoreCompanionSession(retirement);
      } catch (restoreError) {
        throw new AggregateError(
          [deletionError, restoreError],
          "companion_session_delete_and_access_restore_failed",
        );
      }
      throw deletionError;
    }
    this.deps.coordinator.completeCompanionSessionDeletion(retirement);
    return result;
  }

  async recoverInterruptedCompanionSessionDeletions(): Promise<{
    restored: number;
    completed: number;
    failed: number;
  }> {
    let restored = 0;
    let completed = 0;
    let failed = 0;
    const missingSessionRetirements: Array<
      ReturnType<AgentHandoffCoordinator["listPendingCompanionSessionDeletions"]>[number]
    > = [];
    for (const retirement of this.deps.coordinator.listPendingCompanionSessionDeletions()) {
      try {
        if (this.deps.companion.hasSession({
          sessionId: retirement.deletion.companionSessionId,
          ...(retirement.deletion.storageRoot
            ? { storageRoot: retirement.deletion.storageRoot }
            : {}),
        })) {
          this.deps.coordinator.restoreCompanionSession(retirement);
          restored += 1;
        } else {
          missingSessionRetirements.push(retirement);
        }
      } catch {
        failed += 1;
      }
    }
    for (const retirement of missingSessionRetirements) {
      try {
        await this.deps.companion.rebuildVector(
          retirement.deletion.storageRoot
            ? { storageRoot: retirement.deletion.storageRoot }
            : undefined,
        );
        this.deps.coordinator.completeCompanionSessionDeletion(retirement);
        completed += 1;
      } catch {
        failed += 1;
      }
    }
    return { restored, completed, failed };
  }

  private async deliver(proposal: AgentProposal): Promise<CompanionAgentResultDelivery> {
    try {
      const companionStorageRoot = this.deps.coordinator.getCompanionStorageRoot(proposal.id);
      if (!companionStorageRoot) throw new Error("companion_agent_result_storage_binding_missing");
      return CompanionAgentResultDeliverySchema.parse(
        await this.deps.companion.presentAgentResult({ proposal, companionStorageRoot }),
      );
    } catch (error) {
      const publicError = toPublicError(error, "主助手未能整理 Agent 结果");
      return CompanionAgentResultDeliverySchema.parse({
        status: "failed",
        outcomeStatus: proposal.outcome?.status ?? "failed",
        code: publicError.code,
        message: publicError.message,
      });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
