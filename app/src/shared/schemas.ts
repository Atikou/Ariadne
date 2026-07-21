import { z } from 'zod';
import type { JsonObject, JsonValue } from './contract';
import { SYSTEM_CAPABILITIES } from './contract';

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
);

export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);

export const saveLayoutRequestSchema = z
  .object({
    layout: jsonObjectSchema
  })
  .strict();

export const clipboardWriteRequestSchema = z
  .object({
    text: z.string().min(1).max(256 * 1024)
  })
  .strict();

export const gameDetectionRuleSchema = z
  .object({
    id: z.string().min(1).max(100),
    kind: z.enum(['process-name', 'process-path', 'foreground-fullscreen']),
    pattern: z.string().max(500),
    action: z.enum(['suppress', 'allow']),
    enabled: z.boolean()
  })
  .strict();

export const userPreferencesSchema = z
  .object({
    runInBackground: z.boolean(),
    startAtLogin: z.boolean(),
    theme: z.enum(['system', 'dark', 'light']),
    suppressAutomaticWakeDuringGames: z.boolean(),
    gameDetectionRules: z.array(gameDetectionRuleSchema).max(500)
  })
  .strict();

export const showWindowRequestSchema = z
  .object({
    source: z.enum(['user', 'shortcut', 'voice', 'system']),
    allowTemporaryTopmost: z.boolean()
  })
  .strict();

export const titleBarThemeSchema = z.enum(['dark', 'light']);

export const systemCapabilitySchema = z.enum(SYSTEM_CAPABILITIES);

const terminalSessionIdSchema = z.string().uuid();
const terminalColumnsSchema = z.number().int().min(2).max(500);
const terminalRowsSchema = z.number().int().min(1).max(300);

export const createTerminalSessionRequestSchema = z
  .object({
    sessionId: terminalSessionIdSchema,
    shell: z.enum(['powershell', 'cmd']),
    columns: terminalColumnsSchema,
    rows: terminalRowsSchema
  })
  .strict();

export const writeTerminalRequestSchema = z
  .object({
    sessionId: terminalSessionIdSchema,
    data: z.string().max(64 * 1024)
  })
  .strict();

export const resizeTerminalRequestSchema = z
  .object({
    sessionId: terminalSessionIdSchema,
    columns: terminalColumnsSchema,
    rows: terminalRowsSchema
  })
  .strict();

export const closeTerminalRequestSchema = z
  .object({ sessionId: terminalSessionIdSchema })
  .strict();

export const workspaceDirectoryRequestSchema = z
  .object({
    relativePath: z.string().max(2_000).refine((value) => {
      if (value === '') return true;
      if (value.includes('\\') || value.startsWith('/') || value.endsWith('/')) return false;
      return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
    }, 'Workspace path must be a normalized relative path.')
  })
  .strict();
