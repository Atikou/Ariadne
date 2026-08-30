import { z } from 'zod';
import {
  modelInferenceProfileSchema,
  runtimeCommandSchema,
  runtimeResultSchema,
  runtimeStatusSchema
} from '@ariadne/protocol/public';
import {
  acpSubagentProviderConfigurationSchema,
  claudeSubagentProviderConfigurationSchema,
  codexSubagentProviderConfigurationSchema,
  assistantChatProfileSchema,
  runtimePolicySnapshotSchema
} from '@ariadne/protocol/settings';
import type {
  AgentInputDeliveryOutboxRecord,
  AgentInputDeliveryOutboxStageRequest,
  JsonObject,
  JsonValue
} from './contract';
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

export const publicErrorSchema = z
  .object({
    code: z.string().regex(/^[a-z][a-z0-9_]{1,127}$/u),
    message: z.string().min(1).max(4_096),
    retryable: z.boolean(),
    correlationId: z.string().min(1).max(256),
    details: z.array(z.string().max(1_024)).max(64).optional()
  })
  .strict();

const resultSchema = <T extends z.ZodType>(value: T) => z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value }).strict(),
  z.object({ ok: z.literal(false), error: publicErrorSchema }).strict()
]);

export const runtimeStatusResultSchema = resultSchema(runtimeStatusSchema);
export const runtimeRequestResultSchema = resultSchema(runtimeResultSchema);
export const runtimeDesktopRequestSchema = z
  .object({
    command: runtimeCommandSchema,
    commandId: z.string().trim().min(1).max(256).optional()
  })
  .strict();

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

const agentInputDeliveryCommandSchema = runtimeCommandSchema.refine(
  (command) => command.kind === 'agent.inbox.enqueue.v3',
  'Only Agent inbox enqueue commands may enter the delivery outbox.'
);

export const agentInputDeliveryOutboxStageRequestSchema = z
  .object({
    commandId: z.string().trim().min(1).max(256),
    command: agentInputDeliveryCommandSchema
  })
  .strict();

export const agentInputDeliveryOutboxSettleRequestSchema = z
  .object({ commandId: z.string().trim().min(1).max(256) })
  .strict();

const agentInputDeliveryOutboxRecordSchema = z
  .object({
    commandId: z.string().trim().min(1).max(256),
    command: agentInputDeliveryCommandSchema,
    createdAt: z.string().datetime()
  })
  .strict();

export function parseAgentInputDeliveryOutboxStageRequest(
  input: unknown
): AgentInputDeliveryOutboxStageRequest {
  return agentInputDeliveryOutboxStageRequestSchema.parse(input) as AgentInputDeliveryOutboxStageRequest;
}

export function parseAgentInputDeliveryOutboxRecords(
  input: unknown
): AgentInputDeliveryOutboxRecord[] {
  const parsed: unknown = z.array(agentInputDeliveryOutboxRecordSchema).max(100).parse(input);
  return parsed as AgentInputDeliveryOutboxRecord[];
}

export const speechPreferencesSchema = z
  .object({
    enabled: z.boolean(),
    moduleRoot: absoluteSpeechRootSchema(),
    foregroundSttMode: z.enum(['compose', 'auto-send']),
    backgroundWakeEnabled: z.boolean(),
    wakeKeywords: z.array(z.string().trim().min(1).max(64)).min(1).max(16),
    listenWhenLocked: z.boolean(),
    inputDeviceId: z.string().trim().min(1).max(512),
    outputDeviceId: z.string().trim().min(1).max(512),
    activeVoiceId: z.string().trim().min(1).max(128).nullable(),
    activeVoiceVersion: z.string().trim().min(1).max(64).nullable()
  })
  .strict()
  .refine((value) => (value.activeVoiceId === null) === (value.activeVoiceVersion === null), {
    message: '音色 ID 与版本必须同时设置或同时为空。'
  });

export const userPreferencesSchema = z
  .object({
    runInBackground: z.boolean(),
    startAtLogin: z.boolean(),
    theme: z.enum(['system', 'dark', 'light']),
    suppressAutomaticWakeDuringGames: z.boolean(),
    gameDetectionRules: z.array(gameDetectionRuleSchema).max(500),
    speech: speechPreferencesSchema
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

function absoluteSpeechRootSchema(): z.ZodString {
  return z.string().trim().min(1).max(32_768).refine(
    (value) => /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value),
    '语音模块目录必须使用绝对路径。'
  );
}

export const startSpeechRecognitionRequestSchema = z.object({
  requestId: z.string().uuid(),
  source: z.enum(['foreground', 'background-wake'])
}).strict();

export const stopSpeechRecognitionRequestSchema = z.object({ requestId: z.string().uuid() }).strict();

export const speechSynthesisSegmentRequestSchema = z.object({
  turnId: z.string().trim().min(1).max(256),
  sequence: z.number().int().nonnegative(),
  text: z.string().trim().min(1).max(2_000),
  final: z.boolean()
}).strict();

export const cancelSpeechSynthesisRequestSchema = z.object({
  turnId: z.string().trim().min(1).max(256).optional()
}).strict();

export const activateSpeechVoiceRequestSchema = z.object({
  voiceId: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u),
  version: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u)
}).strict();

