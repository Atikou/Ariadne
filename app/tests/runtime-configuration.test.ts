import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERSONAL_ASSISTANT_WORKSPACE_ID } from '@ariadne/protocol/public';
import {
  createDefaultAssistantChatProfile,
  createDefaultRuntimePolicySnapshot
} from '@ariadne/protocol/settings';
import { createDesktopRuntimeConfiguration } from '../src/main/runtime/runtime-configuration';

describe('desktop Runtime configuration', () => {
  it('keeps provider credentials private and maps each provider to its own environment key', () => {
    const configuration = createDesktopRuntimeConfiguration({
      appPath: path.resolve(process.cwd()),
      userDataPath: path.resolve(process.cwd(), '.test-user-data'),
      resourcesPath: path.resolve(process.cwd(), '.test-resources'),
      appVersion: 'test',
      packaged: false,
      executablePath: process.execPath,
      environment: { NODE: process.execPath },
      agentSettings: {
        revision: 9,
        assistant: createDefaultAssistantChatProfile(),
        routingStrategy: 'cloud-first',
        permissionMode: 'risk-based',
        permissions: {
          approvalPolicy: 'risk-based',
          proposalApproval: 'automatic',
          permissionPolicy: 'confirmBeforeRun',
          sandboxMode: 'workspace-write',
          allowedPermissions: ['read', 'write', 'shell', 'network', 'dangerous']
        },
        workspaceAccess: 'read',
        workspaces: [
          { workspaceId: 'workspace-main', rootPath: path.resolve(process.cwd()), access: 'read' },
          { workspaceId: 'workspace-secondary', rootPath: path.resolve(process.cwd(), 'secondary'), access: 'write' }
        ],
        localModelRoots: [path.resolve(process.cwd(), '.test-models')],
        subagentProviders: [{
          kind: 'acp_stdio',
          providerId: 'external.acp',
          displayName: 'External ACP',
          enabled: true,
          command: path.resolve(process.cwd(), 'acp-agent.exe'),
          args: ['serve'],
          permissionPolicy: 'reject',
          networkAccess: 'online-approved',
          timeoutMs: 60_000,
          disposeGraceMs: 2_000
        }],
        runtimePolicy: createDefaultRuntimePolicySnapshot(),
        providers: {
          openai: { enabled: true, baseUrl: 'https://api.openai.com/v1', model: 'openai-test', contextWindowTokens: 32_768, maxOutputTokens: 4_096, inference: {}, apiKey: 'openai-secret' },
          deepseek: { enabled: true, baseUrl: 'https://api.deepseek.com', model: 'deepseek-test', contextWindowTokens: 32_768, maxOutputTokens: 4_096, inference: {}, apiKey: 'deepseek-secret' },
          kimi: { enabled: true, baseUrl: 'https://api.moonshot.ai/v1', model: 'kimi-test', contextWindowTokens: 32_768, maxOutputTokens: 4_096, inference: {}, apiKey: 'kimi-secret' },
          anthropic: { enabled: false, baseUrl: 'https://api.anthropic.com', model: 'anthropic-test', contextWindowTokens: 32_768, maxOutputTokens: 4_096, inference: {}, apiKey: 'anthropic-secret' }
        }
      }
    });

    expect(configuration.profile).toBe('default');
    expect(configuration.runtimeBuildManifestPath).toBe(path.resolve(
      process.cwd(),
      '..',
      'runtime',
      'dist',
      'runtime-build.json'
    ));
    expect(configuration.agentPermissions).toMatchObject({
      approvalPolicy: 'risk-based',
      proposalApproval: 'automatic'
    });
    expect(configuration.agentAdmissionAuthoritySource).toMatchObject({
      sourceVersion: 1,
      status: 'enabled',
      manifests: [
        { workspace: { workspaceId: PERSONAL_ASSISTANT_WORKSPACE_ID }, model: { providerId: 'openai' } },
        { workspace: { workspaceId: 'workspace-main' }, model: { providerId: 'openai' } },
        { workspace: { workspaceId: 'workspace-secondary' }, model: { providerId: 'openai' } }
      ]
    });
    expect(configuration.runtimePolicy).toEqual(createDefaultRuntimePolicySnapshot());
    expect(configuration.assistantProfile).toEqual(createDefaultAssistantChatProfile());
    expect(configuration.environment).not.toHaveProperty('OPENAI_API_KEY');
    expect(configuration.environment).not.toHaveProperty('DEEPSEEK_API_KEY');
    expect(configuration.environment).not.toHaveProperty('MOONSHOT_API_KEY');
    expect(configuration.environment).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(configuration.modelProviders).toEqual([
      { providerId: 'openai', name: 'cloud-openai', protocol: 'openai-compatible', usageReporting: 'openai-stream-options', credentialEnvironmentVariable: 'OPENAI_API_KEY', credentialRef: 'model:openai', enabled: true, baseUrl: 'https://api.openai.com/v1', model: 'openai-test', supportsVision: true, contextWindowTokens: 32_768, maxOutputTokens: 4_096, inference: {} },
      { providerId: 'deepseek', name: 'cloud-deepseek', protocol: 'openai-compatible', usageReporting: 'openai-stream-options', credentialEnvironmentVariable: 'DEEPSEEK_API_KEY', credentialRef: 'model:deepseek', enabled: true, baseUrl: 'https://api.deepseek.com', model: 'deepseek-test', supportsVision: false, contextWindowTokens: 32_768, maxOutputTokens: 4_096, inference: {} },
      { providerId: 'kimi', name: 'cloud-kimi', protocol: 'openai-compatible', usageReporting: 'openai-stream-options', credentialEnvironmentVariable: 'MOONSHOT_API_KEY', credentialRef: 'model:kimi', enabled: true, baseUrl: 'https://api.moonshot.ai/v1', model: 'kimi-test', supportsVision: false, contextWindowTokens: 32_768, maxOutputTokens: 4_096, inference: {} },
      { providerId: 'anthropic', name: 'cloud-anthropic', protocol: 'anthropic-messages', usageReporting: 'anthropic-events', credentialEnvironmentVariable: 'ANTHROPIC_API_KEY', credentialRef: 'model:anthropic', enabled: false, baseUrl: 'https://api.anthropic.com', model: 'anthropic-test', supportsVision: true, contextWindowTokens: 32_768, maxOutputTokens: 4_096, inference: {} }
    ]);
    expect(JSON.stringify(configuration.modelProviders)).not.toContain('secret');
    expect(configuration.subagentProviders).toEqual([{
      kind: 'acp_stdio',
      providerId: 'external.acp',
      displayName: 'External ACP',
      command: path.resolve(process.cwd(), 'acp-agent.exe'),
      args: ['serve'],
      permissionPolicy: 'reject',
      networkAccess: 'online-approved',
      timeoutMs: 60_000,
      disposeGraceMs: 2_000
    }]);
    expect(configuration.workspaces).toEqual([
      {
        workspaceId: PERSONAL_ASSISTANT_WORKSPACE_ID,
        label: '个人助手',
        rootPath: path.resolve(process.cwd(), '.test-user-data'),
        access: 'read'
      },
      {
        workspaceId: 'workspace-main',
        label: path.basename(path.resolve(process.cwd())),
        rootPath: path.resolve(process.cwd()),
        access: 'read'
      },
      {
        workspaceId: 'workspace-secondary',
        label: 'secondary',
        rootPath: path.resolve(process.cwd(), 'secondary'),
        access: 'write'
      }
    ]);
  });

  it('starts from the App-owned personal assistant when no Agent workspace exists', () => {
    const userDataPath = path.resolve(process.cwd(), '.assistant-only-user-data');
    const settings = testRuntimeSettings(path.resolve(process.cwd(), 'unused-workspace'));
    settings.workspaces = [];
    settings.providers.openai.enabled = true;
    const configuration = createDesktopRuntimeConfiguration({
      appPath: path.resolve(process.cwd()),
      userDataPath,
      resourcesPath: path.resolve(process.cwd(), '.test-resources'),
      appVersion: 'test',
      packaged: false,
      executablePath: process.execPath,
      environment: {},
      agentSettings: settings
    });

    expect(configuration.workspaces).toEqual([{
      workspaceId: PERSONAL_ASSISTANT_WORKSPACE_ID,
      label: '个人助手',
      rootPath: userDataPath,
      access: 'read'
    }]);
    expect(configuration.agentAdmissionAuthoritySource).toMatchObject({
      status: 'enabled',
      manifests: [{
        workspace: { workspaceId: PERSONAL_ASSISTANT_WORKSPACE_ID },
        capabilityGrant: {
          capabilities: [{ capabilityId: 'computer.read' }]
        },
        toolCatalog: {
          allowedToolNames: [
            'computer.list_directory',
            'computer.open_path',
            'computer.read_text_file'
          ]
        }
      }]
    });
  });

  it('resolves packaged Runtime code and the standalone Node runner from resources', () => {
    const resourcesPath = path.resolve(process.cwd(), '.test-packaged-resources');
    const untrustedRuntimeEntry = path.resolve(process.cwd(), 'untrusted-runtime.js');
    const untrustedNode = path.resolve(process.cwd(), 'untrusted-node.exe');
    const untrustedModelRoot = path.resolve(process.cwd(), 'untrusted-models');
    const configuration = createDesktopRuntimeConfiguration({
      appPath: path.resolve(process.cwd(), 'app.asar'),
      userDataPath: path.resolve(process.cwd(), '.test-user-data'),
      resourcesPath,
      appVersion: 'test',
      packaged: true,
      executablePath: path.resolve(process.cwd(), 'Ariadne.exe'),
      environment: {
        ARIADNE_RUNTIME_ENTRY: untrustedRuntimeEntry,
        ARIADNE_RUNTIME_NODE_EXECUTABLE: untrustedNode,
        ARIADNE_MODEL_ROOTS: untrustedModelRoot,
        ARIADNE_RUNTIME_PROFILE: 'untrusted-profile',
        ARIADNE_WORKSPACE_ROOT: path.resolve(process.cwd(), 'untrusted-workspace')
      },
      agentSettings: testRuntimeSettings(path.resolve(process.cwd(), 'workspace'))
    });

    expect(configuration.runtimeEntry).toBe(path.join(
      resourcesPath,
      'runtime',
      'node_modules',
      '@ariadne',
      'runtime',
      'dist',
      'entry',
      'runtime-process.js'
    ));
    expect(configuration.runtimeBuildManifestPath).toBe(path.join(
      resourcesPath,
      'runtime',
      'node_modules',
      '@ariadne',
      'runtime',
      'dist',
      'runtime-build.json'
    ));
    expect(configuration.executablePath).toBe(path.join(
      resourcesPath,
      'runtime-runner',
      process.platform === 'win32' ? 'node.exe' : 'node'
    ));
    expect(configuration.modelRoots).toEqual([]);
    expect(configuration.profile).toBe('default');
    expect(configuration.environment).not.toHaveProperty('ARIADNE_RUNTIME_ENTRY');
    expect(configuration.environment).not.toHaveProperty('ARIADNE_RUNTIME_NODE_EXECUTABLE');
    expect(configuration.environment).not.toHaveProperty('ARIADNE_MODEL_ROOTS');
    expect(configuration.environment).not.toHaveProperty('ARIADNE_RUNTIME_PROFILE');
    expect(configuration.environment).not.toHaveProperty('ARIADNE_WORKSPACE_ROOT');
  });
});

