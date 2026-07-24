import { z } from "zod";

const boundedText = (max: number) => z.string().trim().min(1).max(max);

export const AgentCapabilitySchema = z.enum([
  "file-read",
  "file-write",
  "browser",
  "shell",
]);
export type AgentCapability = z.infer<typeof AgentCapabilitySchema>;

export const AgentCapabilityListSchema = z.array(AgentCapabilitySchema)
  .min(1)
  .max(4)
  .superRefine((items, ctx) => {
    if (new Set(items).size !== items.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "能力不能重复" });
    }
  });

export const AgentProposalRiskSchema = z.enum(["read-only", "write", "destructive"]);
export type AgentProposalRisk = z.infer<typeof AgentProposalRiskSchema>;

/**
 * Non-executable model output. Source identity, original text, workspace and scope
 * are deliberately absent so only the backend can bind them to a real turn.
 */
export const AgentProposalDraftStructuralSchema = z.object({
  reason: boundedText(2_000),
  interpretedTask: boundedText(8_000),
  requestedCapabilities: AgentCapabilityListSchema,
  risk: AgentProposalRiskSchema,
}).strict();
export type AgentProposalDraft = z.infer<typeof AgentProposalDraftStructuralSchema>;

export function addAgentProposalDraftBusinessIssues(
  proposal: AgentProposalDraft,
  ctx: z.RefinementCtx,
): void {
  if (
    proposal.risk === "read-only"
    && proposal.requestedCapabilities.some((capability) =>
      capability === "file-write" || capability === "shell")
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "包含写入或命令能力的提案不能声明为只读风险",
      path: ["risk"],
    });
  }
}

export const AgentProposalDraftSchema = AgentProposalDraftStructuralSchema
  .superRefine(addAgentProposalDraftBusinessIssues);
