import { z } from 'zod';
import { jsonObjectSchema, userPreferencesSchema } from '@shared/schemas';
import type { UserPreferences } from '@shared/contract';

export const windowBoundsSchema = z
  .object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().min(640).max(16_384),
    height: z.number().int().min(480).max(16_384)
  })
  .strict();

export const windowStateSchema = z
  .object({
    bounds: windowBoundsSchema.nullable(),
    isMaximized: z.boolean()
  })
  .strict();

export const savedLayoutSchema = z
  .object({
    schemaVersion: z.literal(1),
    layout: jsonObjectSchema,
    savedAt: z.string()
  })
  .strict();

export const persistedStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    window: windowStateSchema,
    layout: savedLayoutSchema.nullable(),
    preferences: userPreferencesSchema
  })
  .strict();

export type PersistedState = z.infer<typeof persistedStateSchema>;

export const DEFAULT_PREFERENCES: UserPreferences = {
  runInBackground: true,
  startAtLogin: false,
  theme: 'system',
  suppressAutomaticWakeDuringGames: true,
  gameDetectionRules: []
};

export function createDefaultState(): PersistedState {
  return {
    schemaVersion: 1,
    window: {
      bounds: null,
      isMaximized: false
    },
    layout: null,
    preferences: structuredClone(DEFAULT_PREFERENCES)
  };
}
