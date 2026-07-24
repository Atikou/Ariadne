import { z } from 'zod';

const opaqueReferenceSchema = z.string().regex(/^[a-z][a-z0-9._:-]{2,255}$/u);
const absolutePathSchema = z.string().trim().min(1).max(32_768).refine(
  (value) => /^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(value),
  'Expected an absolute path.'
);
const httpsUrlSchema = z.string().url().max(2_048).refine(
  (value) => new URL(value).protocol === 'https:',
  'HTTPS is required.'
);
const httpsOriginSchema = httpsUrlSchema.refine((value) => {
  const url = new URL(value);
  return url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
}, 'Expected an HTTPS origin without path, query, credentials, or fragment.');
const toolPermissionSchema = z.enum(['read', 'write', 'shell', 'network', 'dangerous']);

const mcpServerBaseSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/u),
  enabled: z.boolean(),
  trustAnnotations: z.boolean()
});

export const runtimeMcpPolicySchema = z.object({
  servers: z.array(z.discriminatedUnion('transport', [
    mcpServerBaseSchema.extend({
      transport: z.literal('stdio'),
      command: z.string().trim().min(1).max(32_768),
      args: z.array(z.string().max(32_768)).max(64),
      environmentAllowlist: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/u)).max(64),
      workspaceAccess: z.enum(['read', 'write']),
      networkAccess: z.enum(['offline', 'online-approved'])
    }).strict(),
    mcpServerBaseSchema.extend({
      transport: z.literal('streamable-http'),
      endpoint: httpsUrlSchema,
      credentialRef: opaqueReferenceSchema.optional()
    }).strict()
  ])).max(32),
  legacySseFallback: z.literal(false)
}).strict().superRefine((config, context) => {
  const ids = new Set<string>();
  for (const [index, server] of config.servers.entries()) {
    if (ids.has(server.id)) {
      context.addIssue({ code: 'custom', path: ['servers', index, 'id'], message: 'Duplicate MCP server id.' });
    }
    ids.add(server.id);
  }
});

export const runtimeSkillsPolicySchema = z.object({
  enabled: z.array(z.string().regex(/^[a-z][a-z0-9_-]*$/u)).max(32),
  userDirectory: absolutePathSchema.optional()
}).strict();

const hookEventSchema = z.enum([
  'session.pre',
  'session.post',
  'run.pre',
  'run.post',
  'model.pre',
  'model.post',
  'tool.pre',
  'tool.post',
  'subagent.pre',
  'subagent.post',
  'stop'
]);

export const runtimeHooksPolicySchema = z.object({
  definitions: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9_-]*$/u),
    version: z.string().trim().min(1).max(64),
    events: z.array(hookEventSchema).min(1).max(11),
    timeoutMs: z.number().int().min(1).max(60_000),
    failurePolicy: z.enum(['fail-open', 'fail-closed']),
    decision: z.enum(['allow', 'reject']),
    reason: z.string().trim().min(1).max(512).optional(),
    constraints: z.object({
      permissions: z.array(toolPermissionSchema).max(5).optional(),
      timeoutMs: z.number().int().positive().max(24 * 60 * 60_000).optional()
    }).strict().optional()
  }).strict()).max(64)
}).strict().superRefine((config, context) => {
  const ids = new Set<string>();
  for (const [index, hook] of config.definitions.entries()) {
    if (ids.has(hook.id)) {
      context.addIssue({ code: 'custom', path: ['definitions', index, 'id'], message: 'Duplicate hook id.' });
    }
    ids.add(hook.id);
    if (new Set(hook.events).size !== hook.events.length) {
      context.addIssue({ code: 'custom', path: ['definitions', index, 'events'], message: 'Duplicate hook event.' });
    }
    if (hook.decision === 'reject' && hook.events.some((event) => !event.endsWith('.pre'))) {
      context.addIssue({
        code: 'custom',
        path: ['definitions', index, 'decision'],
        message: 'Reject is only valid for pre hooks.'
      });
    }
  }
});

