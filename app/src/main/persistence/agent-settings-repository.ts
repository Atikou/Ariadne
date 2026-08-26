import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parse as parseToml, stringify as stringifyToml, type TomlTable } from 'smol-toml';
import { z } from 'zod';
import { modelInferenceProfileSchema, type ModelInferenceProfile } from '@ariadne/protocol/public';
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
  inference: modelInferenceProfileSchema,
  encryptedApiKey: encryptedApiKeySchema
}).strict();
const persistedProviderFileSchema = z.object({
  enabled: z.boolean(),
  baseUrl: z.string().url().max(2_048).refine((value) => new URL(value).protocol === 'https:'),
  model: z.string().trim().min(1).max(256),
  inference: modelInferenceProfileSchema.optional(),
  encryptedApiKey: encryptedApiKeySchema.optional()
}).strict();
const persistedAgentSettingsBase = {
  schemaVersion: z.literal(3),
  revision: z.number().int().positive(),
  routingStrategy: agentRoutingStrategySchema,
  localModelRoots: z.array(z.string().min(1).max(32_768).refine(
    (value) => /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value)
  )).max(8)
};
const persistedAgentSettingsSchema = z.object({
  ...persistedAgentSettingsBase,
  permissionMode: z.enum(AGENT_PERMISSION_MODES),
  customPermissions: customPermissionsSchema,
  workspaceRoot: absoluteWorkspacePathSchema,
  workspaceAccess: z.enum(['read', 'write']),
  workspaces: z.array(persistedWorkspaceSchema).min(1).max(32),
  providers: z.record(agentProviderIdSchema, persistedProviderSchema),
  runtimePolicy: runtimePolicySnapshotSchema
}).strict();
const persistedAgentSettingsFileSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  revision: z.number().int().positive().optional(),
  routingStrategy: agentRoutingStrategySchema,
  localModelRoots: z.array(z.string().min(1).max(32_768).refine(
    (value) => /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value)
  )).max(8),
  permissionMode: z.enum(AGENT_PERMISSION_MODES).optional(),
  customPermissions: customPermissionsSchema.optional(),
  workspaceRoot: absoluteWorkspacePathSchema.optional(),
  workspaceAccess: z.enum(['read', 'write']).optional(),
  workspaces: z.array(persistedWorkspaceSchema).min(1).max(32).optional(),
  providers: z.partialRecord(agentProviderIdSchema, persistedProviderFileSchema),
  runtimePolicy: runtimePolicySnapshotSchema.optional()
}).strict();

type PersistedAgentSettings = z.infer<typeof persistedAgentSettingsSchema>;

export interface AgentSettingsCheckpoint {
  readonly serialized: string;
}