const httpsUrlSchema = z.string().trim().url().max(2_048).refine(
  (value) => new URL(value).protocol === 'https:',
  '远程模型地址必须使用 HTTPS。'
);

const agentProviderSettingsPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    baseUrl: httpsUrlSchema.optional(),
    model: z.string().trim().min(1).max(256).optional(),
    contextWindowTokens: z.number().int().min(8_192).max(10_000_000).optional(),
    maxOutputTokens: z.number().int().min(256).max(1_000_000).optional(),
    inference: modelInferenceProfileSchema.optional(),
    apiKey: z.string().trim().min(8).max(8_192).optional(),
    clearApiKey: z.literal(true).optional()
  })
  .strict()
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'Provider update must change at least one field.'
  )
  .refine((value) => !(value.apiKey && value.clearApiKey), '不能同时替换和清除 API Key。');

const agentSubagentProviderSettingsSchema = z.discriminatedUnion('kind', [
  acpSubagentProviderConfigurationSchema.extend({ enabled: z.boolean() }).strict(),
  codexSubagentProviderConfigurationSchema.extend({ enabled: z.boolean() }).strict(),
  claudeSubagentProviderConfigurationSchema.extend({ enabled: z.boolean() }).strict()
]);

export const agentSettingsOperationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('permissions.set'),
    mode: z.enum(AGENT_PERMISSION_MODES),
    customPermissions: z.object({
      approvalPolicy: z.enum(AGENT_APPROVAL_POLICIES),
      sandboxMode: z.enum(AGENT_SANDBOX_MODES),
      allowedPermissions: z.array(z.enum(AGENT_TOOL_PERMISSIONS)).min(1).max(5)
    }).strict().optional()
  }).strict(),
  z.object({ kind: z.literal('routing.set'), strategy: agentRoutingStrategySchema }).strict(),
  z.object({ kind: z.literal('assistant.replace'), assistant: assistantChatProfileSchema }).strict(),
  z.object({ kind: z.literal('modelRoots.replace'), roots: z.array(absolutePathSchema).max(8) }).strict(),
  z.object({
    kind: z.literal('provider.update'),
    providerId: agentProviderIdSchema,
    patch: agentProviderSettingsPatchSchema
  }).strict(),
  z.object({
    kind: z.literal('subagentProviders.replace'),
    providers: z.array(agentSubagentProviderSettingsSchema).max(8)
  }).strict(),
  z.object({ kind: z.literal('runtimePolicy.replace'), policy: runtimePolicySnapshotSchema }).strict()
]);

export const agentSettingsMutationSchema = z.object({
  expectedRevision: z.number().int().positive(),
  operations: z.array(agentSettingsOperationSchema).min(1).max(16)
}).strict().superRefine((mutation, context) => {
  const identities = new Set<string>();
  for (const [index, operation] of mutation.operations.entries()) {
    const identity = operation.kind === 'provider.update'
      ? `${operation.kind}:${operation.providerId}`
      : operation.kind;
    if (identities.has(identity)) {
      context.addIssue({
        code: 'custom',
        path: ['operations', index],
        message: `Duplicate settings operation: ${identity}`
      });
    }
    identities.add(identity);
  }
});

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
  contextWindowTokens: z.number().int().min(8_192).max(10_000_000),
  maxOutputTokens: z.number().int().min(256).max(1_000_000),
  inference: modelInferenceProfileSchema,
  apiKeyStatus: apiKeyStatusSchema
}).strict().refine(
  (provider) => provider.maxOutputTokens < provider.contextWindowTokens,
  '最大输出必须小于上下文窗口。'
);

const agentWorkspaceSettingsViewSchema = z.object({
  workspaceId: z.string().trim().min(1).max(128),
  rootPath: absolutePathSchema,
  access: z.enum(['read', 'write']),
  pinned: z.boolean().optional(),
  archivedAt: z.string().datetime().optional()
}).strict();

export const agentSettingsViewSchema = z.object({
  schemaVersion: z.literal(7),
  revision: z.number().int().positive(),
  assistant: assistantChatProfileSchema,
  routingStrategy: agentRoutingStrategySchema,
  permissionMode: z.enum(AGENT_PERMISSION_MODES),
  customPermissions: z.object({
    approvalPolicy: z.enum(AGENT_APPROVAL_POLICIES),
    sandboxMode: z.enum(AGENT_SANDBOX_MODES),
    allowedPermissions: z.array(z.enum(AGENT_TOOL_PERMISSIONS)).min(1).max(5)
  }).strict(),
  workspaceAccess: z.enum(['read', 'write']),
  workspaces: z.array(agentWorkspaceSettingsViewSchema).max(32),
  localModelRoots: z.array(absolutePathSchema).max(8),
  providers: z.record(agentProviderIdSchema, agentProviderSettingsViewSchema),
  subagentProviders: z.array(agentSubagentProviderSettingsSchema).max(8),
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
    rows: terminalRowsSchema,
    restartOf: terminalSessionIdSchema.optional()
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

export const signalTerminalRequestSchema = z
  .object({
    sessionId: terminalSessionIdSchema,
    signal: z.enum(['interrupt', 'terminate', 'kill'])
  })
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
