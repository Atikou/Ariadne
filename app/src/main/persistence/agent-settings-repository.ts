import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parse as parseToml, stringify as stringifyToml, type TomlTable } from 'smol-toml';
import { z } from 'zod';
import { modelInferenceProfileSchema, type ModelInferenceProfile } from '@ariadne/protocol/public';
import {
  acpSubagentProviderConfigurationSchema,
  claudeSubagentProviderConfigurationSchema,
  codexSubagentProviderConfigurationSchema,
  assistantChatProfileSchema,
  createDefaultAssistantChatProfile,
  type AssistantChatProfile,
  type SubagentProviderConfiguration
} from '@ariadne/protocol/settings';
import {
  createDefaultRuntimePolicySnapshot,
  runtimePolicySnapshotSchema,
  type RuntimePolicySnapshot
} from '@ariadne/protocol/settings';
import {
  AGENT_APPROVAL_POLICIES,
  AGENT_PERMISSION_MODES,
  AGENT_PROVIDER_CATALOG,
  AGENT_PROVIDER_IDS,
  AGENT_SANDBOX_MODES,
  AGENT_TOOL_PERMISSIONS,
  type AgentApprovalPolicy,
  type AgentCustomPermissions,
  type AgentPermissionMode,
  type AgentProviderId,
  type AgentSandboxMode,
  type AgentSettingsEffect,
  type AgentSettingsMutation,
  type AgentSettingsMutationResult,
  type AgentSettingsOperation,
  type AgentSettingsView,
  type AgentToolPermission,
  type AgentWorkspaceSettingsView,
  type ApiKeyStatus
} from '@shared/contract';
import { agentProviderIdSchema, agentRoutingStrategySchema, agentSettingsMutationSchema } from '@shared/schemas';
import type { SecretCipher } from './secret-cipher';