function testRuntimeSettings(
  workspaceRoot: string
): Parameters<typeof createDesktopRuntimeConfiguration>[0]['agentSettings'] {
  return {
    revision: 9,
    assistant: createDefaultAssistantChatProfile(),
    routingStrategy: 'cloud-first',
    permissionMode: 'risk-based',
    permissions: {
      approvalPolicy: 'risk-based',
      proposalApproval: 'automatic',
      permissionPolicy: 'confirmBeforeRun',
      sandboxMode: 'workspace-write',
      allowedPermissions: ['read', 'write', 'shell', 'network', 'dangerous']
    },
    workspaceAccess: 'write',
    workspaces: [{ workspaceId: 'workspace-main', rootPath: workspaceRoot, access: 'write' }],
    localModelRoots: [],
    subagentProviders: [],
    runtimePolicy: createDefaultRuntimePolicySnapshot(),
    providers: {
      openai: { enabled: false, baseUrl: 'https://api.openai.com/v1', model: 'openai-test', contextWindowTokens: 32_768, maxOutputTokens: 4_096, inference: {} },
      deepseek: { enabled: false, baseUrl: 'https://api.deepseek.com', model: 'deepseek-test', contextWindowTokens: 32_768, maxOutputTokens: 4_096, inference: {} },
      kimi: { enabled: false, baseUrl: 'https://api.moonshot.ai/v1', model: 'kimi-test', contextWindowTokens: 32_768, maxOutputTokens: 4_096, inference: {} },
      anthropic: { enabled: false, baseUrl: 'https://api.anthropic.com', model: 'anthropic-test', contextWindowTokens: 32_768, maxOutputTokens: 4_096, inference: {} }
    }
  };
}
