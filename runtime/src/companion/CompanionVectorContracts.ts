import { z } from "zod";

export const CompanionVectorStatusSchema = z.object({
  enabled: z.boolean(),
  namespace: z.string().min(1),
  provider: z.string().min(1),
  capability: z.enum(["semantic", "lexical_approximation", "test_mock"]).optional(),
  dimension: z.number().int().positive().optional(),
  remoteEnabled: z.boolean().optional(),
  backend: z.enum(["memory", "lancedb"]).optional(),
  persistent: z.boolean().optional(),
  degraded: z.boolean().optional(),
  requiresRebuild: z.boolean().optional(),
  itemCount: z.number().int().nonnegative(),
  retrievedCount: z.number().int().nonnegative().optional(),
  reason: z.string().min(1).optional(),
}).strict();

export type CompanionVectorStatus = z.infer<typeof CompanionVectorStatusSchema>;