const encryptedApiKeySchema = z.string().min(1).max(32_768).nullable();
const absoluteWorkspacePathSchema = z.string().min(1).max(32_768).refine(
  (value) => /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value)
);
const customPermissionsSchema = z.object({
  approvalPolicy: z.enum(AGENT_APPROVAL_POLICIES),
  sandboxMode: z.enum(AGENT_SANDBOX_MODES),
  allowedPermissions: z.array(z.enum(AGENT_TOOL_PERMISSIONS)).min(1).max(5)
}).strict();
const persistedWorkspaceSchema = z.object({
  workspaceId: z.string().trim().min(1).max(128),
  rootPath: absoluteWorkspacePathSchema,
  access: z.enum(['read', 'write']),
  pinned: z.literal(true).optional(),
  archivedAt: z.string().datetime().optional()
}).strict().superRefine((workspace, context) => {
  if (workspace.archivedAt && workspace.pinned) {
    context.addIssue({ code: 'custom', message: 'An archived workspace cannot remain pinned.' });
  }
});
const persistedProviderSchema = z.object({
  enabled: z.boolean(),
  baseUrl: z.string().url().max(2_048).refine((value) => new URL(value).protocol === 'https:'),
  model: z.string().trim().min(1).max(256),
  contextWindowTokens: z.number().int().min(8_192).max(10_000_000),
  maxOutputTokens: z.number().int().min(256).max(1_000_000),
  inference: modelInferenceProfileSchema,
  encryptedApiKey: encryptedApiKeySchema
}).strict().refine(
  (provider) => provider.maxOutputTokens < provider.contextWindowTokens,
  'Provider maxOutputTokens must be smaller than contextWindowTokens.'
);
const persistedProviderFileSchema = z.object({
  enabled: z.boolean(),
  baseUrl: z.string().url().max(2_048).refine((value) => new URL(value).protocol === 'https:'),
  model: z.string().trim().min(1).max(256),
  contextWindowTokens: z.number().int().min(8_192).max(10_000_000).optional(),
  maxOutputTokens: z.number().int().min(256).max(1_000_000).optional(),
  inference: modelInferenceProfileSchema.optional(),
  encryptedApiKey: encryptedApiKeySchema.optional()
}).strict();
const persistedSubagentProviderSchema = z.discriminatedUnion('kind', [
  acpSubagentProviderConfigurationSchema.extend({ enabled: z.boolean() }).strict(),
  codexSubagentProviderConfigurationSchema.extend({ enabled: z.boolean() }).strict(),
  claudeSubagentProviderConfigurationSchema.extend({ enabled: z.boolean() }).strict()
]);
const legacyAssistantChatProfileSchema = z.object({
  mode: z.enum(['standard', 'unrestricted']),
  name: z.string().trim().min(1).max(64),
  systemPrompt: z.string().trim().min(1).max(32_768)
}).strict();
const persistedAssistantChatProfileFileSchema = z.union([
  assistantChatProfileSchema,
  legacyAssistantChatProfileSchema
]);
const persistedAgentSettingsBase = {
  revision: z.number().int().positive(),
  routingStrategy: agentRoutingStrategySchema,
  localModelRoots: z.array(z.string().min(1).max(32_768).refine(
    (value) => /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value)
  )).max(8)
};
const persistedAgentSettingsSchema = z.object({
  ...persistedAgentSettingsBase,
  schemaVersion: z.literal(7),
  assistant: assistantChatProfileSchema,
  permissionMode: z.enum(AGENT_PERMISSION_MODES),
  customPermissions: customPermissionsSchema,
  workspaceAccess: z.enum(['read', 'write']),
  workspaces: z.array(persistedWorkspaceSchema).max(32),
  providers: z.record(agentProviderIdSchema, persistedProviderSchema),
  subagentProviders: z.array(persistedSubagentProviderSchema).max(8),
  runtimePolicy: runtimePolicySnapshotSchema
}).strict();
const persistedAgentSettingsFileSchema = z.object({
  schemaVersion: z.union([
    z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(7)
  ]),
  revision: z.number().int().positive().optional(),
  routingStrategy: agentRoutingStrategySchema,
  localModelRoots: z.array(z.string().min(1).max(32_768).refine(
    (value) => /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value)
  )).max(8),
  assistant: persistedAssistantChatProfileFileSchema.optional(),
  permissionMode: z.enum(AGENT_PERMISSION_MODES).optional(),
  customPermissions: customPermissionsSchema.optional(),
  workspaceRoot: absoluteWorkspacePathSchema.optional(),
  workspaceAccess: z.enum(['read', 'write']).optional(),
  workspaces: z.array(persistedWorkspaceSchema).max(32).optional(),
  providers: z.partialRecord(agentProviderIdSchema, persistedProviderFileSchema),
  subagentProviders: z.array(persistedSubagentProviderSchema).max(8).optional(),
  runtimePolicy: runtimePolicySnapshotSchema.optional()
}).strict().superRefine((settings, context) => {
  if (settings.schemaVersion >= 4 && settings.workspaceRoot !== undefined) {
    context.addIssue({ code: 'custom', path: ['workspaceRoot'], message: 'Current settings do not use workspaceRoot.' });
  }
});

type PersistedAgentSettings = z.infer<typeof persistedAgentSettingsSchema>;

export interface AgentSettingsCheckpoint {
  readonly serialized: string;
}

export interface RuntimeAgentProviderSettings {
  enabled: boolean;
  baseUrl: string;
  model: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  inference: ModelInferenceProfile;
  apiKey?: string;
}

export interface RuntimeAgentPermissionProfile {
  approvalPolicy: AgentApprovalPolicy;
  proposalApproval: 'manual' | 'automatic';
  permissionPolicy: 'confirmBeforeRun' | 'autoEdit' | 'autoRun';
  sandboxMode: AgentSandboxMode;
  allowedPermissions: AgentToolPermission[];
}

export interface RuntimeAgentSettings {
  revision: number;
  assistant: AssistantChatProfile;
  routingStrategy: AgentSettingsView['routingStrategy'];
  permissionMode: AgentPermissionMode;
  permissions: RuntimeAgentPermissionProfile;
  workspaceAccess: 'read' | 'write';
  workspaces: AgentWorkspaceSettingsView[];
  localModelRoots: string[];
  providers: Record<AgentProviderId, RuntimeAgentProviderSettings>;
  subagentProviders: Array<SubagentProviderConfiguration & { enabled: boolean }>;
  runtimePolicy: RuntimePolicySnapshot;
}

export interface AddWorkspaceResult {
  added: boolean;
  settings: AgentSettingsView;
  workspace: AgentWorkspaceSettingsView;
}