export interface RuntimeAgentProviderSettings {
  enabled: boolean;
  baseUrl: string;
  model: string;
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
  routingStrategy: AgentSettingsView['routingStrategy'];
  permissionMode: AgentPermissionMode;
  permissions: RuntimeAgentPermissionProfile;
  workspaceRoot: string;
  workspaceAccess: 'read' | 'write';
  workspaces: AgentWorkspaceSettingsView[];
  localModelRoots: string[];
  providers: Record<AgentProviderId, RuntimeAgentProviderSettings>;
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
    private readonly defaultWorkspaceRoot: string,
    private readonly legacyJsonPath?: string
  ) {
    this.settings = createDefaultAgentSettings(defaultWorkspaceRoot);
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
      this.settings = parsePersistedAgentSettings(parseToml(raw), this.defaultWorkspaceRoot);
    } catch {
      await this.backupInvalidFile(this.filePath);
      this.settings = createDefaultAgentSettings(this.defaultWorkspaceRoot);
    }
    await this.queueWrite(this.settings);
  }

  getView(): AgentSettingsView {
    return {
      schemaVersion: 3,
      revision: this.settings.revision,
      routingStrategy: this.settings.routingStrategy,
      permissionMode: this.settings.permissionMode,
      customPermissions: structuredClone(this.settings.customPermissions),
      workspaceRoot: this.settings.workspaceRoot,
      workspaceAccess: this.settings.workspaceAccess,
      workspaces: this.settings.workspaces.map((workspace) => ({ ...workspace })),
      localModelRoots: [...this.settings.localModelRoots],
      providers: mapProviders(this.settings, (provider) => ({
        enabled: provider.enabled,
        baseUrl: provider.baseUrl,
        model: provider.model,
        inference: structuredClone(provider.inference),
        apiKeyStatus: this.apiKeyStatus(provider.encryptedApiKey)
      })),
      runtimePolicy: structuredClone(this.settings.runtimePolicy)
    };
  }

  getRuntimeSettings(): RuntimeAgentSettings {
    return {
      revision: this.settings.revision,
      routingStrategy: this.settings.routingStrategy,
      permissionMode: this.settings.permissionMode,
      permissions: resolveRuntimePermissionProfile(this.settings.permissionMode, this.settings.customPermissions),
      workspaceRoot: this.settings.workspaceRoot,
      workspaceAccess: this.settings.workspaceAccess,
      workspaces: this.settings.workspaces.map((workspace) => ({ ...workspace })),
      localModelRoots: [...this.settings.localModelRoots],
      providers: mapProviders(this.settings, (provider) => {
        const apiKey = this.tryDecrypt(provider.encryptedApiKey);
        return {
          enabled: provider.enabled,
          baseUrl: provider.baseUrl,
          model: provider.model,
          inference: structuredClone(provider.inference),
          ...(apiKey ? { apiKey } : {})
        };
      }),
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
          schemaVersion: 3,
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
    if (workspaceId === 'primary') throw new Error('默认会话目录不能归档。');
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
    if (this.legacyJsonPath) {
      let legacyRaw: string | undefined;
      try {
        legacyRaw = await readFile(this.legacyJsonPath, 'utf8');
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
      if (legacyRaw !== undefined) {
        try {
          this.settings = parsePersistedAgentSettings(JSON.parse(legacyRaw), this.defaultWorkspaceRoot);
        } catch {
          await this.backupInvalidFile(this.legacyJsonPath);
          this.settings = createDefaultAgentSettings(this.defaultWorkspaceRoot);
          await this.queueWrite(this.settings);
          return;
        }
        await this.queueWrite(this.settings);
        await rename(this.legacyJsonPath, `${this.legacyJsonPath}.migrated-${Date.now()}`);
        return;
      }
    }
    this.settings = createDefaultAgentSettings(this.defaultWorkspaceRoot);
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
          schemaVersion: 3,
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
          next.workspaceRoot,
          next.workspaceAccess,
          next.workspaces
        );
        break;
      }
      case 'routing.set':
        next.routingStrategy = operation.strategy;
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
        if (patch.inference !== undefined) target.inference = structuredClone(patch.inference);
        if (patch.clearApiKey) target.encryptedApiKey = null;
        else if (patch.apiKey) target.encryptedApiKey = cipher.encrypt(patch.apiKey);
        break;
      }
      case 'runtimePolicy.replace':
        next.runtimePolicy = structuredClone(operation.policy);
        break;
      case 'workspace.select':
        next.workspaceRoot = resolve(operation.rootPath);
        next.workspaces = normalizeWorkspaceCatalog(
          next.workspaceRoot,
          next.workspaceAccess,
          next.workspaces
        );
        break;
    }
  }
  return next;
}

