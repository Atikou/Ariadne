import { toPublicError } from "../util/publicError.js";
import {
  CompanionAgentProposalSubmissionResultSchema,
  type CompanionAgentProposalSubmission,
  type CompanionAgentProposalSubmissionResult,
} from "./CompanionAgentProposalOutboxContracts.js";
import type { CompanionStorage } from "./CompanionStorage.js";
import type { CompanionMessage } from "./types.js";

export interface CompanionAgentProposalDelivery extends CompanionAgentProposalSubmissionResult {
  assistantMessage: CompanionMessage;
}

export class CompanionAgentProposalDeliveryPendingError extends Error {
  readonly code = "COMPANION_AGENT_PROPOSAL_DELIVERY_PENDING";

  constructor() {
    super("Agent 授权提案已安全保存，正在等待后端恢复投递");
    this.name = "CompanionAgentProposalDeliveryPendingError";
  }
}

/** Dispatches durable Companion outbox entries into the idempotent Agent proposal state center. */
export class CompanionAgentProposalOutboxDispatcher {
  constructor(
    private readonly deliver: (
      input: CompanionAgentProposalSubmission,
    ) => CompanionAgentProposalSubmissionResult | Promise<CompanionAgentProposalSubmissionResult>,
  ) {}

  async dispatch(storage: CompanionStorage, outboxId: string): Promise<CompanionAgentProposalDelivery> {
    const claim = storage.claimAgentProposalOutbox(outboxId);
    if (claim.status === "delivered") {
      const delivered = CompanionAgentProposalSubmissionResultSchema.parse(await this.deliver({
        ...claim.entry.payload,
        companionStorageRoot: storage.storageRoot,
      }));
      if (delivered.proposal.id !== claim.entry.proposalId) {
        throw new Error("companion_agent_proposal_outbox_delivered_identity_conflict");
      }
      return { ...delivered, assistantMessage: claim.entry.assistantMessage };
    }
    if (claim.status === "in_progress") {
      throw new CompanionAgentProposalDeliveryPendingError();
    }
    try {
      const delivered = CompanionAgentProposalSubmissionResultSchema.parse(await this.deliver({
        ...claim.entry.payload,
        companionStorageRoot: storage.storageRoot,
      }));
      const completed = storage.completeAgentProposalOutbox(outboxId, delivered.proposal);
      return { ...delivered, assistantMessage: completed.assistantMessage };
    } catch (error) {
      const publicError = toPublicError(error, "Agent 提案投递失败");
      try {
        storage.failAgentProposalOutbox(outboxId, publicError.code);
      } catch {
        // A stale dispatching row is recovered on the next storage open.
      }
      throw new CompanionAgentProposalDeliveryPendingError();
    }
  }

  async recover(storage: CompanionStorage): Promise<void> {
    const ids = storage.listRecoverableAgentProposalOutboxIds(50);
    for (const id of ids) {
      try {
        await this.dispatch(storage, id);
      } catch {
        // Access-time recovery is best-effort; each entry remains durable and retryable.
      }
    }
  }
}
