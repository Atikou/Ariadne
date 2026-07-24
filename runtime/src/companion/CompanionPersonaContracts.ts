import { z } from "zod";

import { CompanionStorageStatusSchema } from "./CompanionSessionContracts.js";

export const CompanionPersonaSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  systemPrompt: z.string().min(1),
  description: z.string().optional(),
  readonly: z.boolean(),
  active: z.boolean(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export type CompanionPersona = z.infer<typeof CompanionPersonaSchema>;

export const CompanionPersonaVersionSchema = z.object({
  id: z.string().min(1),
  personaId: z.string().min(1),
  version: z.number().int().positive(),
  name: z.string().min(1),
  systemPrompt: z.string().min(1),
  description: z.string().optional(),
  createdAt: z.string().datetime(),
}).strict();
export type CompanionPersonaVersion = z.infer<typeof CompanionPersonaVersionSchema>;

export const CompanionPersonaListResultSchema = z.object({
  storage: CompanionStorageStatusSchema,
  personas: z.array(CompanionPersonaSchema),
}).strict();
export type CompanionPersonaListResult = z.infer<typeof CompanionPersonaListResultSchema>;

export const CompanionPersonaDetailResultSchema = z.object({
  storage: CompanionStorageStatusSchema,
  persona: CompanionPersonaSchema,
  versions: z.array(CompanionPersonaVersionSchema),
}).strict();
export type CompanionPersonaDetailResult = z.infer<typeof CompanionPersonaDetailResultSchema>;

export const CompanionPersonaDeleteResultSchema = z.object({
  storage: CompanionStorageStatusSchema,
  personaId: z.string().min(1),
  deleted: z.literal(true),
}).strict();
export type CompanionPersonaDeleteResult = z.infer<typeof CompanionPersonaDeleteResultSchema>;
