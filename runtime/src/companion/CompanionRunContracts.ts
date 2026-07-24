import { z } from "zod";

export const CompanionRunCancelResultSchema = z.object({
  runId: z.string().min(1),
  cancelled: z.boolean(),
}).strict();

export type CompanionRunCancelResult = z.infer<typeof CompanionRunCancelResultSchema>;