export class AgentSettingsRepository {
  private settings: PersistedAgentSettings;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly cipher: SecretCipher,
    private readonly legacyJsonPath = join(dirname(filePath), 'agent-settings.json')
  ) {
    this.settings = createDefaultAgentSettings();
  }

  async initialize(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      await this.initializeMissingSettings();
      return;
    }

    try {
      this.settings = parsePersistedAgentSettings(parseToml(raw));
    } catch (error) {
      console.warn('Ariadne settings validation failed.', error instanceof Error ? error.message : error);
      await this.backupInvalidFile(this.filePath);
      this.settings = createDefaultAgentSettings();
    }
    await this.queueWrite(this.settings);
  }

  getView(): AgentSettingsView {
    return {
      schemaVersion: 7,
      revision: this.settings.revision,
      assistant: structuredClone(this.settings.assistant),
      routingStrategy: this.settings.routingStrategy,
      permissionMode: this.settings.permissionMode,
      customPermissions: structuredClone(this.settings.customPermissions),
      workspaceAccess: this.settings.workspaceAccess,
      workspaces: this.settings.workspaces.map((workspace) => ({ ...workspace })),
      localModelRoots: [...this.settings.localModelRoots],
      providers: mapProviders(this.settings, (provider) => ({
        enabled: provider.enabled,
        baseUrl: provider.baseUrl,
        model: provider.model,
        contextWindowTokens: provider.contextWindowTokens,
        maxOutputTokens: provider.maxOutputTokens,
        inference: structuredClone(provider.inference),
        apiKeyStatus: this.apiKeyStatus(provider.encryptedApiKey)
      })),
      subagentProviders: this.settings.subagentProviders.map((provider) => ({
        ...provider,
        args: [...provider.args]
      })),
      runtimePolicy: structuredClone(this.settings.runtimePolicy)
    };
  }

  getRuntimeSettings(): RuntimeAgentSettings {
    return {
      revision: this.settings.revision,
      assistant: structuredClone(this.settings.assistant),
      routingStrategy: this.settings.routingStrategy,
      permissionMode: this.settings.permissionMode,
      permissions: resolveRuntimePermissionProfile(this.settings.permissionMode, this.settings.customPermissions),
      workspaceAccess: this.settings.workspaceAccess,
      workspaces: this.settings.workspaces
        .filter((workspace) => workspace.archivedAt === undefined)
        .map((workspace) => ({ ...workspace })),
      localModelRoots: [...this.settings.localModelRoots],
      providers: mapProviders(this.settings, (provider) => {
        const apiKey = this.tryDecrypt(provider.encryptedApiKey);
        return {
          enabled: provider.enabled,
          baseUrl: provider.baseUrl,
          model: provider.model,
          contextWindowTokens: provider.contextWindowTokens,
          maxOutputTokens: provider.maxOutputTokens,
          inference: structuredClone(provider.inference),
          ...(apiKey ? { apiKey } : {})
        };
      }),
      subagentProviders: this.settings.subagentProviders.map((provider) => ({
        ...provider,
        args: [...provider.args]
      })),
      runtimePolicy: structuredClone(this.settings.runtimePolicy)
    };
  }

  createCheckpoint(): AgentSettingsCheckpoint {
    return { serialized: JSON.stringify(this.settings) };
  }

  async restore(checkpoint: AgentSettingsCheckpoint): Promise<AgentSettingsView> {
    const restored = persistedAgentSettingsSchema.parse(JSON.parse(checkpoint.serialized));
    await this.commitSettings(() => restored);
    return this.getView();
  }

  async mutate(input: AgentSettingsMutation): Promise<AgentSettingsMutationResult> {
    const mutation = agentSettingsMutationSchema.parse(input);
    let result: AgentSettingsMutationResult | undefined;
    const operation = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        if (mutation.expectedRevision !== this.settings.revision) {
          result = {
            ok: false,
            settings: this.getView(),
            error: {
              code: 'settings_revision_conflict',
              message: `设置版本 ${mutation.expectedRevision} 已过期；当前版本为 ${this.settings.revision}。`,
              expectedRevision: mutation.expectedRevision,
              currentRevision: this.settings.revision
            }
          };
          return;
        }
        const effect = effectForSettingsOperations(mutation.operations);
        const mutated = applySettingsOperations(
          structuredClone(this.settings),
          mutation.operations,
          this.cipher
        );
        if (samePersistedSettings(mutated, this.settings)) {
          result = { ok: true, settings: this.getView(), effect: 'hot_applied' };
          return;
        }
        const next = persistedAgentSettingsSchema.parse({
          ...mutated,
          schemaVersion: 7,
          revision: this.settings.revision + 1
        });
        await this.writeSnapshot(next);
        this.settings = next;
        result = { ok: true, settings: this.getView(), effect };
      });
    this.writeQueue = operation;
    await operation;
    if (!result) throw new Error('Settings mutation completed without a result.');
    return result;
  }

  async addWorkspaceRoot(rootPath: string): Promise<AddWorkspaceResult> {
    const normalizedRoot = resolve(absoluteWorkspacePathSchema.parse(rootPath));
    let added = false;
    let workspace: AgentWorkspaceSettingsView | undefined;
    await this.commitSettings((current) => {
      const existing = current.workspaces.find((entry) => sameWorkspaceRoot(entry.rootPath, normalizedRoot));
      if (existing) {
        workspace = { ...existing };
        return current;
      }
      added = true;
      const created: AgentWorkspaceSettingsView = {
        workspaceId: workspaceIdForRoot(normalizedRoot),
        rootPath: normalizedRoot,
        access: current.workspaceAccess
      };
      workspace = created;
      return {
        ...current,
        workspaces: [...current.workspaces, created]
      };
    });
    if (!workspace) throw new Error('Workspace settings update did not produce a workspace.');
    return { added, settings: this.getView(), workspace };
  }

  async setWorkspacePinned(workspaceId: string, pinned: boolean): Promise<AgentSettingsView> {
    await this.commitSettings((current) => updateWorkspace(current, workspaceId, (workspace) => {
      if (workspace.archivedAt) throw new Error('已归档工作区不能置顶。');
      if (!pinned) {
        const { pinned: _pinned, ...rest } = workspace;
        return rest;
      }
      return { ...workspace, pinned: true as const };
    }));
    return this.getView();
  }

  async archiveWorkspace(
    workspaceId: string,
    archivedAt = new Date()
  ): Promise<AgentSettingsView> {
    const archivedAtIso = archivedAt.toISOString();
    await this.commitSettings((current) => updateWorkspace(current, workspaceId, (workspace) => {
      if (workspace.archivedAt) return workspace;
      const { pinned: _pinned, ...rest } = workspace;
      return { ...rest, archivedAt: archivedAtIso };
    }));
    return this.getView();
  }

  async restoreWorkspace(workspaceId: string): Promise<AgentSettingsView> {
    await this.commitSettings((current) => updateWorkspace(current, workspaceId, (workspace) => {
      const { archivedAt: _archivedAt, ...active } = workspace;
      return active;
    }));
    return this.getView();
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private async initializeMissingSettings(): Promise<void> {
    let legacyRaw: string | undefined;
    try {
      legacyRaw = await readFile(this.legacyJsonPath, 'utf8');
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    if (legacyRaw !== undefined) {
      try {
        this.settings = parsePersistedAgentSettings(JSON.parse(legacyRaw));
      } catch (error) {
        console.warn('Legacy Ariadne settings validation failed.', error instanceof Error ? error.message : error);
        await this.backupInvalidFile(this.legacyJsonPath);
        this.settings = createDefaultAgentSettings();
        await this.queueWrite(this.settings);
        return;
      }
      await this.queueWrite(this.settings);
      await rename(this.legacyJsonPath, `${this.legacyJsonPath}.migrated-${Date.now()}`);
      return;
    }
    this.settings = createDefaultAgentSettings();
    await this.queueWrite(this.settings);
  }

  private apiKeyStatus(ciphertext: string | null): ApiKeyStatus {
    if (!ciphertext) return 'missing';
    return this.tryDecrypt(ciphertext) ? 'configured' : 'unavailable';
  }

  private tryDecrypt(ciphertext: string | null): string | undefined {
    if (!ciphertext) return undefined;
    try {
      const value = this.cipher.decrypt(ciphertext);
      return value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private async queueWrite(settings: PersistedAgentSettings): Promise<void> {
    const snapshot = structuredClone(settings);
    const operation = this.writeQueue
      .catch(() => undefined)
      .then(() => this.writeSnapshot(snapshot));
    this.writeQueue = operation;
    await operation;
  }

  private async commitSettings(
    mutator: (current: PersistedAgentSettings) => PersistedAgentSettings
  ): Promise<void> {
    const operation = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        const mutated = mutator(structuredClone(this.settings));
        if (samePersistedSettings(mutated, this.settings)) return;
        const next = persistedAgentSettingsSchema.parse({
          ...mutated,
          schemaVersion: 7,
          revision: this.settings.revision + 1
        });
        await this.writeSnapshot(next);
        this.settings = next;
      });
    this.writeQueue = operation;
    await operation;
  }

  private async writeSnapshot(settings: PersistedAgentSettings): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(
      tempPath,
      `# Ariadne settings. API keys are encrypted by the operating system.\n${stringifyToml(toTomlDocument(settings))}`,
      { encoding: 'utf8', mode: 0o600 }
    );
    await rename(tempPath, this.filePath);
  }

  private async backupInvalidFile(path: string): Promise<void> {
    try {
      await rename(path, `${path}.invalid-${Date.now()}`);
      console.warn(`Invalid Ariadne settings were backed up: ${path}`);
    } catch (error) {
      if (isMissingFile(error)) return;
      throw new Error('Unable to preserve invalid Ariadne settings before recovery.');
    }
  }
}

