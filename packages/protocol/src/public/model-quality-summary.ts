import { z } from 'zod';
import { canonicalUtcTimestampSchema } from '../common.js';

/** A reproducible small benchmark, not a claim about general intelligence. */
export const modelQualitySummarySchema = z.object({
  benchmarkId: z.literal('ariadne-text-quality-v1'), benchmarkDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  score: z.number().min(0).max(1), passed: z.number().int().min(0).max(6), total: z.literal(6),
  evaluatedAt: canonicalUtcTimestampSchema, validUntil: canonicalUtcTimestampSchema, state: z.enum(['current','expired'])
}).strict().superRefine((value,context)=>{
  if(value.score!==value.passed/value.total || Date.parse(value.validUntil)<=Date.parse(value.evaluatedAt)) {
    context.addIssue({code:'custom',message:'Quality score and time range must match the measured sample.'});
  }
});
export type ModelQualitySummary = z.infer<typeof modelQualitySummarySchema>;
