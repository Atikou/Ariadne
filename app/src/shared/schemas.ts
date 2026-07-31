import { z } from 'zod';
import { modelInferenceProfileSchema } from '@ariadne/protocol/public';
import { runtimePolicySnapshotSchema } from '@ariadne/protocol/settings';
import type { JsonObject, JsonValue } from './contract';
import {
  AGENT_APPROVAL_POLICIES,
  AGENT_PERMISSION_MODES,
  AGENT_PROVIDER_IDS,
  AGENT_SANDBOX_MODES,
  AGENT_TOOL_PERMISSIONS,
  SYSTEM_CAPABILITIES
} from './contract';

export const agentProviderIdSchema = z.enum(AGENT_PROVIDER_IDS);

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

export const agentRoutingStrategySchema = z.enum([
  'local-first',
  'cloud-first',
  'privacy-first',
  'quality-first'
]);

const absolutePathSchema = z.string().trim().min(1).max(32_768).refine(
  (value) => /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value),
  '模型目录必须使用绝对路径。'
);

const httpsUrlSchema = z.string().trim().url().max(2_048).refine(
  (value) => new URL(value).protocol === 'https:',
  '远程模型地址必须使用 HTTPS。'
);

const agentProviderSettingsUpdateSchema = z
  .object({
    enabled: z.boolean(),
    baseUrl: httpsUrlSchema,
    model: z.string().trim().min(1).max(256),
    inference: modelInferenceProfileSchema,
    apiKey: z.string().trim().min(8).max(8_192).optional(),
    clearApiKey: z.boolean()
  })
  .strict()
  .refine((value) => !(value.apiKey && value.clearApiKey), '不能同时替换和清除 API Key。');

export const agentSettingsUpdateSchema = z
  .object({
    routingStrategy: agentRoutingStrategySchema,
    permissionMode: z.enum(AGENT_PERMISSION_MODES),
    customPermissions: z.object({
      approvalPolicy: z.enum(AGENT_APPROVAL_POLICIES),
      sandboxMode: z.enum(AGENT_SANDBOX_MODES),
      allowedPermissions: z.array(z.enum(AGENT_TOOL_PERMISSIONS)).min(1).max(5)
    }).strict(),
    workspaceRoot: absolutePathSchema,
    workspaceAccess: z.enum(['read', 'write']),
    localModelRoots: z.array(absolutePathSchema).max(8),
    providers: z.record(agentProviderIdSchema, agentProviderSettingsUpdateSchema),
    runtimePolicy: runtimePolicySnapshotSchema.optional()
  })
  .strict();

export const agentWorkspaceRequestSchema = z.object({
  workspaceId: z.string().trim().min(1).max(128)
}).strict();

export const agentWorkspacePinUpdateSchema = agentWorkspaceRequestSchema.extend({
  pinned: z.boolean()
}).strict();

export const apiKeyStatusSchema = z.enum(['missing', 'configured', 'unavailable']);

const agentProviderSettingsViewSchema = z.object({
  enabled: z.boolean(),
  baseUrl: httpsUrlSchema,
  model: z.string().trim().min(1).max(256),
  inference: modelInferenceProfileSchema,
  apiKeyStatus: apiKeyStatusSchema
}).strict();

const agentWorkspaceSettingsViewSchema = z.object({
  workspaceId: z.string().trim().min(1).max(128),
  rootPath: absolutePathSchema,
  access: z.enum(['read', 'write']),
  pinned: z.boolean().optional(),
  archivedAt: z.string().datetime().optional(),
  purgeAfter: z.string().datetime().optional(),
  purgedAt: z.string().datetime().optional()
}).strict();

export const agentSettingsViewSchema = z.object({
  schemaVersion: z.literal(2),
  routingStrategy: agentRoutingStrategySchema,
  permissionMode: z.enum(AGENT_PERMISSION_MODES),
  customPermissions: z.object({
    approvalPolicy: z.enum(AGENT_APPROVAL_POLICIES),
    sandboxMode: z.enum(AGENT_SANDBOX_MODES),
    allowedPermissions: z.array(z.enum(AGENT_TOOL_PERMISSIONS)).min(1).max(5)
  }).strict(),
  workspaceRoot: absolutePathSchema,
  workspaceAccess: z.enum(['read', 'write']),
  workspaces: z.array(agentWorkspaceSettingsViewSchema).min(1).max(32),
  localModelRoots: z.array(absolutePathSchema).max(8),
  providers: z.record(agentProviderIdSchema, agentProviderSettingsViewSchema),
  runtimePolicy: runtimePolicySnapshotSchema
}).strict();

export const showWindowRequestSchema = z
  .object({
    source: z.enum(['user', 'shortcut', 'voice', 'system']),
    allowTemporaryTopmost: z.boolean()
  })
  .strict();

export const titleBarThemeSchema = z.enum(['dark', 'light']);

export const systemCapabilitySchema = z.enum(SYSTEM_CAPABILITIES);

const terminalSessionIdSchema = z.string().uuid();
const workspaceIdSchema = z.string().trim().min(1).max(128);
const terminalColumnsSchema = z.number().int().min(2).max(500);
const terminalRowsSchema = z.number().int().min(1).max(300);

export const createTerminalSessionRequestSchema = z
  .object({
    sessionId: terminalSessionIdSchema,
    workspaceId: workspaceIdSchema,
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
    workspaceId: workspaceIdSchema,
    relativePath: z.string().max(2_000).refine((value) => {
      if (value === '') return true;
      if (value.includes('\\') || value.startsWith('/') || value.endsWith('/')) return false;
      return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
    }, 'Workspace path must be a normalized relative path.')
  })
  .strict();