export function effectForSettingsOperations(
  operations: readonly AgentSettingsOperation[]
): AgentSettingsEffect {
  let effect: AgentSettingsEffect = 'hot_applied';
  for (const operation of operations) {
    const operationEffect: AgentSettingsEffect = operation.kind === 'permissions.set'
      || operation.kind === 'routing.set'
      ? 'reload_scheduled'
      : 'restart_required';
    if (operationEffect === 'restart_required') return operationEffect;
    if (operationEffect === 'reload_scheduled') effect = operationEffect;
  }
  return effect;
}

function applySettingsOperations(
  current: PersistedAgentSettings,
  operations: readonly AgentSettingsOperation[],
  cipher: SecretCipher
): PersistedAgentSettings {
  const next = structuredClone(current);
  for (const operation of operations) {
    switch (operation.kind) {
      case 'permissions.set': {
        next.permissionMode = operation.mode;
        if (operation.customPermissions) {
          next.customPermissions = structuredClone(operation.customPermissions);
        }
        next.workspaceAccess = workspaceAccessFor(next.permissionMode, next.customPermissions);
        next.workspaces = normalizeWorkspaceCatalog(
          next.workspaceAccess,
          next.workspaces
        );
        break;
      }
      case 'routing.set':
        next.routingStrategy = operation.strategy;
        break;
      case 'assistant.replace':
        next.assistant = structuredClone(operation.assistant);
        break;
      case 'modelRoots.replace':
        next.localModelRoots = [...new Set(operation.roots)];
        break;
      case 'provider.update': {
        const target = next.providers[operation.providerId];
        const patch = operation.patch;
        if (patch.enabled !== undefined) target.enabled = patch.enabled;
        if (patch.baseUrl !== undefined) target.baseUrl = patch.baseUrl;
        if (patch.model !== undefined) target.model = patch.model;
        if (patch.contextWindowTokens !== undefined) {
          target.contextWindowTokens = patch.contextWindowTokens;
        }
        if (patch.maxOutputTokens !== undefined) target.maxOutputTokens = patch.maxOutputTokens;
        if (patch.inference !== undefined) target.inference = structuredClone(patch.inference);
        if (patch.clearApiKey) target.encryptedApiKey = null;
        else if (patch.apiKey) target.encryptedApiKey = cipher.encrypt(patch.apiKey);
        break;
      }
      case 'subagentProviders.replace':
        next.subagentProviders = operation.providers.map((provider) => ({
          ...provider,
          args: [...provider.args]
        }));
        break;
      case 'runtimePolicy.replace':
        next.runtimePolicy = structuredClone(operation.policy);
        break;
    }
  }
  return next;
}

