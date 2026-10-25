import { z } from 'zod';
import { publicProjectionCanonicalIdSchema } from './projection.js';
import { modelQualitySummarySchema } from './stored-model-quality-summary.js';
export { modelQualitySummarySchema, type ModelQualitySummary } from './stored-model-quality-summary.js';

/** Released command journals retain this result; no current command creates it. */
export const modelQualityResultSchema = z.object({kind:z.literal('model.quality.completed'),
  modelId:publicProjectionCanonicalIdSchema,quality:modelQualitySummarySchema}).strict();
