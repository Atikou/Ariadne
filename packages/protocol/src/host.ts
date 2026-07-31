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
  runtimeEventEnvelopeSchema as publicRuntimeEventEnvelopeSchema,
  runtimeResultSchema,
  modelInferenceProfileSchema
} from './public.js';
import { runtimePolicySnapshotSchema } from './settings.js';

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

export const runtimeBuildFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const runtimeBuildManifestSchema = z.object({
  schemaVersion: z.literal(1),
  runtimeVersion: z.string().trim().min(1).max(64),
  fingerprint: runtimeBuildFingerprintSchema
}).strict();

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
    runtimeBuildFingerprint: runtimeBuildFingerprintSchema,
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
    runtimePolicy: runtimePolicySnapshotSchema,
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
    runtimeBuildFingerprint: runtimeBuildFingerprintSchema,
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

export const runtimeEventMessageSchema = z
  .object({
    ...envelopeFields,
    type: z.literal('event'),
    event: publicRuntimeEventEnvelopeSchema
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

const browserHttpsUrlSchema = z.string().url().max(2_048).refine(
  (value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  },
  { message: 'Browser capability URLs must use HTTPS without embedded credentials.' }
);

export const browserCapabilityOperationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('browser.health') }).strict(),
  z.object({ kind: z.literal('browser.navigate'), url: browserHttpsUrlSchema }).strict(),
  z.object({ kind: z.literal('browser.accessibility_snapshot') }).strict(),
  z.object({ kind: z.literal('browser.screenshot') }).strict(),
  z.object({ kind: z.literal('browser.click'), selector: z.string().min(1).max(2_048) }).strict(),
  z.object({
    kind: z.literal('browser.type'),
    selector: z.string().min(1).max(2_048),
    text: z.string().max(100_000),
    sensitive: z.boolean().default(false)
  }).strict(),
  z.object({
    kind: z.literal('browser.scroll'),
    deltaX: z.number().finite().min(-100_000).max(100_000).default(0),
    deltaY: z.number().finite().min(-100_000).max(100_000)
  }).strict(),
  z.object({ kind: z.literal('browser.wait'), milliseconds: z.number().int().min(0).max(30_000) }).strict(),
  z.object({ kind: z.literal('browser.download'), url: browserHttpsUrlSchema }).strict()
]);

const mcpConnectionIdSchema = z.string().uuid();
const jsonRpcIdSchema = z.union([z.string().max(512), z.number().int().safe()]);
const mcpJsonRpcMessageSchema = z.union([
  z.object({
    jsonrpc: z.literal('2.0'),
    id: jsonRpcIdSchema,
    method: z.string().trim().min(1).max(512),
    params: z.unknown().optional()
  }).strict(),
  z.object({
    jsonrpc: z.literal('2.0'),
    method: z.string().trim().min(1).max(512),
    params: z.unknown().optional()
  }).strict(),
  z.object({
    jsonrpc: z.literal('2.0'),
    id: jsonRpcIdSchema,
    result: z.unknown()
  }).strict(),
  z.object({
    jsonrpc: z.literal('2.0'),
    id: jsonRpcIdSchema.optional(),
    error: z.object({
      code: z.number().int().safe(),
      message: z.string().max(8_192),
      data: z.unknown().optional()
    }).strict()
  }).strict()
]);

export const mcpRemoteCapabilityOperationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('mcp.remote.connect'),
    serverId: nonEmptyIdSchema,
    endpoint: browserHttpsUrlSchema,
    credentialRef: z.string().regex(/^[a-z][a-z0-9._:-]{2,255}$/u).optional()
  }).strict(),
  z.object({
    kind: z.literal('mcp.remote.send'),
    connectionId: mcpConnectionIdSchema,
    message: mcpJsonRpcMessageSchema
  }).strict(),
  z.object({
    kind: z.literal('mcp.remote.receive'),
    connectionId: mcpConnectionIdSchema,
    maxWaitMs: z.number().int().min(0).max(25_000)
  }).strict(),
  z.object({
    kind: z.literal('mcp.remote.close'),
    connectionId: mcpConnectionIdSchema
  }).strict()
]);

export const runtimeCapabilityRequestSchema = z.discriminatedUnion('capability', [
  z.object({
    ...envelopeFields,
    type: z.literal('capability_request'),
    requestId: nonEmptyIdSchema,
    capability: z.literal('browser'),
    operation: browserCapabilityOperationSchema
  }).strict(),
  z.object({
    ...envelopeFields,
    type: z.literal('capability_request'),
    requestId: nonEmptyIdSchema,
    capability: z.literal('mcp_remote'),
    operation: mcpRemoteCapabilityOperationSchema
  }).strict()
]);

export const hostCapabilityResponseSchema = z.object({
  ...envelopeFields,
  type: z.literal('capability_response'),
  requestId: nonEmptyIdSchema,
  outcome: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), result: z.record(z.string(), z.unknown()) }).strict(),
    z.object({ ok: z.literal(false), error: runtimeErrorSchema }).strict()
  ])
}).strict();

export const hostToRuntimeMessageSchema = z.discriminatedUnion('type', [
  runtimeBootstrapSchema,
  runtimeRequestSchema,
  runtimeShutdownSchema,
  hostCapabilityResponseSchema
]);

export const runtimeToHostMessageSchema = z.discriminatedUnion('type', [
  runtimeReadySchema,
  runtimeResponseSchema,
  runtimeEventMessageSchema,
  runtimeShutdownCompleteSchema,
  runtimeCapabilityRequestSchema
]);

export type RuntimeBootstrap = z.infer<typeof runtimeBootstrapSchema>;
export type RuntimeBuildManifest = z.infer<typeof runtimeBuildManifestSchema>;
export type ModelProviderBootstrap = z.infer<typeof modelProviderBootstrapSchema>;
export type AgentPermissionsBootstrap = z.infer<typeof agentPermissionsBootstrapSchema>;
export type RuntimeReady = z.infer<typeof runtimeReadySchema>;
export type RuntimeRequest = z.infer<typeof runtimeRequestSchema>;
export type RuntimeResponse = z.infer<typeof runtimeResponseSchema>;
export type RuntimeEventMessage = z.infer<typeof runtimeEventMessageSchema>;
export type RuntimeShutdown = z.infer<typeof runtimeShutdownSchema>;
export type RuntimeShutdownComplete = z.infer<typeof runtimeShutdownCompleteSchema>;
export type RuntimeCapabilityRequest = z.infer<typeof runtimeCapabilityRequestSchema>;
export type HostCapabilityResponse = z.infer<typeof hostCapabilityResponseSchema>;
export type BrowserCapabilityOperation = z.infer<typeof browserCapabilityOperationSchema>;
export type McpRemoteCapabilityOperation = z.infer<typeof mcpRemoteCapabilityOperationSchema>;
export type HostCapabilityOperation = BrowserCapabilityOperation | McpRemoteCapabilityOperation;
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