function samePersistedSettings(left: PersistedAgentSettings, right: PersistedAgentSettings): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function createDefaultAgentSettings(): PersistedAgentSettings {
  const customPermissions: AgentCustomPermissions = {
    approvalPolicy: 'risk-based',
    sandboxMode: 'workspace-write',
    allowedPermissions: [...AGENT_TOOL_PERMISSIONS]
  };
  return {
    schemaVersion: 7,
    revision: 1,
    assistant: createDefaultAssistantChatProfile(),
    routingStrategy: 'cloud-first',
    permissionMode: 'request',
    customPermissions,
    workspaceAccess: 'write',
    workspaces: [],
    localModelRoots: [],
    providers: Object.fromEntries(AGENT_PROVIDER_IDS.map((id) => [id, {
      enabled: true,
      baseUrl: AGENT_PROVIDER_CATALOG[id].defaultBaseUrl,
      model: AGENT_PROVIDER_CATALOG[id].defaultModel,
      contextWindowTokens: AGENT_PROVIDER_CATALOG[id].defaultContextWindowTokens,
      maxOutputTokens: AGENT_PROVIDER_CATALOG[id].defaultMaxOutputTokens,
      inference: structuredClone(AGENT_PROVIDER_CATALOG[id].defaultInference),
      encryptedApiKey: null
    }])) as PersistedAgentSettings['providers'],
    subagentProviders: [],
    runtimePolicy: createDefaultRuntimePolicySnapshot()
  };
}

