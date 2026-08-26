import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import {
  AgentSettingsRepository,
  resolveRuntimePermissionProfile
} from '../src/main/persistence/agent-settings-repository';
import { shouldRestartRuntimeForAgentSettings } from '../src/main/settings/agent-settings-effects';
import type { SecretCipher } from '../src/main/persistence/secret-cipher';
import type {
  AgentCustomPermissions,
  AgentSettingsMutationResult
} from '../src/shared/contract';

const temporaryDirectories: string[] = [];
const cipher: SecretCipher = {
  encrypt: (value) => `cipher:${Buffer.from(value, 'utf8').toString('base64')}`,
  decrypt: (value) => Buffer.from(value.replace(/^cipher:/, ''), 'base64').toString('utf8')
};

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    if (!directory.startsWith(tmpdir())) throw new Error('Refusing to clean a non-temporary test directory.');
    await rm(directory, { recursive: true, force: true });
  }
});

describe('AgentSettingsRepository', () => {
  it('compares AI capability requests with the configured user permission boundary', () => {
    const custom: AgentCustomPermissions = {
      approvalPolicy: 'full-access',
      sandboxMode: 'danger-full-access',
      allowedPermissions: ['read', 'write', 'shell', 'network', 'dangerous']
    };

    expect(resolveRuntimePermissionProfile('request', custom)).toMatchObject({
      proposalApproval: 'automatic',
      permissionPolicy: 'confirmBeforeRun'
    });
    expect(resolveRuntimePermissionProfile('risk-based', custom)).toMatchObject({
      proposalApproval: 'automatic',
      permissionPolicy: 'autoEdit'
    });
    expect(resolveRuntimePermissionProfile('full-access', custom)).toMatchObject({
      proposalApproval: 'automatic',
      permissionPolicy: 'autoRun'
    });
    expect(resolveRuntimePermissionProfile('custom', custom)).toMatchObject({
      proposalApproval: 'automatic',
      permissionPolicy: 'autoRun'
    });
  });

  it('creates settings.toml and never persists or returns a plaintext API key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ariadne-agent-settings-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'settings.toml');
    const repository = new AgentSettingsRepository(file, cipher, directory);
    await repository.initialize();

    const defaults = repository.getView();
    expect(defaults.schemaVersion).toBe(3);
    expect(defaults.revision).toBe(1);
    expect(defaults.routingStrategy).toBe('cloud-first');
    expect(defaults.runtimePolicy).toMatchObject({
      schemaVersion: 1,
      mcp: { servers: [], legacySseFallback: false },
      browser: { sessionMode: 'temporary', allowSensitiveInput: false },
      telemetry: { enabled: false }
    });
    expect(defaults.providers.openai.apiKeyStatus).toBe('missing');
    expect(defaults.providers.openai).toMatchObject({
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_384
    });
    expect(parseToml(await readFile(file, 'utf8'))).toMatchObject({
      permissionMode: 'request',
      workspaceRoot: directory,
      workspaceAccess: 'write',
      workspaces: [{ workspaceId: 'primary', rootPath: directory, access: 'write' }]
    });

    await expectApplied(repository.mutate({
      expectedRevision: defaults.revision,
      operations: [{
        kind: 'provider.update',
        providerId: 'openai',
        patch: {
          apiKey: 'sk-test-not-a-real-secret',
          contextWindowTokens: 64_000,
          maxOutputTokens: 8_000
        }
      }]
    }));
    const serialized = await readFile(file, 'utf8');
    expect(serialized).not.toContain('sk-test-not-a-real-secret');
    expect(serialized).toContain('cipher:');
    expect(repository.getView().providers.openai.apiKeyStatus).toBe('configured');
    expect(repository.getRuntimeSettings().providers.openai.apiKey).toBe('sk-test-not-a-real-secret');
    expect(repository.getRuntimeSettings().providers.openai).toMatchObject({
      contextWindowTokens: 64_000,
      maxOutputTokens: 8_000
    });

    const openedWorkspace = join(directory, 'opened-workspace');
    const opened = await repository.addWorkspaceRoot(openedWorkspace);
    expect(opened).toMatchObject({
      added: true,
      workspace: { rootPath: openedWorkspace, access: 'write' }
    });
    expect(repository.getRuntimeSettings()).toMatchObject({
      workspaceRoot: directory,
      workspaceAccess: 'write',
      workspaces: [
        { workspaceId: 'primary', rootPath: directory, access: 'write' },
        { rootPath: openedWorkspace, access: 'write' }
      ]
    });
    await expect(repository.addWorkspaceRoot(openedWorkspace)).resolves.toMatchObject({ added: false });
    expect(repository.getRuntimeSettings().workspaces).toHaveLength(2);
    expect(repository.getRuntimeSettings().providers.openai.apiKey).toBe('sk-test-not-a-real-secret');

    const beforeWorkspaceUpdate = repository.getView();
    const workspaceMutation = await expectApplied(repository.mutate({
      expectedRevision: beforeWorkspaceUpdate.revision,
      operations: [
        { kind: 'workspace.select', rootPath: join(directory, 'chosen-workspace') },
        {
          kind: 'permissions.set',
          mode: 'custom',
          customPermissions: {
            approvalPolicy: 'request',
            sandboxMode: 'read-only',
            allowedPermissions: ['read', 'network']
          }
        }
      ]
    }));
    expect(workspaceMutation.settings.revision).toBe(beforeWorkspaceUpdate.revision + 1);
    expect(repository.getRuntimeSettings()).toMatchObject({
      workspaceRoot: join(directory, 'chosen-workspace'),
      workspaceAccess: 'read',
      workspaces: [
        { workspaceId: 'primary', rootPath: join(directory, 'chosen-workspace'), access: 'read' },
        { rootPath: openedWorkspace, access: 'read' }
      ]
    });

    const reloaded = new AgentSettingsRepository(file, cipher, directory);
    await reloaded.initialize();
    expect(reloaded.getView().providers.openai.apiKeyStatus).toBe('configured');
    expect(reloaded.getView().providers.openai).toMatchObject({
      contextWindowTokens: 64_000,
      maxOutputTokens: 8_000
    });
    expect(reloaded.getView()).toMatchObject({
      workspaceRoot: join(directory, 'chosen-workspace'),
      workspaceAccess: 'read',
      workspaces: [
        { workspaceId: 'primary', rootPath: join(directory, 'chosen-workspace'), access: 'read' },
        { rootPath: openedWorkspace, access: 'read' }
      ]
    });
  });

  it('supports an explicit clear action without treating an empty field as a replacement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ariadne-agent-settings-clear-'));
    temporaryDirectories.push(directory);
    const repository = new AgentSettingsRepository(join(directory, 'settings.toml'), cipher, directory);
    await repository.initialize();
    const defaults = repository.getView();
    await expectApplied(repository.mutate({
      expectedRevision: defaults.revision,
      operations: [{
        kind: 'provider.update',
        providerId: 'deepseek',
        patch: { apiKey: 'deepseek-test-secret' }
      }]
    }));
    const configured = repository.getView();
    await expectApplied(repository.mutate({
      expectedRevision: configured.revision,
      operations: [{
        kind: 'provider.update',
        providerId: 'deepseek',
        patch: { model: configured.providers.deepseek.model }
      }]
    }));
    expect(repository.getRuntimeSettings().providers.deepseek.apiKey).toBe('deepseek-test-secret');
    const beforeClear = repository.getView();
    await expectApplied(repository.mutate({
      expectedRevision: beforeClear.revision,
      operations: [{
        kind: 'provider.update',
        providerId: 'deepseek',
        patch: { clearApiKey: true }
      }]
    }));
    expect(repository.getView().providers.deepseek.apiKeyStatus).toBe('missing');
  });

  it('rejects stale revisions so Chat and Settings cannot overwrite each other', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ariadne-agent-settings-revision-'));
    temporaryDirectories.push(directory);
    const repository = new AgentSettingsRepository(join(directory, 'settings.toml'), cipher, directory);
    await repository.initialize();
    const sharedSnapshot = repository.getView();

    const permissionResult = await expectApplied(repository.mutate({
      expectedRevision: sharedSnapshot.revision,
      operations: [{ kind: 'permissions.set', mode: 'risk-based' }]
    }));
    expect(permissionResult.effect).toBe('reload_scheduled');
    expect(shouldRestartRuntimeForAgentSettings(permissionResult.effect)).toBe(false);

    const staleSettingsPanelResult = await repository.mutate({
      expectedRevision: sharedSnapshot.revision,
      operations: [{
        kind: 'provider.update',
        providerId: 'openai',
        patch: { model: 'settings-panel-model' }
      }]
    });
    expect(staleSettingsPanelResult).toMatchObject({
      ok: false,
      error: {
        code: 'settings_revision_conflict',
        expectedRevision: sharedSnapshot.revision,
        currentRevision: permissionResult.settings.revision
      }
    });
    expect(repository.getView()).toMatchObject({
      permissionMode: 'risk-based',
      providers: { openai: { model: sharedSnapshot.providers.openai.model } }
    });

    if (staleSettingsPanelResult.ok) throw new Error('Expected a revision conflict.');
    const retriedSettingsPanelResult = await expectApplied(repository.mutate({
      expectedRevision: staleSettingsPanelResult.settings.revision,
      operations: [{
        kind: 'provider.update',
        providerId: 'openai',
        patch: { model: 'settings-panel-model' }
      }]
    }));
    expect(retriedSettingsPanelResult.settings).toMatchObject({
      permissionMode: 'risk-based',
      providers: { openai: { model: 'settings-panel-model' } }
    });
  });

  it('adds newly registered Providers and model profiles without discarding existing settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ariadne-agent-settings-migration-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'settings.toml');
    const legacyFile = join(directory, 'agent-settings.json');
    await writeFile(legacyFile, JSON.stringify({
      schemaVersion: 1,
      routingStrategy: 'local-first',
      localModelRoots: [],
      providers: {
        openai: { enabled: true, baseUrl: 'https://api.openai.com/v1', model: 'legacy-openai', encryptedApiKey: null },
        deepseek: { enabled: true, baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', encryptedApiKey: null },
        anthropic: { enabled: false, baseUrl: 'https://api.anthropic.com', model: 'legacy-claude', encryptedApiKey: null }
      }
    }));

    const repository = new AgentSettingsRepository(file, cipher, directory, legacyFile);
    await repository.initialize();
    const migrated = repository.getView();
    expect(migrated.routingStrategy).toBe('local-first');
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.revision).toBe(1);
    expect(migrated.runtimePolicy.embedding).toEqual({ provider: 'lexical' });
    expect(migrated.workspaceRoot).toBe(directory);
    expect(migrated.workspaceAccess).toBe('write');
    expect(migrated.workspaces).toEqual([{ workspaceId: 'primary', rootPath: directory, access: 'write' }]);
    expect(migrated.providers.openai.model).toBe('legacy-openai');
    expect(migrated.providers.kimi.model).toBe('kimi-k3');
    expect(migrated.providers.deepseek.inference.reasoning?.efforts).toEqual(['high', 'max']);
    expect(await readFile(file, 'utf8')).toContain('routingStrategy = "local-first"');
    expect((await readdir(directory)).some((name) => name.startsWith('agent-settings.json.migrated-'))).toBe(true);
    await expect(readFile(legacyFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('upgrades the previous schema-2 TOML in place while preserving encrypted credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ariadne-agent-settings-schema-2-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'settings.toml');
    const original = new AgentSettingsRepository(file, cipher, directory);
    await original.initialize();
    const defaults = original.getView();
    await expectApplied(original.mutate({
      expectedRevision: defaults.revision,
      operations: [{
        kind: 'provider.update',
        providerId: 'openai',
        patch: { apiKey: 'schema-two-secret' }
      }]
    }));

    const previousDocument = parseToml(await readFile(file, 'utf8'));
    previousDocument.schemaVersion = 2;
    delete previousDocument.revision;
    await writeFile(file, stringifyToml(previousDocument));

    const upgraded = new AgentSettingsRepository(file, cipher, directory);
    await upgraded.initialize();
    expect(upgraded.getView()).toMatchObject({
      schemaVersion: 3,
      revision: 1,
      providers: { openai: { apiKeyStatus: 'configured' } }
    });
    expect(upgraded.getRuntimeSettings().providers.openai.apiKey).toBe('schema-two-secret');
    expect(parseToml(await readFile(file, 'utf8'))).toMatchObject({ schemaVersion: 3, revision: 1 });
  });

  it('recovers its write queue without exposing settings that failed to persist', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ariadne-agent-settings-recovery-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'settings.toml');
    const repository = new AgentSettingsRepository(file, cipher, directory);
    await repository.initialize();
    const initial = repository.getView();
    const checkpoint = repository.createCheckpoint();
    await rm(file);
    await mkdir(file);
    await expect(repository.mutate({
      expectedRevision: initial.revision,
      operations: [{ kind: 'routing.set', strategy: 'local-first' }]
    })).rejects.toBeInstanceOf(Error);
    expect(repository.getView().routingStrategy).toBe(initial.routingStrategy);

    await rm(file, { recursive: true });
    await expectApplied(repository.mutate({
      expectedRevision: initial.revision,
      operations: [{ kind: 'routing.set', strategy: 'local-first' }]
    }));

    expect(repository.getView().routingStrategy).toBe('local-first');
    expect(parseToml(await readFile(file, 'utf8'))).toMatchObject({ routingStrategy: 'local-first' });

    await repository.restore(checkpoint);
    expect(repository.getView().routingStrategy).toBe(initial.routingStrategy);
    expect(parseToml(await readFile(file, 'utf8'))).toMatchObject({
      routingStrategy: initial.routingStrategy
    });
  });

  it('fails closed when invalid settings cannot be preserved before recovery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ariadne-agent-settings-backup-failure-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'settings.toml');
    await writeFile(file, 'routingStrategy = [invalid');
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_234_567_890);
    await mkdir(`${file}.invalid-1234567890`);
    const repository = new AgentSettingsRepository(file, cipher, directory);

    try {
      await expect(repository.initialize()).rejects.toThrow(
        'Unable to preserve invalid Ariadne settings before recovery.'
      );
    } finally {
      now.mockRestore();
    }

    expect(await readFile(file, 'utf8')).toBe('routingStrategy = [invalid');
  });

  it('serializes duplicate workspace additions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ariadne-agent-settings-concurrent-'));
    temporaryDirectories.push(directory);
    const repository = new AgentSettingsRepository(join(directory, 'settings.toml'), cipher, directory);
    await repository.initialize();
    const workspaceRoot = join(directory, 'shared-workspace');

    const results = await Promise.all([
      repository.addWorkspaceRoot(workspaceRoot),
      repository.addWorkspaceRoot(workspaceRoot)
    ]);

    expect(results.map((result) => result.added).sort()).toEqual([false, true]);
    expect(repository.getView().workspaces.filter((workspace) => workspace.rootPath === workspaceRoot)).toHaveLength(1);
  });

  it('persists workspace pinning and keeps archived workspaces recoverable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ariadne-agent-settings-archive-'));
    temporaryDirectories.push(directory);
    const repository = new AgentSettingsRepository(join(directory, 'settings.toml'), cipher, directory);
    await repository.initialize();
    const opened = await repository.addWorkspaceRoot(join(directory, 'workspace-to-archive'));
    const workspaceId = opened.workspace.workspaceId;
    const archivedAt = new Date('2026-07-30T00:00:00.000Z');

    await repository.setWorkspacePinned(workspaceId, true);
    expect(repository.getView().workspaces.find((workspace) => workspace.workspaceId === workspaceId))
      .toMatchObject({ pinned: true });

    await repository.archiveWorkspace(workspaceId, archivedAt);
    expect(repository.getView().workspaces.find((workspace) => workspace.workspaceId === workspaceId))
      .toMatchObject({ archivedAt: archivedAt.toISOString() });
    expect(repository.getView().workspaces.find((workspace) => workspace.workspaceId === workspaceId))
      .not.toHaveProperty('pinned');
    const reloaded = new AgentSettingsRepository(join(directory, 'settings.toml'), cipher, directory);
    await reloaded.initialize();
    expect(reloaded.getView().workspaces.find((workspace) => workspace.workspaceId === workspaceId))
      .toMatchObject({ archivedAt: archivedAt.toISOString() });

    await reloaded.restoreWorkspace(workspaceId);
    const restored = reloaded.getView().workspaces.find((workspace) => workspace.workspaceId === workspaceId);
    expect(restored).not.toHaveProperty('archivedAt');
  });

  it('normalizes duplicate persisted workspace identifiers before Host authorization', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ariadne-agent-settings-workspace-ids-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'settings.toml');
    const legacyFile = join(directory, 'agent-settings.json');
    await writeFile(legacyFile, JSON.stringify({
      schemaVersion: 1,
      routingStrategy: 'cloud-first',
      workspaceRoot: directory,
      workspaces: [
        { workspaceId: 'primary', rootPath: directory, access: 'write' },
        { workspaceId: 'duplicate', rootPath: join(directory, 'one'), access: 'write' },
        { workspaceId: 'duplicate', rootPath: join(directory, 'two'), access: 'write' }
      ],
      localModelRoots: [],
      providers: {}
    }));
    const repository = new AgentSettingsRepository(file, cipher, directory, legacyFile);

    await repository.initialize();

    expect(repository.getView().workspaces).toEqual([
      { workspaceId: 'primary', rootPath: directory, access: 'write' },
      { workspaceId: 'duplicate', rootPath: join(directory, 'one'), access: 'write' }
    ]);
  });
});

async function expectApplied(
  mutation: Promise<AgentSettingsMutationResult>
): Promise<Extract<AgentSettingsMutationResult, { ok: true }>> {
  const result = await mutation;
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  return result;
}
