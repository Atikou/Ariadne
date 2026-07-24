import { z } from "zod";

import {
  EmbeddedModelRuntimeSchema,
  ModelRouterProfileSchema,
} from "../../config/types.js";

export const LocalModelManifestSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).optional(),
  displayName: z.string().min(1).optional(),
  runtime: EmbeddedModelRuntimeSchema.optional(),
  modelFile: z.string().min(1).optional(),
  contextSize: z.number().int().positive().optional(),
  gpuLayers: z.union([z.literal("auto"), z.number().int().nonnegative()]).optional(),
  device: z.enum(["auto", "cpu", "cuda", "vulkan"]).optional(),
  maxTokens: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  firstTokenTimeoutMs: z.number().int().positive().optional(),
  tokenIdleTimeoutMs: z.number().int().positive().optional(),
  routerProfile: ModelRouterProfileSchema.optional(),
});

export type LocalModelManifest = z.infer<typeof LocalModelManifestSchema>;