function mapProviders<T>(
  settings: PersistedAgentSettings,
  project: (provider: PersistedAgentSettings['providers'][AgentProviderId]) => T
): Record<AgentProviderId, T> {
  return Object.fromEntries(AGENT_PROVIDER_IDS.map((id) => [id, project(settings.providers[id])])) as Record<AgentProviderId, T>;
}

function parsePersistedAgentSettings(input: unknown): PersistedAgentSettings {
  const parsed = persistedAgentSettingsFileSchema.parse(input);
  const { workspaceRoot: _retiredWorkspaceRoot, ...supported } = parsed;
  const defaults = createDefaultAgentSettings();
  const permissionMode = parsed.permissionMode ?? defaults.permissionMode;
  const customPermissions = parsed.customPermissions ?? defaults.customPermissions;
  const workspaceAccess = parsed.permissionMode
    ? workspaceAccessFor(permissionMode, customPermissions)
    : parsed.workspaceAccess ?? defaults.workspaceAccess;
  const workspaces = migrateWorkspaceCatalog(parsed, workspaceAccess);
  return persistedAgentSettingsSchema.parse({
    ...defaults,
    ...supported,
    schemaVersion: 7,
    revision: (parsed.revision ?? 1) + (parsed.schemaVersion === 7 ? 0 : 1),
    assistant: migrateAssistantChatProfile(parsed.assistant, defaults.assistant),
    permissionMode,
    customPermissions,
    workspaceAccess,
    workspaces: normalizeWorkspaceCatalog(workspaceAccess, workspaces),
    providers: Object.fromEntries(AGENT_PROVIDER_IDS.map((id) => {
      const saved = parsed.providers[id];
      return [id, saved
        ? {
            ...defaults.providers[id],
            ...saved,
            inference: saved.inference ?? defaults.providers[id].inference,
            encryptedApiKey: saved.encryptedApiKey ?? null
          }
        : defaults.providers[id]];
    })),
    subagentProviders: parsed.subagentProviders ?? defaults.subagentProviders,
    runtimePolicy: parsed.runtimePolicy ?? defaults.runtimePolicy
  });
}

function migrateAssistantChatProfile(
  profile: z.infer<typeof persistedAssistantChatProfileFileSchema> | undefined,
  fallback: AssistantChatProfile
): AssistantChatProfile {
  if (profile === undefined) return structuredClone(fallback);
  return assistantChatProfileSchema.parse({
    name: profile.name,
    systemPrompt: profile.systemPrompt,
    userPersona: 'userPersona' in profile ? profile.userPersona : ''
  });
}

function toTomlDocument(settings: PersistedAgentSettings): TomlTable {
  const document = {
    schemaVersion: settings.schemaVersion,
    revision: settings.revision,
    assistant: structuredClone(settings.assistant),
    routingStrategy: settings.routingStrategy,
    permissionMode: settings.permissionMode,
    workspaceAccess: settings.workspaceAccess,
    localModelRoots: settings.localModelRoots,
    customPermissions: structuredClone(settings.customPermissions),
    runtimePolicy: structuredClone(settings.runtimePolicy),
    workspaces: settings.workspaces.map((workspace) => ({ ...workspace })),
    providers: Object.fromEntries(AGENT_PROVIDER_IDS.map((id) => {
      const provider = settings.providers[id];
      return [id, {
        enabled: provider.enabled,
        baseUrl: provider.baseUrl,
        model: provider.model,
        contextWindowTokens: provider.contextWindowTokens,
        maxOutputTokens: provider.maxOutputTokens,
        inference: structuredClone(provider.inference),
        ...(provider.encryptedApiKey ? { encryptedApiKey: provider.encryptedApiKey } : {})
      }];
    })),
    subagentProviders: settings.subagentProviders.map((provider) => ({
      ...provider,
      args: [...provider.args]
    }))
  };
  return JSON.parse(JSON.stringify(document)) as TomlTable;
}

