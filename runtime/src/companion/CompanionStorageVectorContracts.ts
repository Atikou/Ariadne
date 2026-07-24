import { z } from "zod";

import { CompanionStorageStatusSchema } from "./CompanionSessionContracts.js";
import { CompanionVectorStatusSchema } from "./CompanionVectorContracts.js";

export const CompanionStorageStatusResultSchema = z.object({
  storage: CompanionStorageStatusSchema,
}).strict();
export type CompanionStorageStatusResult = z.infer<
  typeof CompanionStorageStatusResultSchema
>;

export const CompanionVectorStatusResultSchema = z.object({
  vector: CompanionVectorStatusSchema,
}).strict();
export type CompanionVectorStatusResult = z.infer<
  typeof CompanionVectorStatusResultSchema
>;

export const CompanionVectorRebuildResultSchema = z.object({
  storages: z.object({
    primary: CompanionStorageStatusSchema,
    unrestrictedMemory: CompanionStorageStatusSchema,
  }).strict(),
  vectors: z.object({
    primary: CompanionVectorStatusSchema,
    unrestrictedMemory: CompanionVectorStatusSchema,
  }).strict(),
}).strict();
export type CompanionVectorRebuildResult = z.infer<
  typeof CompanionVectorRebuildResultSchema
>;
