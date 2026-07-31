import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDefaultRuntimePolicySnapshot } from '@ariadne/protocol/settings';
import { createDesktopRuntimeConfiguration, resolveDefaultWorkspaceRoot } from '../src/main/runtime/runtime-configuration';

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
        routingStrategy: 'cloud-first',
        permissionMode: 'risk-based',
        permissions: {
          approvalPolicy: 'risk-based',
          proposalApproval: 'automatic',
          permissionPolicy: 'confirmBeforeRun',
          sandboxMode: 'workspace-write',
          allowedPermissions: ['read', 'write', 'shell', 'network', 'dangerous']
        },
        workspaceRoot: path.resolve(process.cwd()),
        workspaceAccess: 'read',
        workspaces: [
          { workspaceId: 'primary', rootPath: path.resolve(process.cwd()), access: 'read' },
          { workspaceId: 'workspace-secondary', rootPath: path.resolve(process.cwd(), 'secondary'), access: 'write' }
        ],
        localModelRoots: [path.resolve(process.cwd(), '.test-models')],
        runtimePolicy: createDefaultRuntimePolicySnapshot(),
        providers: {
          openai: { enabled: true, baseUrl: 'https://api.openai.com/v1', model: 'openai-test', inference: {}, apiKey: 'openai-secret' },
          deepseek: { enabled: true, baseUrl: 'https://api.deepseek.com', model: 'deepseek-test', inference: {}, apiKey: 'deepseek-secret' },
          kimi: { enabled: true, baseUrl: 'https://api.moonshot.ai/v1', model: 'kimi-test', inference: {}, apiKey: 'kimi-secret' },
          anthropic: { enabled: false, baseUrl: 'https://api.anthropic.com', model: 'anthropic-test', inference: {}, apiKey: 'anthropic-secret' }
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
    expect(configuration.runtimePolicy).toEqual(createDefaultRuntimePolicySnapshot());
    expect(configuration.environment).toMatchObject({
      OPENAI_API_KEY: 'openai-secret',
      DEEPSEEK_API_KEY: 'deepseek-secret',
      MOONSHOT_API_KEY: 'kimi-secret',
      ANTHROPIC_API_KEY: 'anthropic-secret'
    });
    expect(configuration.modelProviders).toEqual([
      { providerId: 'openai', name: 'cloud-openai', protocol: 'openai-compatible', credentialEnvironmentVariable: 'OPENAI_API_KEY', enabled: true, baseUrl: 'https://api.openai.com/v1', model: 'openai-test', inference: {} },
      { providerId: 'deepseek', name: 'cloud-deepseek', protocol: 'openai-compatible', credentialEnvironmentVariable: 'DEEPSEEK_API_KEY', enabled: true, baseUrl: 'https://api.deepseek.com', model: 'deepseek-test', inference: {} },
      { providerId: 'kimi', name: 'cloud-kimi', protocol: 'openai-compatible', credentialEnvironmentVariable: 'MOONSHOT_API_KEY', enabled: true, baseUrl: 'https://api.moonshot.ai/v1', model: 'kimi-test', inference: {} },
      { providerId: 'anthropic', name: 'cloud-anthropic', protocol: 'anthropic-messages', credentialEnvironmentVariable: 'ANTHROPIC_API_KEY', enabled: false, baseUrl: 'https://api.anthropic.com', model: 'anthropic-test', inference: {} }
    ]);
    expect(JSON.stringify(configuration.modelProviders)).not.toContain('secret');
    expect(configuration.workspaces).toEqual([
      {
        workspaceId: 'primary',
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

  it('resolves a stable workspace root without using process.cwd()', () => {
    const appPath = path.resolve(process.cwd(), 'desktop-app');
    const userDataPath = path.resolve(process.cwd(), '.test-user-data');
    expect(resolveDefaultWorkspaceRoot({ appPath, userDataPath, packaged: false, environment: {} }))
      .toBe(path.resolve(appPath, '..'));
    expect(resolveDefaultWorkspaceRoot({ appPath, userDataPath, packaged: true, environment: {} }))
      .toBe(path.resolve(userDataPath, 'workspace'));
    expect(resolveDefaultWorkspaceRoot({
      appPath,
      userDataPath,
      packaged: false,
      environment: { ARIADNE_WORKSPACE_ROOT: path.resolve(process.cwd(), 'explicit-workspace') }
    })).toBe(path.resolve(process.cwd(), 'explicit-workspace'));
    expect(resolveDefaultWorkspaceRoot({
      appPath,
      userDataPath,
      packaged: true,
      environment: { ARIADNE_WORKSPACE_ROOT: path.resolve(process.cwd(), 'untrusted-workspace') }
    })).toBe(path.resolve(userDataPath, 'workspace'));
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
    routingStrategy: 'cloud-first',
    permissionMode: 'risk-based',
    permissions: {
      approvalPolicy: 'risk-based',
      proposalApproval: 'automatic',
      permissionPolicy: 'confirmBeforeRun',
      sandboxMode: 'workspace-write',
      allowedPermissions: ['read', 'write', 'shell', 'network', 'dangerous']
    },
    workspaceRoot,
    workspaceAccess: 'write',
    workspaces: [{ workspaceId: 'primary', rootPath: workspaceRoot, access: 'write' }],
    localModelRoots: [],
    runtimePolicy: createDefaultRuntimePolicySnapshot(),
    providers: {
      openai: { enabled: false, baseUrl: 'https://api.openai.com/v1', model: 'openai-test', inference: {} },
      deepseek: { enabled: false, baseUrl: 'https://api.deepseek.com', model: 'deepseek-test', inference: {} },
      kimi: { enabled: false, baseUrl: 'https://api.moonshot.ai/v1', model: 'kimi-test', inference: {} },
      anthropic: { enabled: false, baseUrl: 'https://api.anthropic.com', model: 'anthropic-test', inference: {} }
    }
  };
}
