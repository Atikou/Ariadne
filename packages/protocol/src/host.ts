import { z } from 'zod';
import {
  ARIADNE_RUNTIME_PROTOCOL,
  ARIADNE_RUNTIME_PROTOCOL_VERSION,
  assertRuntimeMessageSize,
  isoDateTimeSchema,
  nonEmptyIdSchema,
  runtimeInstanceIdSchema
} from './common.js';
import {
  runtimeCapabilitySchema,
  runtimeCommandSchema,
  runtimeEventSchema,
  runtimeResultSchema,
  modelInferenceProfileSchema
} from './public.js';

export {
  ARIADNE_RUNTIME_PROTOCOL,
  ARIADNE_RUNTIME_PROTOCOL_VERSION,
  MAX_RUNTIME_MESSAGE_BYTES,
  assertRuntimeMessageSize
} from './common.js';

const envelopeFields = {
  protocol: z.literal(ARIADNE_RUNTIME_PROTOCOL),
  protocolVersion: z.literal(ARIADNE_RUNTIME_PROTOCOL_VERSION),
  runtimeInstanceId: runtimeInstanceIdSchema
};

export const workspaceBootstrapSchema = z
  .object({
    workspaceId: nonEmptyIdSchema,
    label: z.string().trim().min(1).max(512),
    rootPath: z.string().trim().min(1).max(32_768),
    access: z.enum(['read', 'write'])
  })
  .strict();

export const agentPermissionsBootstrapSchema = z.object({
  approvalPolicy: z.enum(['request', 'risk-based', 'full-access']),
  proposalApproval: z.enum(['manual', 'automatic']),
  permissionPolicy: z.enum(['confirmBeforeRun', 'autoEdit', 'autoRun']),
  sandboxMode: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
  allowedPermissions: z.array(z.enum(['read', 'write', 'shell', 'network', 'dangerous'])).min(1).max(5)
}).strict();

export const modelProviderBootstrapSchema = z.object({
  providerId: nonEmptyIdSchema,
  name: nonEmptyIdSchema,
  protocol: z.enum(['openai-compatible', 'anthropic-messages']),
  credentialEnvironmentVariable: z.string().regex(/^[A-Z][A-Z0-9_]{2,127}$/),
  enabled: z.boolean(),
  baseUrl: z.string().url().max(2_048).refine(
    (value) => new URL(value).protocol === 'https:',
    'Runtime model providers require HTTPS.'
  ),
  model: z.string().trim().min(1).max(256),
  inference: modelInferenceProfileSchema
}).strict();

export const runtimeBootstrapSchema = z
  .object({
    ...envelopeFields,
    type: z.literal('bootstrap'),
    appVersion: z.string().trim().min(1).max(64),
    runtimeVersion: z.string().trim().min(1).max(64),
    installRoot: z.string().trim().min(1).max(32_768),
    dataRoot: z.string().trim().min(1).max(32_768),
    modelRoots: z.array(z.string().trim().min(1).max(32_768)).max(16),
    modelProviders: z.array(modelProviderBootstrapSchema).max(16).optional(),
    routingStrategy: z.enum([
      'local-first',
      'cloud-first',
      'privacy-first',
      'quality-first'
    ]).optional(),
    agentPermissions: agentPermissionsBootstrapSchema.optional(),
    profile: z.string().trim().min(1).max(128),
    workspaces: z.array(workspaceBootstrapSchema).min(1).max(32),
    production: z.boolean()
  })
  .strict();

export const runtimeReadySchema = z
  .object({
    ...envelopeFields,
    type: z.literal('ready'),
    runtimeVersion: z.string().trim().min(1).max(64),
    capabilities: z.array(runtimeCapabilitySchema),
    storageSchemas: z.record(z.string(), z.number().int().nonnegative()),
    readyAt: isoDateTimeSchema
  })
  .strict();

export const runtimeRequestSchema = z
  .object({
    ...envelopeFields,
    type: z.literal('request'),
    requestId: nonEmptyIdSchema,
    command: runtimeCommandSchema
  })
  .strict();

export const runtimeErrorSchema = z
  .object({
    code: z.string().regex(/^[a-z][a-z0-9_]{1,127}$/),
    message: z.string().trim().min(1).max(4_096),
    retryable: z.boolean(),
    details: z.array(z.string().max(1_024)).max(16).optional()
  })
  .strict();

export const runtimeResponseSchema = z
  .object({
    ...envelopeFields,
    type: z.literal('response'),
    requestId: nonEmptyIdSchema,
    outcome: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), result: runtimeResultSchema }).strict(),
      z.object({ ok: z.literal(false), error: runtimeErrorSchema }).strict()
    ])
  })
  .strict();

export const runtimeEventEnvelopeSchema = z
  .object({
    ...envelopeFields,
    type: z.literal('event'),
    sequence: z.number().int().positive(),
    event: runtimeEventSchema
  })
  .strict();

export const runtimeShutdownSchema = z
  .object({
    ...envelopeFields,
    type: z.literal('shutdown'),
    requestId: nonEmptyIdSchema,
    reason: z.enum(['app_quit', 'restart', 'upgrade', 'user_request']),
    deadlineMs: z.number().int().min(1_000).max(60_000)
  })
  .strict();

export const runtimeShutdownCompleteSchema = z
  .object({
    ...envelopeFields,
    type: z.literal('shutdown_complete'),
    requestId: nonEmptyIdSchema,
    completedAt: isoDateTimeSchema
  })
  .strict();

export const hostToRuntimeMessageSchema = z.discriminatedUnion('type', [
  runtimeBootstrapSchema,
  runtimeRequestSchema,
  runtimeShutdownSchema
]);

export const runtimeToHostMessageSchema = z.discriminatedUnion('type', [
  runtimeReadySchema,
  runtimeResponseSchema,
  runtimeEventEnvelopeSchema,
  runtimeShutdownCompleteSchema
]);

export type RuntimeBootstrap = z.infer<typeof runtimeBootstrapSchema>;
export type ModelProviderBootstrap = z.infer<typeof modelProviderBootstrapSchema>;
export type AgentPermissionsBootstrap = z.infer<typeof agentPermissionsBootstrapSchema>;
export type RuntimeReady = z.infer<typeof runtimeReadySchema>;
export type RuntimeRequest = z.infer<typeof runtimeRequestSchema>;
export type RuntimeResponse = z.infer<typeof runtimeResponseSchema>;
export type RuntimeEventEnvelope = z.infer<typeof runtimeEventEnvelopeSchema>;
export type RuntimeShutdown = z.infer<typeof runtimeShutdownSchema>;
export type RuntimeShutdownComplete = z.infer<typeof runtimeShutdownCompleteSchema>;
export type HostToRuntimeMessage = z.infer<typeof hostToRuntimeMessageSchema>;
export type RuntimeToHostMessage = z.infer<typeof runtimeToHostMessageSchema>;

export function parseHostToRuntimeMessage(input: unknown): HostToRuntimeMessage {
  assertRuntimeMessageSize(input);
  return hostToRuntimeMessageSchema.parse(input);
}

export function parseRuntimeToHostMessage(input: unknown): RuntimeToHostMessage {
  assertRuntimeMessageSize(input);
  return runtimeToHostMessageSchema.parse(input);
}