export const runtimeBrowserPolicySchema = z.object({
  sessionMode: z.enum(['temporary', 'workspace-persistent']),
  allowedOrigins: z.array(httpsOriginSchema).max(64),
  allowCrossOriginRedirects: z.literal(false),
  allowSensitiveInput: z.boolean(),
  maxDownloadBytes: z.number().int().min(1).max(100 * 1024 * 1024)
}).strict();

export const runtimeTelemetryPolicySchema = z.object({
  enabled: z.boolean(),
  traceEndpoint: httpsUrlSchema.optional(),
  metricEndpoint: httpsUrlSchema.optional(),
  allowedEndpoints: z.array(httpsUrlSchema).max(16),
  sampleRatio: z.number().min(0).max(1),
  exportIntervalMs: z.number().int().min(1_000).max(10 * 60_000)
}).strict().superRefine((config, context) => {
  if (!config.enabled) return;
  for (const field of ['traceEndpoint', 'metricEndpoint'] as const) {
    const endpoint = config[field];
    if (!endpoint || !config.allowedEndpoints.includes(endpoint)) {
      context.addIssue({
        code: 'custom',
        path: [field],
        message: `${field} must exactly match an allowed HTTPS endpoint.`
      });
    }
  }
});

export const runtimeProviderResiliencePolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(5),
  baseBackoffMs: z.number().int().min(10).max(60_000),
  maxBackoffMs: z.number().int().min(10).max(120_000),
  jitterRatio: z.number().min(0).max(1),
  maxConcurrency: z.number().int().min(1).max(32),
  requestsPerMinute: z.number().int().min(1).max(100_000),
  tokensPerMinute: z.number().int().min(1).max(100_000_000),
  circuitFailureThreshold: z.number().int().min(1).max(100),
  circuitOpenMs: z.number().int().min(100).max(30 * 60_000)
}).strict().refine((policy) => policy.maxBackoffMs >= policy.baseBackoffMs, {
  message: 'maxBackoffMs must be greater than or equal to baseBackoffMs.'
});

export const runtimeEmbeddingPolicySchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('lexical') }).strict(),
  z.object({
    provider: z.literal('local-gguf'),
    modelId: z.string().trim().min(1).max(256),
    modelPath: absolutePathSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    dimension: z.number().int().positive(),
    gpuLayers: z.union([z.literal('auto'), z.number().int().nonnegative()]).optional()
  }).strict()
]);

export const runtimePolicySnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  mcp: runtimeMcpPolicySchema,
  skills: runtimeSkillsPolicySchema,
  hooks: runtimeHooksPolicySchema,
  browser: runtimeBrowserPolicySchema,
  telemetry: runtimeTelemetryPolicySchema,
  providerResilience: runtimeProviderResiliencePolicySchema,
  embedding: runtimeEmbeddingPolicySchema
}).strict();

export type RuntimePolicySnapshot = z.infer<typeof runtimePolicySnapshotSchema>;

export function createDefaultRuntimePolicySnapshot(): RuntimePolicySnapshot {
  return {
    schemaVersion: 1,
    mcp: { servers: [], legacySseFallback: false },
    skills: { enabled: [] },
    hooks: { definitions: [] },
    browser: {
      sessionMode: 'temporary',
      allowedOrigins: [],
      allowCrossOriginRedirects: false,
      allowSensitiveInput: false,
      maxDownloadBytes: 25 * 1024 * 1024
    },
    telemetry: {
      enabled: false,
      allowedEndpoints: [],
      sampleRatio: 0.1,
      exportIntervalMs: 60_000
    },
    providerResilience: {
      maxAttempts: 3,
      baseBackoffMs: 250,
      maxBackoffMs: 8_000,
      jitterRatio: 0.25,
      maxConcurrency: 4,
      requestsPerMinute: 60,
      tokensPerMinute: 1_000_000,
      circuitFailureThreshold: 3,
      circuitOpenMs: 30_000
    },
    embedding: { provider: 'lexical' }
  };
}
