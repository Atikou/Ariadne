import { addFixtureProvider, fixtureProvider } from './support/remote-provider-fixture';
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
import { MainCredentialAuthority } from '../src/main/runtime/credential-authority';
import type { McpOAuthCredentialVault } from '../src/main/persistence/mcp-oauth-credential-vault';
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
  it.each(['local-first', 'cloud-first', 'privacy-first', 'quality-first'])('retires the saved %s route once without resetting other settings or credentials', async (route) => {
    const directory = await mkdtemp(join(tmpdir(), 'ariadne-retired-routing-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'settings.toml');
    const initial = new AgentSettingsRepository(file, cipher);
    await initial.initialize();
    const document = parseToml(await readFile(file, 'utf8'));
    document.schemaVersion = 8;
    delete document.modelSelection;
    document.routingStrategy = route;
    document.localModelRoots = ['E:\\Models'];
    document.providers = { saved: { ...fixtureProvider('openai'), encryptedApiKey: cipher.encrypt('retained-fixture-key') } };
    await writeFile(file, stringifyToml(document));
    const migrated = new AgentSettingsRepository(file, cipher);
    await migrated.initialize();
    expect(migrated.getView()).toMatchObject({ modelSelection: { modelId: '', localFallbackModelId: '' }, revision: 1, localModelRoots: ['E:\\Models'] });
    expect(migrated.getRuntimeSettings().revision).toBe(document.revision);
    expect(migrated.resolveProviderApiKey('saved')).toBe('retained-fixture-key');
    expect(parseToml(await readFile(file, 'utf8')).routingStrategy).toBeUndefined();
    const reopened = new AgentSettingsRepository(file, cipher);
    await reopened.initialize();
    expect(reopened.getView()).toEqual(migrated.getView());
    expect(reopened.resolveProviderApiKey('saved')).toBe('retained-fixture-key');
  });
  it('isolates credentials and identities for two connections using the same API model across reopen and deletion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ariadne-remote-connections-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'settings.toml');
    let repository = new AgentSettingsRepository(file, cipher);
    await repository.initialize();
    await expectApplied(repository.mutate({ expectedRevision: 1, operations: ['primary', 'backup'].map(id => ({
      kind: 'provider.add' as const, providerId: id, apiKey: `${id}-fixture-key`,
      provider: { ...fixtureProvider('deepseek'), modelId: `remote-${id}`, label: id,
        baseUrl: `https://${id}.example/v1`, model: 'same-model' }
    })) }));
    repository = new AgentSettingsRepository(file, cipher);
    await repository.initialize();
    const authority = new MainCredentialAuthority(repository, {} as McpOAuthCredentialVault);
    for (const id of ['primary', 'backup']) {
      expect(authority.handle({ kind: 'credential.resolve', credentialRef: `model:${id}`, purpose: 'model_inference' }))
        .toEqual({ credential: `${id}-fixture-key` });
      expect(repository.getView().providers[id]).toMatchObject({ modelId: `remote-${id}`, model: 'same-model', apiKeyStatus: 'configured' });
    }
    expect(JSON.stringify(repository.getView())).not.toContain('fixture-key');
    await expectApplied(repository.mutate({ expectedRevision: repository.getView().revision, operations: [
      { kind: 'provider.remove', providerId: 'primary' },
      { kind: 'provider.update', providerId: 'backup', patch: { model: 'updated-model' } }
    ] }));
    expect(() => authority.handle({ kind: 'credential.resolve', credentialRef: 'model:primary', purpose: 'model_inference' }))
      .toThrow('credential_resolution_not_authorized');
    expect(authority.handle({ kind: 'credential.resolve', credentialRef: 'model:backup', purpose: 'model_inference' }))
      .toEqual({ credential: 'backup-fixture-key' });
    const reopened = new AgentSettingsRepository(file, cipher);
    await reopened.initialize();
    expect(Object.keys(reopened.getView().providers)).toEqual(['backup']);
    expect(reopened.getView().providers.backup).toMatchObject({ modelId: 'remote-backup', model: 'updated-model' });
    expect(await readFile(file, 'utf8')).not.toContain(cipher.encrypt('primary-fixture-key'));
  });

  it('migrates v7 secrets, DeepSeek wire aliases and duplicate upstream names without losing connections', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ariadne-legacy-connections-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'settings.toml');
    const initial = new AgentSettingsRepository(file, cipher);
    await initial.initialize();
    const document = parseToml(await readFile(file, 'utf8'));
    const legacy = (id: 'deepseek' | 'openai') => {
      const { label, modelId, protocol, inferenceDialect, supportsVision, ...saved } = fixtureProvider(id);
      return { ...saved, model: 'deepseek-v4-flash', encryptedApiKey: cipher.encrypt(`${id}-fixture-key`) };
    };
    document.schemaVersion = 7;
    document.providers = { deepseek: legacy('deepseek'), openai: legacy('openai') };
    await writeFile(file, stringifyToml(document));
    const migrated = new AgentSettingsRepository(file, cipher);
    await migrated.initialize();
    expect(migrated.getView()).toMatchObject({ schemaVersion: 9, revision: 2, providers: {
      deepseek: { modelId: 'deepseek-v4-flash', model: 'deepseek-flash', apiKeyStatus: 'configured' },
      openai: { modelId: 'remote-legacy-openai', model: 'deepseek-v4-flash', apiKeyStatus: 'configured' }
    } });
    expect(migrated.resolveProviderApiKey('deepseek')).toBe('deepseek-fixture-key');
    expect(migrated.resolveProviderApiKey('openai')).toBe('openai-fixture-key');
    const reopened = new AgentSettingsRepository(file, cipher);
    await reopened.initialize();
    expect(reopened.getView()).toEqual(migrated.getView());
  });
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
    const repository = new AgentSettingsRepository(file, cipher);
    await repository.initialize();

    const defaults = repository.getView();
    expect(defaults.schemaVersion).toBe(9);
    expect(defaults.assistant).toEqual({
      name: 'Ariadne',
      systemPrompt: expect.any(String),
      userPersona: ''
    });
    expect(defaults.subagentProviders).toEqual([]);
    expect(defaults.revision).toBe(1);
    expect(defaults.modelSelection).toEqual({ modelId: '', localFallbackModelId: '' });
    expect(defaults.runtimePolicy).toMatchObject({
      schemaVersion: 1,
      mcp: { servers: [], legacySseFallback: false },
      browser: { sessionMode: 'temporary', allowSensitiveInput: false },
      telemetry: { enabled: false }
    });
    expect(defaults.providers).toEqual({});
    expect(parseToml(await readFile(file, 'utf8'))).toMatchObject({
      permissionMode: 'request',
      workspaceAccess: 'write',
      workspaces: []
    });

    await expectApplied(repository.mutate({
      expectedRevision: defaults.revision,
      operations: [{
        kind: 'provider.add', providerId: 'openai', apiKey: 'sk-test-not-a-real-secret',
        provider: { ...fixtureProvider(), contextWindowTokens: 64_000, maxOutputTokens: 8_000 }
      }]
    }));
    const serialized = await readFile(file, 'utf8');
    expect(serialized).not.toContain('sk-test-not-a-real-secret');
    expect(serialized).toContain('cipher:');
    expect(repository.getView().providers.openai!.apiKeyStatus).toBe('configured');
    expect(repository.getRuntimeSettings().providers.openai!.apiKey).toBe('sk-test-not-a-real-secret');
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
      workspaceAccess: 'write',
      workspaces: [
        { rootPath: openedWorkspace, access: 'write' }
      ]
    });
    await expect(repository.addWorkspaceRoot(openedWorkspace)).resolves.toMatchObject({ added: false });
    expect(repository.getRuntimeSettings().workspaces).toHaveLength(1);
    expect(repository.getRuntimeSettings().providers.openai!.apiKey).toBe('sk-test-not-a-real-secret');

    const beforeWorkspaceUpdate = repository.getView();
    const workspaceMutation = await expectApplied(repository.mutate({
      expectedRevision: beforeWorkspaceUpdate.revision,
      operations: [
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
      workspaceAccess: 'read',
      workspaces: [
        { rootPath: openedWorkspace, access: 'read' }
      ]
    });

    const reloaded = new AgentSettingsRepository(file, cipher);
    await reloaded.initialize();
    expect(reloaded.getView().providers.openai!.apiKeyStatus).toBe('configured');
    expect(reloaded.getView().providers.openai).toMatchObject({
      contextWindowTokens: 64_000,
      maxOutputTokens: 8_000
    });
    expect(reloaded.getView()).toMatchObject({
      workspaceAccess: 'read',
      workspaces: [
        { rootPath: openedWorkspace, access: 'read' }
      ]
    });
  });

  it('persists assistant and user personas as Runtime settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ariadne-agent-settings-assistant-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'settings.toml');
    const repository = new AgentSettingsRepository(file, cipher);
    await repository.initialize();
    const initial = repository.getView();

    const result = await expectApplied(repository.mutate({
      expectedRevision: initial.revision,
      operations: [{
        kind: 'assistant.replace',
        assistant: {
          name: '测试助手',
          systemPrompt: '用简洁、直接的中文回答。',
          userPersona: '用户是初学者，解释时给出短例子。'
        }
      }]
    }));

    expect(result.effect).toBe('restart_required');
    expect(result.settings.assistant).toEqual({
      name: '测试助手',
      systemPrompt: '用简洁、直接的中文回答。',
      userPersona: '用户是初学者，解释时给出短例子。'
    });
    expect(repository.getRuntimeSettings().assistant).toEqual(result.settings.assistant);
    const persisted = parseToml(await readFile(file, 'utf8'));
    expect(persisted).toMatchObject({
      assistant: { name: '测试助手', userPersona: '用户是初学者，解释时给出短例子。' }
    });
    expect(persisted).not.toHaveProperty('assistant.mode');
  });

  it('migrates schema 6 content mode settings into the direct-answer persona schema', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ariadne-agent-settings-assistant-v6-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'settings.toml');
    const original = new AgentSettingsRepository(file, cipher);
    await original.initialize();
    const previousDocument = parseToml(await readFile(file, 'utf8'));
    previousDocument.schemaVersion = 6;
    previousDocument.assistant = {
      mode: 'standard',
      name: '旧助手',
      systemPrompt: '保留这段助手人设。'
    };
    await writeFile(file, stringifyToml(previousDocument));

    const upgraded = new AgentSettingsRepository(file, cipher);
    await upgraded.initialize();

    expect(upgraded.getView()).toMatchObject({
      schemaVersion: 9,
      revision: 2,
      assistant: {
        name: '旧助手',
        systemPrompt: '保留这段助手人设。',
        userPersona: ''
      }
    });
    const persisted = parseToml(await readFile(file, 'utf8'));
    expect(persisted).not.toHaveProperty('assistant.mode');
    expect((await readdir(directory)).some((name) => name.startsWith('settings.toml.invalid-'))).toBe(false);
  });

  it('persists frozen ACP SubAgent configuration without serializing credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ariadne-agent-settings-acp-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'settings.toml');
    const repository = new AgentSettingsRepository(file, cipher);
    await repository.initialize();

    const initial = repository.getView();
    await expectApplied(repository.mutate({
      expectedRevision: initial.revision,
      operations: [{
        kind: 'subagentProviders.replace',
        providers: [{
          kind: 'acp_stdio',
          providerId: 'external.acp',
          displayName: 'External ACP',
          enabled: true,
          command: join(directory, 'acp-agent.exe'),
          args: ['serve'],
          permissionPolicy: 'reject',
          networkAccess: 'offline',
          timeoutMs: 60_000,
          disposeGraceMs: 2_000
        }]
      }]
    }));

    expect(repository.getRuntimeSettings().subagentProviders).toEqual([{
      kind: 'acp_stdio',
      providerId: 'external.acp',
      displayName: 'External ACP',
      enabled: true,
      command: join(directory, 'acp-agent.exe'),
      args: ['serve'],
      permissionPolicy: 'reject',
      networkAccess: 'offline',
      timeoutMs: 60_000,
      disposeGraceMs: 2_000
    }]);
    const serialized = await readFile(file, 'utf8');
    expect(serialized).toContain('providerId = "external.acp"');
    expect(serialized).not.toMatch(/apiKey|credential|secret/i);

    const reopened = new AgentSettingsRepository(file, cipher);
    await reopened.initialize();
    expect(reopened.getView().subagentProviders).toEqual(
      repository.getView().subagentProviders
    );
  });

  it('supports an explicit clear action without treating an empty field as a replacement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ariadne-agent-settings-clear-'));
    temporaryDirectories.push(directory);
    const repository = new AgentSettingsRepository(join(directory, 'settings.toml'), cipher);
    await repository.initialize();
    const defaults = repository.getView();
    await expectApplied(repository.mutate({
      expectedRevision: defaults.revision,
      operations: [{
...addFixtureProvider('deepseek', 'deepseek-test-secret')
      }]
    }));
    const configured = repository.getView();
    await expectApplied(repository.mutate({
      expectedRevision: configured.revision,
      operations: [{
        kind: 'provider.update',
        providerId: 'deepseek',
        patch: { model: configured.providers.deepseek!.model }
      }]
    }));
    expect(repository.getRuntimeSettings().providers.deepseek!.apiKey).toBe('deepseek-test-secret');
    const beforeClear = repository.getView();
    await expectApplied(repository.mutate({
      expectedRevision: beforeClear.revision,
      operations: [{
        kind: 'provider.update',
        providerId: 'deepseek',
        patch: { clearApiKey: true }
      }]
    }));
    expect(repository.getView().providers.deepseek!.apiKeyStatus).toBe('missing');
  });

  it('rejects stale revisions so Chat and Settings cannot overwrite each other', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ariadne-agent-settings-revision-'));
    temporaryDirectories.push(directory);
    const repository = new AgentSettingsRepository(join(directory, 'settings.toml'), cipher);
    await repository.initialize();
    await expectApplied(repository.mutate({ expectedRevision: repository.getView().revision, operations: [addFixtureProvider()] }));
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
      providers: { openai: { model: sharedSnapshot.providers.openai!.model } }
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

  it('migrates schema 3 settings by replacing the retired primary identity without losing its root', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ariadne-agent-settings-migration-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'settings.toml');
    const original = new AgentSettingsRepository(file, cipher);
    await original.initialize();
    const currentDocument = parseToml(await readFile(file, 'utf8'));
    const previousDocument = {
      schemaVersion: 3,
      revision: currentDocument.revision,
      routingStrategy: 'local-first',
      permissionMode: currentDocument.permissionMode,
      workspaceRoot: directory,
      workspaceAccess: currentDocument.workspaceAccess,
      localModelRoots: currentDocument.localModelRoots,
      customPermissions: currentDocument.customPermissions,
      runtimePolicy: currentDocument.runtimePolicy,
      workspaces: [
        { workspaceId: 'primary', rootPath: directory, access: 'write' },
        { workspaceId: 'workspace-kept', rootPath: join(directory, 'kept'), access: 'write' }
      ],
      providers: currentDocument.providers
    };
    previousDocument.providers = { openai: { ...fixtureProvider(), model: 'legacy-openai' }, kimi: fixtureProvider('kimi'), deepseek: fixtureProvider('deepseek') };
    await writeFile(file, stringifyToml(previousDocument));

    const repository = new AgentSettingsRepository(file, cipher);
    await repository.initialize();
    const migrated = repository.getView();
    expect(migrated.modelSelection).toEqual({ modelId: '', localFallbackModelId: '' });
    expect(migrated.schemaVersion).toBe(9);
    expect(migrated.revision).toBe(2);
    expect(migrated.runtimePolicy.embedding).toEqual({ provider: 'lexical' });
    expect(migrated.workspaceAccess).toBe('write');
    expect(migrated.workspaces).toEqual([
      {
        workspaceId: expect.stringMatching(/^workspace-[a-f0-9]{20}$/),
        rootPath: directory,
        access: 'write'
      },
      { workspaceId: 'workspace-kept', rootPath: join(directory, 'kept'), access: 'write' }
    ]);
    expect(migrated.providers.openai!.model).toBe('legacy-openai');
    expect(migrated.providers.kimi!.model).toBe('kimi-k3');
    expect(migrated.providers.deepseek!.inference.reasoning?.efforts).toEqual(['high', 'max']);
    expect(await readFile(file, 'utf8')).not.toContain('routingStrategy');
  });

  it('migrates the legacy JSON file without restoring an implicit workspace', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ariadne-agent-settings-legacy-json-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'settings.toml');
    const legacyFile = join(directory, 'agent-settings.json');
    await writeFile(legacyFile, JSON.stringify({
      schemaVersion: 1,
      routingStrategy: 'local-first',
      localModelRoots: [],
      providers: {
        openai: {
          enabled: true,
          baseUrl: 'https://api.openai.com/v1',
          model: 'legacy-openai',
          encryptedApiKey: cipher.encrypt('legacy-secret')
        }
      }
    }));

    const repository = new AgentSettingsRepository(file, cipher);
    await repository.initialize();

    expect(repository.getView()).toMatchObject({
      schemaVersion: 9,
      revision: 2,
      modelSelection: { modelId: '', localFallbackModelId: '' },
      workspaces: [],
      providers: { openai: { model: 'legacy-openai', apiKeyStatus: 'configured' } }
    });
    expect(repository.getRuntimeSettings().providers.openai!.apiKey).toBe('legacy-secret');
    expect((await readdir(directory)).some((name) => name.startsWith('agent-settings.json.migrated-'))).toBe(true);
    await expect(readFile(legacyFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('upgrades schema 5 settings with the default assistant profile', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ariadne-agent-settings-schema-5-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'settings.toml');
    const original = new AgentSettingsRepository(file, cipher);
    await original.initialize();
    const previousDocument = parseToml(await readFile(file, 'utf8'));
    previousDocument.schemaVersion = 5;
    delete previousDocument.assistant;
    await writeFile(file, stringifyToml(previousDocument));

    const upgraded = new AgentSettingsRepository(file, cipher);
    await upgraded.initialize();

    expect(upgraded.getView()).toMatchObject({
      schemaVersion: 9,
      revision: 2,
      assistant: { name: 'Ariadne', userPersona: '' }
    });
    expect((await readdir(directory)).some((name) => name.startsWith('settings.toml.invalid-'))).toBe(false);
  });

  it('upgrades schema 2 settings without losing encrypted credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ariadne-agent-settings-schema-2-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'settings.toml');
    const original = new AgentSettingsRepository(file, cipher);
    await original.initialize();
    const defaults = original.getView();
    await expectApplied(original.mutate({
      expectedRevision: defaults.revision,
      operations: [{
...addFixtureProvider('openai', 'schema-two-secret')
      }]
    }));

    const previousDocument = parseToml(await readFile(file, 'utf8'));
    previousDocument.schemaVersion = 2;
    delete previousDocument.revision;
    await writeFile(file, stringifyToml(previousDocument));

    const upgraded = new AgentSettingsRepository(file, cipher);
    await upgraded.initialize();
    expect(upgraded.getView()).toMatchObject({
      schemaVersion: 9,
      revision: 2,
      providers: { openai: { apiKeyStatus: 'configured' } }
    });
    expect(upgraded.getRuntimeSettings().providers.openai!.apiKey).toBe('schema-two-secret');
    expect(parseToml(await readFile(file, 'utf8'))).toMatchObject({ schemaVersion: 9, revision: 2 });
    expect((await readdir(directory)).some((name) => name.startsWith('settings.toml.invalid-'))).toBe(false);
  });

  it('recovers its write queue without exposing settings that failed to persist', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ariadne-agent-settings-recovery-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'settings.toml');
    const repository = new AgentSettingsRepository(file, cipher);
    await repository.initialize();
    const initial = repository.getView();
    const checkpoint = repository.createCheckpoint();
    await rm(file);
    await mkdir(file);
    await expect(repository.mutate({
      expectedRevision: initial.revision,
      operations: [{ kind: 'modelSelection.set', selection: { modelId: 'selected', localFallbackModelId: 'local' } }]
    })).rejects.toBeInstanceOf(Error);
    expect(repository.getView().modelSelection).toEqual(initial.modelSelection);

    await rm(file, { recursive: true });
    await expectApplied(repository.mutate({
      expectedRevision: initial.revision,
      operations: [{ kind: 'modelSelection.set', selection: { modelId: 'selected', localFallbackModelId: 'local' } }]
    }));

    expect(repository.getView().modelSelection).toEqual({ modelId: 'selected', localFallbackModelId: 'local' });
    expect(parseToml(await readFile(file, 'utf8'))).toMatchObject({ modelSelection: { modelId: 'selected', localFallbackModelId: 'local' } });

    await repository.restore(checkpoint);
    expect(repository.getView().modelSelection).toEqual(initial.modelSelection);
    expect(parseToml(await readFile(file, 'utf8'))).toMatchObject({
      modelSelection: initial.modelSelection
    });
  });

  it('fails closed when invalid settings cannot be preserved before recovery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ariadne-agent-settings-backup-failure-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'settings.toml');
    await writeFile(file, 'routingStrategy = [invalid');
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_234_567_890);
    await mkdir(`${file}.invalid-1234567890`);
    const repository = new AgentSettingsRepository(file, cipher);

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
    const repository = new AgentSettingsRepository(join(directory, 'settings.toml'), cipher);
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
    const repository = new AgentSettingsRepository(join(directory, 'settings.toml'), cipher);
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
    expect(repository.getRuntimeSettings().workspaces).toEqual([]);
    const reloaded = new AgentSettingsRepository(join(directory, 'settings.toml'), cipher);
    await reloaded.initialize();
    expect(reloaded.getView().workspaces.find((workspace) => workspace.workspaceId === workspaceId))
      .toMatchObject({ archivedAt: archivedAt.toISOString() });

    await reloaded.restoreWorkspace(workspaceId);
    const restored = reloaded.getView().workspaces.find((workspace) => workspace.workspaceId === workspaceId);
    expect(restored).not.toHaveProperty('archivedAt');
    expect(reloaded.getRuntimeSettings().workspaces).toEqual([
      expect.objectContaining({ workspaceId })
    ]);
  });

  it('replaces retired primary and removes duplicate workspace identifiers during schema 3 migration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ariadne-agent-settings-workspace-ids-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'settings.toml');
    const original = new AgentSettingsRepository(file, cipher);
    await original.initialize();
    const currentDocument = parseToml(await readFile(file, 'utf8'));
    const previousDocument = {
      schemaVersion: 3,
      revision: currentDocument.revision,
      routingStrategy: 'cloud-first',
      permissionMode: currentDocument.permissionMode,
      workspaceRoot: directory,
      workspaceAccess: currentDocument.workspaceAccess,
      localModelRoots: currentDocument.localModelRoots,
      customPermissions: currentDocument.customPermissions,
      runtimePolicy: currentDocument.runtimePolicy,
      workspaces: [
        { workspaceId: 'primary', rootPath: directory, access: 'write' },
        { workspaceId: 'duplicate', rootPath: join(directory, 'one'), access: 'write' },
        { workspaceId: 'duplicate', rootPath: join(directory, 'two'), access: 'write' }
      ],
      providers: currentDocument.providers
    };
    await writeFile(file, stringifyToml(previousDocument));
    const repository = new AgentSettingsRepository(file, cipher);

    await repository.initialize();

    expect(repository.getView().workspaces).toEqual([
      {
        workspaceId: expect.stringMatching(/^workspace-[a-f0-9]{20}$/),
        rootPath: directory,
        access: 'write'
      },
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
