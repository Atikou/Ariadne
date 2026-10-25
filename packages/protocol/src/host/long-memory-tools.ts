import { z } from 'zod';
import { publicProjectionCanonicalIdSchema } from '../public/projection.js';
import { longMemoryContentSchema } from '../public/long-memory.js';

export const memoryRecallToolInputSchema = z.object({ query: z.string().trim().min(1).max(4_000), limit: z.number().int().min(1).max(10) }).strict();
export const memoryReadToolInputSchema = z.object({ memoryId: publicProjectionCanonicalIdSchema }).strict();
export const memoryCandidateToolInputSchema = longMemoryContentSchema.extend({ scope: z.enum(['workspace', 'session']) });
export const memoryToolRequestSchema = z.discriminatedUnion('toolName', [
  z.object({ toolName: z.literal('memory.recall'), input: memoryRecallToolInputSchema }).strict(),
  z.object({ toolName: z.literal('memory.read'), input: memoryReadToolInputSchema }).strict(),
  z.object({ toolName: z.literal('memory.stage_candidate'), input: memoryCandidateToolInputSchema }).strict()
]);
export type MemoryToolRequest = z.infer<typeof memoryToolRequestSchema>;
