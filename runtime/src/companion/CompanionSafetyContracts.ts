import { z } from "zod";

import { CompanionOutputModeSchema } from "./CompanionMemoryContracts.js";

export const CompanionSafetyResultSchema = z.object({
  content: z.string(),
  rewritten: z.boolean(),
  flags: z.array(z.string()),
  attachmentRisk: z.enum(["low", "medium", "high", "critical"]),
  realityAnchored: z.boolean(),
  virtualIdentitySafe: z.boolean(),
  warmEnough: z.boolean(),
  outputMode: CompanionOutputModeSchema,
}).strict();
export type CompanionSafetyResult = z.infer<typeof CompanionSafetyResultSchema>;
