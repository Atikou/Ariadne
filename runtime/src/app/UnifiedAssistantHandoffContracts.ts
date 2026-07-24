import { z } from "zod";

import {
  AgentProposalResponseShape,
  addAgentProposalResponseIssues,
} from "../assistant/AgentHandoffContracts.js";
import { CompanionAgentResultDeliverySchema } from "../companion/CompanionAgentResultContracts.js";

export const UnifiedAgentProposalResponseSchema = z.object({
  ...AgentProposalResponseShape,
  companionPresentation: CompanionAgentResultDeliverySchema.optional(),
}).strict().superRefine((response, ctx) => {
  addAgentProposalResponseIssues(response, ctx);
});
export type UnifiedAgentProposalResponse = z.infer<
  typeof UnifiedAgentProposalResponseSchema
>;
