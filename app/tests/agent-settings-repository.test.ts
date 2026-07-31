import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import {
  AgentSettingsRepository,
  resolveRuntimePermissionProfile
} from '../src/main/persistence/agent-settings-repository';
import type { SecretCipher } from '../src/main/persistence/secret-cipher';
import {
  AGENT_PROVIDER_IDS,
  WORKSPACE_ARCHIVE_RETENTION_MS,
  type AgentCustomPermissions,
  type AgentProviderId,
  type AgentSettingsUpdate
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
    expect(defaults.schemaVersion).toBe(2);
    expect(defaults.routingStrategy).toBe('cloud-first');
    expect(defaults.runtimePolicy).toMatchObject({
      schemaVersion: 1,
      mcp: { servers: [], legacySseFallback: false },
      browser: { sessionMode: 'temporary', allowSensitiveInput: false },
      telemetry: { enabled: false }
    });
    expect(defaults.providers.openai.apiKeyStatus).toBe('missing');
    expect(parseToml(await readFile(file, 'utf8'))).toMatchObject({
      permissionMode: 'request',
      workspaceRoot: directory,
      workspaceAccess: 'write',
      workspaces: [{ workspaceId: 'primary', rootPath: directory, access: 'write' }]
    });

    await repository.save(updateFrom(defaults, {
      openai: { apiKey: 'sk-test-not-a-real-secret', clearApiKey: false }
    }));
    const serialized = await readFile(file, 'utf8');
    expect(serialized).not.toContain('sk-test-not-a-real-secret');
    expect(serialized).toContain('cipher:');
    expect(repository.getView().providers.openai.apiKeyStatus).toBe('configured');
    expect(repository.getRuntimeSettings().providers.openai.apiKey).toBe('sk-test-not-a-real-secret');

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

    const workspaceUpdate = updateFrom(repository.getView());
    workspaceUpdate.workspaceRoot = join(directory, 'chosen-workspace');
    workspaceUpdate.permissionMode = 'custom';
    workspaceUpdate.customPermissions = {
      approvalPolicy: 'request',
      sandboxMode: 'read-only',
      allowedPermissions: ['read', 'network']
    };
    await repository.save(workspaceUpdate);
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
    await repository.save(updateFrom(defaults, {
      deepseek: { apiKey: 'deepseek-test-secret', clearApiKey: false }
    }));
    const configured = repository.getView();
    await repository.save(updateFrom(configured));
    expect(repository.getRuntimeSettings().providers.deepseek.apiKey).toBe('deepseek-test-secret');
    await repository.save(updateFrom(configured, {
      deepseek: { clearApiKey: true }
    }));
    expect(repository.getView().providers.deepseek.apiKeyStatus).toBe('missing');
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
    expect(migrated.schemaVersion).toBe(2);
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

  it('recovers its write queue without exposing settings that failed to persist', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ariadne-agent-settings-recovery-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'settings.toml');
    const repository = new AgentSettingsRepository(file, cipher, directory);
    await repository.initialize();
    const initial = repository.getView();
    const checkpoint = repository.createCheckpoint();
    const changed = updateFrom(initial);
    changed.routingStrategy = 'local-first';

    await rm(file);
    await mkdir(file);
    await expect(repository.save(changed)).rejects.toBeInstanceOf(Error);
    expect(repository.getView().routingStrategy).toBe(initial.routingStrategy);

    await rm(file, { recursive: true });
    await repository.save(changed);

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

  it('persists workspace pinning and enforces the seven-day archive cleanup lifecycle', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ariadne-agent-settings-archive-'));
    temporaryDirectories.push(directory);
    const repository = new AgentSettingsRepository(join(directory, 'settings.toml'), cipher, directory);
    await repository.initialize();
    const opened = await repository.addWorkspaceRoot(join(directory, 'workspace-to-archive'));
    const workspaceId = opened.workspace.workspaceId;
    const archivedAt = new Date('2026-07-30T00:00:00.000Z');
    const purgeAt = new Date(archivedAt.getTime() + WORKSPACE_ARCHIVE_RETENTION_MS);

    await repository.setWorkspacePinned(workspaceId, true);
    expect(repository.getView().workspaces.find((workspace) => workspace.workspaceId === workspaceId))
      .toMatchObject({ pinned: true });

    await repository.archiveWorkspace(workspaceId, archivedAt);
    expect(repository.getView().workspaces.find((workspace) => workspace.workspaceId === workspaceId))
      .toMatchObject({
        archivedAt: archivedAt.toISOString(),
        purgeAfter: purgeAt.toISOString()
      });
    expect(repository.getView().workspaces.find((workspace) => workspace.workspaceId === workspaceId))
      .not.toHaveProperty('pinned');
    expect(repository.dueArchivedWorkspaceIds(new Date(purgeAt.getTime() - 1))).toEqual([]);
    expect(repository.dueArchivedWorkspaceIds(purgeAt)).toEqual([workspaceId]);
    expect(repository.nextArchivedWorkspacePurgeAt()).toBe(purgeAt.toISOString());

    await repository.markWorkspacePurged(workspaceId, purgeAt);
    expect(repository.getView().workspaces.find((workspace) => workspace.workspaceId === workspaceId))
      .toMatchObject({ purgedAt: purgeAt.toISOString() });
    expect(repository.nextArchivedWorkspacePurgeAt()).toBeNull();

    const reloaded = new AgentSettingsRepository(join(directory, 'settings.toml'), cipher, directory);
    await reloaded.initialize();
    expect(reloaded.getView().workspaces.find((workspace) => workspace.workspaceId === workspaceId))
      .toMatchObject({ archivedAt: archivedAt.toISOString(), purgedAt: purgeAt.toISOString() });

    await reloaded.restoreWorkspace(workspaceId);
    const restored = reloaded.getView().workspaces.find((workspace) => workspace.workspaceId === workspaceId);
    expect(restored).not.toHaveProperty('archivedAt');
    expect(restored).not.toHaveProperty('purgeAfter');
    expect(restored).not.toHaveProperty('purgedAt');
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

function updateFrom(
  view: ReturnType<AgentSettingsRepository['getView']>,
  overrides: Partial<Record<AgentProviderId, { apiKey?: string; clearApiKey: boolean }>> = {}
): AgentSettingsUpdate {
  return {
    routingStrategy: view.routingStrategy,
    permissionMode: view.permissionMode,
    customPermissions: view.customPermissions,
    workspaceRoot: view.workspaceRoot,
    workspaceAccess: view.workspaceAccess,
    localModelRoots: view.localModelRoots,
    providers: Object.fromEntries(AGENT_PROVIDER_IDS.map((id) => [
      id,
      providerUpdate(view.providers[id], overrides[id])
    ])) as AgentSettingsUpdate['providers']
  };
}

function providerUpdate(
  provider: ReturnType<AgentSettingsRepository['getView']>['providers']['openai'],
  override?: { apiKey?: string; clearApiKey: boolean }
) {
  return {
    enabled: provider.enabled,
    baseUrl: provider.baseUrl,
    model: provider.model,
    inference: provider.inference,
    clearApiKey: override?.clearApiKey ?? false,
    ...(override?.apiKey ? { apiKey: override.apiKey } : {})
  };
}
