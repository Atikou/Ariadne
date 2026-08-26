import path from 'node:path';

import {
  ARIADNE_RUNTIME_PROTOCOL_VERSION,
  runtimeEventEnvelopeSchema,
  type RuntimeStatus
} from '@ariadne/protocol/public';

import type {
  RuntimeApplication,
  RuntimeApplicationCommandResult,
  RuntimeApplicationFactory,
  RuntimeApplicationFactoryInput
} from '../ingress/RuntimeApplication.js';
import type { RuntimeCommandEnvelope } from '../ingress/RuntimeIngress.js';
import type { RuntimeModelCatalogSource } from '../ingress/RuntimeModelCatalog.js';
import type {
  RuntimePublicEventAppend,
  RuntimePublicEventSink
} from '../ingress/RuntimePublicEventSink.js';
import type { ShutdownContext } from '../ingress/ShutdownContext.js';
import {
  LocalModelService
} from '../model/local/LocalModelService.js';
import type {
  LocalModelCatalogSnapshot,
  LocalModelDescriptor
} from '../model/local/types.js';
import {
  ProductionExactAgentModelInferenceGateway
} from '../adapters/model/ProductionExactAgentModelInferenceGateway.js';
import {
  RuntimeKernelModelInferenceGateway
} from './RuntimeKernelModelInferenceGateway.js';

const LOCAL_MODEL_MAX_LOADED = 2;
const LOCAL_MODEL_IDLE_UNLOAD_MS = 5 * 60_000;

/**
 * Small production kernel for lifecycle, model discovery and Projection wake
 * delivery. Conversation and Agent commands are exclusively owned by Control.
 */
class RuntimeKernelApplication implements RuntimeApplication {
  public readonly storageSchemas = Object.freeze({});
  public readonly publicEventSink: RuntimePublicEventSink;
  public readonly modelCatalog: RuntimeModelCatalogSource;
  public readonly modelInferenceGateway: RuntimeKernelModelInferenceGateway;
  private lifecycle: 'created' | 'running' | 'stopped' = 'created';
  private eventCursor = 0;
  private readonly remoteModels: RuntimeModelCatalogSource['snapshot'] extends () => infer T
    ? T
    : never;
  private readonly localModels: LocalModelService;
  private localSnapshot: LocalModelCatalogSnapshot;
  private readonly localRuntimeAvailability = new Map<
    LocalModelDescriptor['runtime'],
    'checking' | 'ready' | 'unavailable' | 'error'
  >();

  public constructor(private readonly input: RuntimeApplicationFactoryInput) {
    this.remoteModels = Object.freeze((input.bootstrap.modelProviders ?? []).map((provider) => Object.freeze({
      id: provider.model,
      label: provider.model,
      location: 'remote' as const,
      availability: provider.enabled
        && Boolean(process.env[provider.credentialEnvironmentVariable]?.trim())
        ? 'ready' as const
        : 'unavailable' as const,
      supportsAgent: true,
      supportsVision: false
    })));
    const modelRoots = [...new Set(input.bootstrap.modelRoots.map((root) => path.resolve(root)))];
    const primaryModelRoot = modelRoots[0] ?? path.join(input.bootstrap.installRoot, 'Models');
    this.localModels = new LocalModelService({
      directory: primaryModelRoot,
      readOnlyDirectories: modelRoots.slice(1),
      autoDiscover: true,
      watch: true,
      maxLoadedModels: LOCAL_MODEL_MAX_LOADED,
      idleUnloadMs: LOCAL_MODEL_IDLE_UNLOAD_MS,
      runtimeCacheDirectory: path.join(input.bootstrap.dataRoot, 'model-runtime-cache'),
      transformersRuntimeDirectory: path.join(input.bootstrap.installRoot, '.runtime', 'transformers'),
      reservedClientNames: (input.bootstrap.modelProviders ?? []).map((provider) => provider.model),
      onChanged: (snapshot) => {
        this.localSnapshot = snapshot;
        void this.refreshLocalRuntimeAvailability(snapshot);
      }
    });
    this.localSnapshot = this.localModels.snapshot();
    this.markLocalRuntimesChecking(this.localSnapshot);
    this.modelCatalog = Object.freeze({ snapshot: () => this.modelSnapshot() });
    this.modelInferenceGateway = new RuntimeKernelModelInferenceGateway(
      new ProductionExactAgentModelInferenceGateway({
        modelProviders: input.bootstrap.modelProviders,
        agentAdmissionAuthoritySource: input.bootstrap.agentAdmissionAuthoritySource,
        credentialEnvironment: process.env
      }),
      this.localModels,
      input.bootstrap.modelProviders,
      input.bootstrap.routingStrategy ?? 'cloud-first'
    );
    this.publicEventSink = Object.freeze({
      append: async (event: RuntimePublicEventAppend): Promise<void> => {
        if (this.lifecycle !== 'running') throw new Error('runtime_kernel_not_running');
        const envelope = runtimeEventEnvelopeSchema.parse({
          ...event,
          cursor: ++this.eventCursor,
          schemaVersion: '2.0'
        });
        this.input.emitEvent(envelope);
      }
    });
  }