function samePersistedSettings(left: PersistedAgentSettings, right: PersistedAgentSettings): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function createDefaultAgentSettings(defaultWorkspaceRoot: string): PersistedAgentSettings {
  const customPermissions: AgentCustomPermissions = {
    approvalPolicy: 'risk-based',
    sandboxMode: 'workspace-write',
    allowedPermissions: [...AGENT_TOOL_PERMISSIONS]
  };
  return {
    schemaVersion: 3,
    revision: 1,
    routingStrategy: 'cloud-first',
    permissionMode: 'request',
    customPermissions,
    workspaceRoot: defaultWorkspaceRoot,
    workspaceAccess: 'write',
    workspaces: [{ workspaceId: 'primary', rootPath: resolve(defaultWorkspaceRoot), access: 'write' }],
    localModelRoots: [],
    providers: Object.fromEntries(AGENT_PROVIDER_IDS.map((id) => [id, {
      enabled: true,
      baseUrl: AGENT_PROVIDER_CATALOG[id].defaultBaseUrl,
      model: AGENT_PROVIDER_CATALOG[id].defaultModel,
      inference: structuredClone(AGENT_PROVIDER_CATALOG[id].defaultInference),
      encryptedApiKey: null
    }])) as PersistedAgentSettings['providers'],
    runtimePolicy: createDefaultRuntimePolicySnapshot()
  };
}

function mapProviders<T>(
  settings: PersistedAgentSettings,
  project: (provider: PersistedAgentSettings['providers'][AgentProviderId]) => T
): Record<AgentProviderId, T> {
  return Object.fromEntries(AGENT_PROVIDER_IDS.map((id) => [id, project(settings.providers[id])])) as Record<AgentProviderId, T>;
}

function parsePersistedAgentSettings(input: unknown, defaultWorkspaceRoot: string): PersistedAgentSettings {
  const parsed = persistedAgentSettingsFileSchema.parse(input);
  const defaults = createDefaultAgentSettings(defaultWorkspaceRoot);
  const permissionMode = parsed.permissionMode ?? defaults.permissionMode;
  const customPermissions = parsed.customPermissions ?? defaults.customPermissions;
  const workspaceRoot = resolve(parsed.workspaceRoot ?? defaults.workspaceRoot);
  const workspaceAccess = parsed.permissionMode
    ? workspaceAccessFor(permissionMode, customPermissions)
    : parsed.workspaceAccess ?? defaults.workspaceAccess;
  return persistedAgentSettingsSchema.parse({
    ...defaults,
    ...parsed,
    schemaVersion: 3,
    revision: parsed.revision ?? 1,
    permissionMode,
    customPermissions,
    workspaceRoot,
    workspaceAccess,
    workspaces: normalizeWorkspaceCatalog(workspaceRoot, workspaceAccess, parsed.workspaces ?? []),
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
    runtimePolicy: parsed.runtimePolicy ?? defaults.runtimePolicy
  });
}

function toTomlDocument(settings: PersistedAgentSettings): TomlTable {
  const document = {
    schemaVersion: settings.schemaVersion,
    revision: settings.revision,
    routingStrategy: settings.routingStrategy,
    permissionMode: settings.permissionMode,
    workspaceRoot: settings.workspaceRoot,
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
        inference: structuredClone(provider.inference),
        ...(provider.encryptedApiKey ? { encryptedApiKey: provider.encryptedApiKey } : {})
      }];
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
  primaryRoot: string,
  access: 'read' | 'write',
  workspaces: readonly AgentWorkspaceSettingsView[]
): AgentWorkspaceSettingsView[] {
  const normalizedPrimaryRoot = resolve(primaryRoot);
  const existingPrimary = workspaces.find((workspace) => workspace.workspaceId === 'primary');
  const result: AgentWorkspaceSettingsView[] = [{
    workspaceId: 'primary',
    rootPath: normalizedPrimaryRoot,
    access,
    ...workspaceLifecycleMetadata(existingPrimary)
  }];
  const workspaceIds = new Set(['primary']);
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

function workspaceLifecycleMetadata(
  workspace: AgentWorkspaceSettingsView | undefined
): Pick<AgentWorkspaceSettingsView, 'pinned' | 'archivedAt'> {
  if (!workspace) return {};
  return {
    ...(workspace.pinned ? { pinned: true } : {}),
    ...(workspace.archivedAt ? { archivedAt: workspace.archivedAt } : {})
  };
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
