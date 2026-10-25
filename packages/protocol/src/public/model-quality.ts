import { z } from 'zod';
import { PUBLIC_PROJECTION_CONTRACT_VERSION, publicProjectionCanonicalIdSchema } from './projection.js';
import { modelQualitySummarySchema } from './model-quality-summary.js';
export { modelQualitySummarySchema, type ModelQualitySummary } from './model-quality-summary.js';

export const modelQualityCommandSchema = z.object({kind:z.literal('model.quality.evaluate'),
  contractVersion:z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),modelId:publicProjectionCanonicalIdSchema}).strict();
export const modelQualityResultSchema = z.object({kind:z.literal('model.quality.completed'),
  modelId:publicProjectionCanonicalIdSchema,quality:modelQualitySummarySchema}).strict();