export function resolveRuntimePermissionProfile(
  mode: AgentPermissionMode,
  custom: AgentCustomPermissions
): RuntimeAgentPermissionProfile {
  const approvalPolicy = mode === 'custom' ? custom.approvalPolicy : mode;
  const sandboxMode = mode === 'custom'
    ? custom.sandboxMode
    : mode === 'full-access'
      ? 'danger-full-access'
      : 'workspace-write';
  return {
    approvalPolicy,
    // An AI proposal only opens an Agent Run; it does not grant tool execution.
    // Tool permission is checked at the actual call site against this policy.
    proposalApproval: 'automatic',
    permissionPolicy: approvalPolicy === 'full-access'
      ? 'autoRun'
      : approvalPolicy === 'risk-based'
        ? 'autoEdit'
        : 'confirmBeforeRun',
    sandboxMode,
    allowedPermissions: mode === 'custom' ? [...new Set(custom.allowedPermissions)] : [...AGENT_TOOL_PERMISSIONS]
  };
}

function workspaceAccessFor(mode: AgentPermissionMode, custom: AgentCustomPermissions): 'read' | 'write' {
  const profile = resolveRuntimePermissionProfile(mode, custom);
  if (profile.sandboxMode === 'read-only') return 'read';
  return profile.allowedPermissions.some((permission) => permission === 'write' || permission === 'shell' || permission === 'dangerous')
    ? 'write'
    : 'read';
}

function normalizeWorkspaceCatalog(
  access: 'read' | 'write',
  workspaces: readonly AgentWorkspaceSettingsView[]
): AgentWorkspaceSettingsView[] {
  const result: AgentWorkspaceSettingsView[] = [];
  const workspaceIds = new Set<string>();
  for (const workspace of workspaces) {
    const rootPath = resolve(workspace.rootPath);
    if (workspaceIds.has(workspace.workspaceId)
      || result.some((candidate) => sameWorkspaceRoot(candidate.rootPath, rootPath))) continue;
    result.push({ ...workspace, rootPath, access });
    workspaceIds.add(workspace.workspaceId);
    if (result.length === 32) break;
  }
  return result;
}

function migrateWorkspaceCatalog(
  parsed: z.infer<typeof persistedAgentSettingsFileSchema>,
  access: 'read' | 'write'
): AgentWorkspaceSettingsView[] {
  const candidates = (parsed.workspaces ?? []).map((workspace) => {
    if (workspace.workspaceId !== 'primary') return workspace;
    return {
      ...workspace,
      workspaceId: workspaceIdForRoot(workspace.rootPath)
    };
  });
  if (parsed.workspaceRoot) {
    const rootPath = resolve(parsed.workspaceRoot);
    if (!candidates.some((workspace) => sameWorkspaceRoot(workspace.rootPath, rootPath))) {
      candidates.unshift({
        workspaceId: workspaceIdForRoot(rootPath),
        rootPath,
        access
      });
    }
  }
  return normalizeWorkspaceCatalog(access, candidates);
}

function updateWorkspace(
  settings: PersistedAgentSettings,
  workspaceId: string,
  update: (workspace: PersistedAgentSettings['workspaces'][number]) => PersistedAgentSettings['workspaces'][number]
): PersistedAgentSettings {
  const index = settings.workspaces.findIndex((workspace) => workspace.workspaceId === workspaceId);
  if (index < 0) throw new Error('工作区不存在。');
  const workspaces = [...settings.workspaces];
  workspaces[index] = update(workspaces[index]!);
  return { ...settings, workspaces };
}

function workspaceIdForRoot(rootPath: string): string {
  const identity = process.platform === 'win32' ? resolve(rootPath).toLocaleLowerCase('en-US') : resolve(rootPath);
  return `workspace-${createHash('sha256').update(identity).digest('hex').slice(0, 20)}`;
}

function sameWorkspaceRoot(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.localeCompare(resolvedRight, 'en-US', { sensitivity: 'accent' }) === 0
    : resolvedLeft === resolvedRight;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
