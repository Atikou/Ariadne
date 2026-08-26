import path from 'node:path';

import {
  ARIADNE_RUNTIME_PROTOCOL,
  ARIADNE_RUNTIME_PROTOCOL_VERSION,
  FIRST_PARTY_AGENT_TOOL_NAMES,
  type RuntimeBootstrap
} from '@ariadne/protocol/host';
import { createDefaultRuntimePolicySnapshot } from '@ariadne/protocol/settings';
import { describe, expect, it, vi } from 'vitest';

import {
  compileProductionRuntimeCapabilityManifest,
  compileRuntimeCapabilityManifest,
  createProductionRuntimeCapabilityStartContext,
  productionRuntimeCapabilityProviders,
  type RuntimeCapabilityProvider
} from '../src/composition/ProductionRuntimeCapabilityManifest.js';

describe('production Runtime Capability Manifest', () => {
  it('derives public status and the Tool Catalog from the same started providers', async () => {
    const bootstrap = createBootstrap();
    bootstrap.modelProviders = [{
      providerId: 'provider-1',
      name: 'provider-1',
      protocol: 'openai-compatible',
      credentialEnvironmentVariable: 'PROVIDER_KEY',
      enabled: true,
      baseUrl: 'https://models.example.com/',
      model: 'model-1',
      contextWindowTokens: 32_768,
      maxOutputTokens: 4_096,
      inference: {
        reasoning: {
          modes: ['off'],
          defaultMode: 'off',
          efforts: []
        }
      }
    }];
    bootstrap.agentPermissions = {
      approvalPolicy: 'request',
      proposalApproval: 'manual',
      permissionPolicy: 'confirmBeforeRun',
      sandboxMode: 'workspace-write',
      allowedPermissions: ['read', 'write', 'shell', 'network']
    };
    bootstrap.runtimePolicy.hooks.definitions = [{
      id: 'policy',
      version: '1',
      events: ['run.admission.pre'],
      timeoutMs: 1_000,
      failurePolicy: 'fail-closed',
      decision: 'allow'
    }];
    bootstrap.runtimePolicy.mcp.servers = [{
      id: 'docs',
      enabled: true,
      trustAnnotations: false,
      transport: 'streamable-http',
      endpoint: 'https://mcp.example.com/'
    }];
    const manifest = await compileProductionRuntimeCapabilityManifest({
      bootstrap,
      processSandboxFactory: () => ({
        mode: 'workspace-write',
        runFile: vi.fn(),
        openFileLease: vi.fn()
      })
    });

    expect(manifest.publicCapabilities).toEqual([
      'agent.inbox',
      'agent.permissions',
      'agent.plans',
      'agent.runs',
      'agent.tools',
      'background.tasks',
      'browser.web',
      'companion.agent-plan',
      'companion.chat',
      'companion.sessions',
      'hooks.lifecycle',
      'mcp.tools',
      'models.local',
      'models.remote',
      'observability.diagnostics',
      'workspace.read',
      'workspace.write'
    ]);
    expect(manifest.agentToolCatalogSnapshots[0]?.entries.map(
      (entry) => entry.document.toolName
    )).toEqual([...FIRST_PARTY_AGENT_TOOL_NAMES]);
    const diagnostics = manifest.diagnosticSnapshot();
    expect(Object.isFrozen(diagnostics)).toBe(true);
    expect(diagnostics.flatMap((item) => item.toolNames).sort()).toEqual(
      [...FIRST_PARTY_AGENT_TOOL_NAMES]
    );
    expect(diagnostics.find((item) => item.definition.id === 'mcp.tools'))
      .toMatchObject({ status: 'started', publicCapabilities: ['mcp.tools'] });
    expect(manifest.unwiredPublicCapabilities).toEqual([
      'agent.proposals',
      'memory.manage',
      'resources',
      'scheduler'
    ]);
  });

  it('does not advertise a configured feature after its Provider is removed', async () => {
    const bootstrap = createBootstrap();
    bootstrap.runtimePolicy.hooks.definitions = [{
      id: 'audit', version: '1', events: ['runtime.stop'], timeoutMs: 1_000,
      failurePolicy: 'fail-open', decision: 'allow'
    }];
    const context = createProductionRuntimeCapabilityStartContext({ bootstrap });
    const providers = productionRuntimeCapabilityProviders().filter(
      (provider) => provider.definition.id !== 'hooks.lifecycle'
    );

    const manifest = await compileRuntimeCapabilityManifest(context, providers);

    expect(manifest.publicCapabilities).not.toContain('hooks.lifecycle');
    expect(manifest.diagnosticSnapshot().map((item) => item.definition.id))
      .not.toContain('hooks.lifecycle');
  });

  it('fails closed on undeclared public output and rolls back started Providers', async () => {
    const bootstrap = createBootstrap();
    const context = createProductionRuntimeCapabilityStartContext({ bootstrap });
    const closed = vi.fn();
    const providers = [...productionRuntimeCapabilityProviders()];
    const kernelIndex = providers.findIndex(
      (provider) => provider.definition.id === 'runtime.kernel'
    );
    const kernel = providers[kernelIndex]!;
    providers[kernelIndex] = {
      definition: kernel.definition,
      start: async (startContext) => {
        const handle = await kernel.start(startContext);
        return { ...handle, close: closed };
      }
    };
    const invalidOutput: RuntimeCapabilityProvider = {
      definition: {
        id: 'invalid.public-output',
        contractVersion: '1.0',
        requires: ['workspace.tools'],
        provides: ['invalid.public-output'],
        publicCapabilities: ['agent.proposals']
      },
      start: () => ({ publicCapabilities: ['scheduler'] })
    };

    await expect(compileRuntimeCapabilityManifest(context, [...providers, invalidOutput]))
      .rejects.toThrow('runtime_capability_public_not_declared:invalid.public-output');
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('rejects missing dependencies before any Provider starts', async () => {
    const bootstrap = createBootstrap();
    const context = createProductionRuntimeCapabilityStartContext({ bootstrap });
    const start = vi.fn(() => ({ publicCapabilities: [] }));
    const invalid: RuntimeCapabilityProvider = {
      definition: {
        id: 'invalid.consumer',
        contractVersion: '1.0',
        requires: ['missing.provider'],
        provides: ['invalid.consumer'],
        publicCapabilities: []
      },
      start
    };

    await expect(compileRuntimeCapabilityManifest(context, [invalid]))
      .rejects.toThrow('runtime_capability_requirement_missing:missing.provider');
    expect(start).not.toHaveBeenCalled();
  });
});

function createBootstrap(): RuntimeBootstrap {
  return {
    protocol: ARIADNE_RUNTIME_PROTOCOL,
    protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
    runtimeInstanceId: '00000000-0000-4000-8000-000000000072',
    type: 'bootstrap',
    appVersion: '0.1.0',
    runtimeVersion: '0.1.0',
    runtimeBuildFingerprint: 'a'.repeat(64),
    installRoot: path.resolve('.'),
    dataRoot: path.resolve('.'),
    modelRoots: [],
    agentAdmissionAuthoritySource: {
      sourceVersion: 1,
      status: 'disabled',
      reason: 'not_configured'
    },
    runtimePolicy: createDefaultRuntimePolicySnapshot(),
    profile: 'test',
    workspaces: [{
      workspaceId: 'workspace-1',
      label: 'Workspace',
      rootPath: path.resolve('.'),
      access: 'write'
    }],
    production: false
  };
}
