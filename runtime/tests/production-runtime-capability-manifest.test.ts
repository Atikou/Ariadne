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
  resolveAgentControlRuntimeServices,
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
      'browser.web',
      'companion.agent-plan',
      'companion.chat',
      'companion.sessions',
      'computer.read',
      'hooks.lifecycle',
      'live.work',
      'mcp.tools',
      'models.local',
      'models.remote',
      'observability.diagnostics',
      'productivity.workflow',
      'scheduler',
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
      'resources'
    ]);
    const runtimeServices = resolveAgentControlRuntimeServices(manifest);
    expect(Object.isFrozen(runtimeServices)).toBe(true);
    expect(runtimeServices.instructionAssembly).toBe(
      manifest.service('agent.instructions.assembly')
    );
    expect(runtimeServices.lifecycleHooks).toBe(manifest.service('agent.hooks.lifecycle'));
    expect(runtimeServices.liveWorkLifecycle).toBe(manifest.service('agent.live-work'));
    expect(runtimeServices.telemetry).toBeUndefined();
    const planInstructions = await runtimeServices.instructionAssembly.assemble({
      runId: 'run-1',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      executionMode: 'plan'
    }, new AbortController().signal);
    expect(planInstructions).toMatchObject({
      snapshotVersion: 1,
      complete: true,
      subject: { executionMode: 'plan', workspaceId: 'workspace-1' }
    });
    expect(planInstructions.blocks.at(-1)).toMatchObject({
      contributorId: 'execution-mode.policy',
      scope: { kind: 'mode', mode: 'plan' }
    });
    const chatInstructions = await runtimeServices.instructionAssembly.assemble({
      runId: 'run-2',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      executionMode: 'chat'
    }, new AbortController().signal);
    expect(chatInstructions.blocks).toHaveLength(1);
    expect(chatInstructions.blocks[0]).toMatchObject({
      contributorId: 'execution-mode.policy',
      scope: { kind: 'mode', mode: 'chat' }
    });
    expect(diagnostics.find(
      (item) => item.definition.id === 'agent.control.runtime-services'
    )?.definition.consumes).toEqual([
      { serviceId: 'agent.instructions.assembly', optional: false },
      { serviceId: 'agent.hooks.lifecycle', optional: false },
      { serviceId: 'agent.live-work', optional: false },
      { serviceId: 'agent.skills.catalog', optional: false },
      { serviceId: 'agent.telemetry', optional: true }
    ]);
    expect(diagnostics.find(
      (item) => item.definition.id === 'agent.instructions.assembly'
    )?.definition.consumes).toEqual([
      { serviceId: 'agent.instructions.workspace', optional: false },
      { serviceId: 'agent.instructions.skills', optional: false },
      { serviceId: 'agent.instructions.mode-policy', optional: false }
    ]);
  });

  it('fails closed when the required Hook Provider is removed', async () => {
    const bootstrap = createBootstrap();
    bootstrap.runtimePolicy.hooks.definitions = [{
      id: 'audit', version: '1', events: ['runtime.stop'], timeoutMs: 1_000,
      failurePolicy: 'fail-open', decision: 'allow'
    }];
    const context = createProductionRuntimeCapabilityStartContext({ bootstrap });
    const providers = productionRuntimeCapabilityProviders().filter(
      (provider) => provider.definition.id !== 'hooks.lifecycle'
    );

    await expect(compileRuntimeCapabilityManifest(context, providers))
      .rejects.toThrow('runtime_capability_service_dependency_missing:agent.hooks.lifecycle');
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
        dependsOn: ['workspace.tools'],
        consumes: [],
        provides: [],
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
        dependsOn: ['missing.provider'],
        consumes: [],
        provides: [],
        publicCapabilities: []
      },
      start
    };

    await expect(compileRuntimeCapabilityManifest(context, [invalid]))
      .rejects.toThrow('runtime_capability_dependency_missing:missing.provider');
    expect(start).not.toHaveBeenCalled();
  });

  it('keeps the Skill service wired while an authoritative missing catalog fails admission', async () => {
    const bootstrap = createBootstrap();
    bootstrap.runtimePolicy.skills.enabled = ['missing-for-manifest-test'];

    const manifest = await compileProductionRuntimeCapabilityManifest({ bootstrap });
    const runtimeServices = resolveAgentControlRuntimeServices(manifest);

    expect(manifest.publicCapabilities).toContain('skills.catalog');
    expect(manifest.service('agent.skills.catalog')).toBeDefined();
    await expect(runtimeServices.instructionAssembly.assemble({
      runId: 'run-missing-skill',
      sessionId: 'session-missing-skill',
      workspaceId: 'workspace-1',
      executionMode: 'agent'
    }, new AbortController().signal)).rejects.toThrow(
      'skill_not_found:workspace-1:missing-for-manifest-test'
    );
  });

  it('injects only declared upstream services while each Provider starts', async () => {
    const bootstrap = createBootstrap();
    const context = createProductionRuntimeCapabilityStartContext({ bootstrap });
    const service = Object.freeze({ identity: 'upstream-service' });
    const observed = vi.fn();
    const producer: RuntimeCapabilityProvider = {
      definition: {
        id: 'test.service-provider',
        contractVersion: '1.0',
        dependsOn: [],
        consumes: [],
        provides: [{ serviceId: 'test.upstream', optional: false }],
        publicCapabilities: []
      },
      start: () => ({
        publicCapabilities: [],
        services: { 'test.upstream': service }
      })
    };
    const consumer: RuntimeCapabilityProvider = {
      definition: {
        id: 'test.service-consumer',
        contractVersion: '1.0',
        dependsOn: [],
        consumes: [{ serviceId: 'test.upstream', optional: false }],
        provides: [{ serviceId: 'test.downstream', optional: false }],
        publicCapabilities: []
      },
      start: (startContext) => {
        const resolved = startContext.services.required<typeof service>('test.upstream');
        observed(resolved);
        return {
          publicCapabilities: [],
          services: { 'test.downstream': Object.freeze({ resolved }) }
        };
      }
    };

    const manifest = await compileRuntimeCapabilityManifest(
      context,
      [...productionRuntimeCapabilityProviders(), producer, consumer]
    );

    expect(observed).toHaveBeenCalledWith(service);
    expect(manifest.service<{ readonly resolved: typeof service }>('test.downstream'))
      .toEqual({ resolved: service });
  });

  it('rejects undeclared service access and missing required Provider output', async () => {
    const bootstrap = createBootstrap();
    const context = createProductionRuntimeCapabilityStartContext({ bootstrap });
    const undeclaredAccess: RuntimeCapabilityProvider = {
      definition: {
        id: 'test.undeclared-access',
        contractVersion: '1.0',
        dependsOn: [],
        consumes: [],
        provides: [],
        publicCapabilities: []
      },
      start: (startContext) => {
        startContext.services.required('agent.live-work');
        return { publicCapabilities: [] };
      }
    };
    await expect(compileRuntimeCapabilityManifest(
      context,
      [...productionRuntimeCapabilityProviders(), undeclaredAccess]
    )).rejects.toThrow(
      'runtime_capability_service_access_not_declared:test.undeclared-access:agent.live-work'
    );

    const missingOutput: RuntimeCapabilityProvider = {
      definition: {
        id: 'test.missing-output',
        contractVersion: '1.0',
        dependsOn: [],
        consumes: [],
        provides: [{ serviceId: 'test.required-output', optional: false }],
        publicCapabilities: []
      },
      start: () => ({ publicCapabilities: [] })
    };
    await expect(compileRuntimeCapabilityManifest(
      context,
      [...productionRuntimeCapabilityProviders(), missingOutput]
    )).rejects.toThrow(
      'runtime_capability_required_service_not_provided:test.missing-output:test.required-output'
    );
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