  public async start(): Promise<void> {
    if (this.lifecycle !== 'created') throw new Error('runtime_kernel_start_invalid');
    this.lifecycle = 'running';
    this.localModels.start();
    this.localSnapshot = await this.localModels.refresh();
    await this.refreshLocalRuntimeAvailability(this.localSnapshot);
  }

  public async execute(
    envelope: RuntimeCommandEnvelope
  ): Promise<RuntimeApplicationCommandResult> {
    if (envelope.command.kind === 'runtime.status.get') {
      return {
        outcome: { ok: true, result: { kind: 'runtime.status', status: this.status() } },
        settlement: 'completed'
      };
    }
    return {
      outcome: {
        ok: false,
        error: {
          code: 'runtime_command_not_supported',
          message: 'This command is not owned by the v3 Runtime.',
          retryable: false,
          correlationId: envelope.correlationId
        }
      },
      settlement: 'completed'
    };
  }

  public status(): RuntimeStatus {
    const writeEnabled = this.input.bootstrap.workspaces.some(
      (workspace) => workspace.access === 'write'
    );
    const browserEnabled = this.input.bootstrap.agentPermissions?.allowedPermissions
      .includes('network') === true;
    const permissionSet = new Set(
      this.input.bootstrap.agentPermissions?.allowedPermissions ?? []
    );
    const mcpEnabled = this.input.bootstrap.runtimePolicy.mcp.servers.some((server) => {
      if (!server.enabled) return false;
      if (server.transport === 'streamable-http') return permissionSet.has('network');
      return permissionSet.has('shell')
        && (server.workspaceAccess !== 'write' || permissionSet.has('write'))
        && (server.networkAccess !== 'online-approved' || permissionSet.has('network'));
    });
    return {
      availability: this.lifecycle === 'running' ? 'ready' : 'stopped',
      runtimeVersion: this.input.runtimeVersion,
      protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
      capabilities: [
        'companion.chat',
        'companion.agent-plan',
        'companion.sessions',
        'agent.runs',
        'agent.inbox',
        'agent.permissions',
        'agent.plans',
        'agent.tools',
        'models.local',
        'models.remote',
        'workspace.read',
        ...(mcpEnabled ? ['mcp.tools' as const] : []),
        ...(this.input.bootstrap.runtimePolicy.skills.enabled.length > 0
          ? ['skills.instructions' as const]
          : []),
        ...(this.input.bootstrap.runtimePolicy.hooks.definitions.some(
          (hook) => hook.events.includes('run.pre')
        ) ? ['hooks.run-pre' as const] : []),
        ...(browserEnabled ? ['browser.web' as const] : []),
        ...(writeEnabled ? ['workspace.write' as const] : []),
      ],
      observedAt: new Date().toISOString()
    };
  }

  public async prepareShutdown(context: ShutdownContext): Promise<void> {
    context.throwIfExpired();
    await this.stopLocalModels();
  }

  public async stop(context: ShutdownContext): Promise<void> {
    context.throwIfExpired();
    await this.stopLocalModels();
    this.lifecycle = 'stopped';
  }

  public async shutdown(context: ShutdownContext): Promise<void> {
    context.throwIfExpired();
    await this.stopLocalModels();
    this.lifecycle = 'stopped';
  }

  public async disposeInitialization(context: ShutdownContext): Promise<void> {
    context.throwIfExpired();
    await this.stopLocalModels();
    this.lifecycle = 'stopped';
  }

  private modelSnapshot(): ReturnType<RuntimeModelCatalogSource['snapshot']> {
    const localModels = this.localSnapshot.models.map((model) => Object.freeze({
      id: model.id,
      label: model.displayName,
      location: 'local' as const,
      availability: model.status === 'ready'
        ? this.localRuntimeAvailability.get(model.runtime) ?? 'checking'
        : model.status === 'invalid'
          ? 'error' as const
          : 'unavailable' as const,
      supportsAgent: model.status === 'ready',
      supportsVision: model.routerProfile?.capabilities?.image === true
    }));
    return Object.freeze([...this.remoteModels, ...localModels]);
  }

  private markLocalRuntimesChecking(snapshot: LocalModelCatalogSnapshot): void {
    for (const model of snapshot.models) {
      if (model.status === 'ready' && !this.localRuntimeAvailability.has(model.runtime)) {
        this.localRuntimeAvailability.set(model.runtime, 'checking');
      }
    }
  }

  private async refreshLocalRuntimeAvailability(
    snapshot: LocalModelCatalogSnapshot
  ): Promise<void> {
    this.markLocalRuntimesChecking(snapshot);
    const runtimes = [...new Set(
      snapshot.models
        .filter((model) => model.status === 'ready')
        .map((model) => model.runtime)
    )];
    await Promise.all(runtimes.map(async (runtime) => {
      try {
        const available = await this.localModels.runtimes.isAvailable(runtime);
        this.localRuntimeAvailability.set(runtime, available ? 'ready' : 'unavailable');
      } catch {
        this.localRuntimeAvailability.set(runtime, 'error');
      }
    }));
  }

  private async stopLocalModels(): Promise<void> {
    await this.localModels.stop();
  }
}

export function createRuntimeKernelApplicationFactory(): RuntimeApplicationFactory {
  return {
    create: async (input) => new RuntimeKernelApplication(input)
  };
}
