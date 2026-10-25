import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  ARIADNE_RUNTIME_PROTOCOL_VERSION,
  runtimeEventEnvelopeSchema,
  type ConversationMessageExecution,
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
import type { DispatchExactAgentModelInferenceRequest } from '../control/ports/AgentModelInference.js';
import type { RuntimeAuthorityHealthSource } from '../ingress/RuntimeAuthorityHealthSource.js';
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
import {
  deriveModelCapabilities,
  unknownQualification,
  type ModelCapabilityQualification
} from '../model/capability/ModelCapabilityQualification.js';
import type { ModelCapabilityRegistry } from '../model/capability/ModelCapabilityRegistry.js';
import { composeProductionModelCapabilitySource, type ProductionModelCapabilitySource } from './ProductionModelCapabilitySource.js';
import { readOwnedAuthorityFault } from '../adapters/persistence/SqliteAuthorityHealth.js';
import { MODEL_CAPABILITY_DB_SCHEMA_VERSION } from '../model/capability/ModelCapabilityDbSchema.js';
import { ModelQualityBenchmark } from '../model/capability/ModelQualityBenchmark.js';
import { modelQualitySummary } from '../model/capability/ModelQualityContracts.js';
import { fingerprintLocalModel } from '../model/capability/LocalModelFingerprint.js';
import { LocalTextCapabilityProbe } from '../model/capability/LocalTextCapabilityProbe.js';
import { ModelCapabilityProbeHarness } from '../model/capability/ModelCapabilityProbeHarness.js';
import { HostCredentialResolver } from '../composition/HostCredentialResolver.js';
import type { CredentialResolver } from '../control/ports/CredentialResolver.js';
import type {
  AgentModelSelectionPreference,
  ExactAgentModelInferenceMessage
} from '../control/ports/AgentModelInference.js';

const LOCAL_MODEL_MAX_LOADED = 2;
const LOCAL_MODEL_IDLE_UNLOAD_MS = 5 * 60_000;
const REMOTE_AVAILABILITY_PROBE_TIMEOUT_MS = 15_000;

interface RemoteModelCatalogBase {
  readonly id: string;
  readonly label: string;
  readonly providerId: string;
  readonly enabled: boolean;
  readonly supportsVision: boolean;
  readonly credentialEnvironmentVariable: string;
  readonly credentialRef?: string;
}

/**
 * Small production kernel for lifecycle, model discovery and Projection wake
 * delivery. Conversation and Agent commands are exclusively owned by Control.
 */
class RuntimeKernelApplication implements RuntimeApplication {
  public readonly storageSchemas: Readonly<Record<string, number>>;
  public readonly publicEventSink: RuntimePublicEventSink;
  public readonly modelCatalog: RuntimeModelCatalogSource;
  public readonly modelInferenceGateway: RuntimeKernelModelInferenceGateway;
  public readonly inferenceHealth: RuntimeAuthorityHealthSource;
  private lifecycle: 'created' | 'running' | 'stopped' = 'created';
  private eventCursor = 0;
  private readonly remoteModels: readonly RemoteModelCatalogBase[];
  private readonly disabledLocalModelIds: ReadonlySet<string>;
  private readonly remoteCredentialAvailability = new Map<
    string,
    'checking' | 'ready' | 'unavailable' | 'error'
  >();
  private readonly credentialResolver?: CredentialResolver;
  private readonly localModels: LocalModelService;
  private readonly modelCapabilitySource: ProductionModelCapabilitySource;
  private readonly capabilityTools?: {
    readonly text: LocalTextCapabilityProbe;
    readonly full: ModelCapabilityProbeHarness;
    readonly quality: ModelQualityBenchmark;
  };
  private readonly localQualificationRuns = new Map<string, Promise<void>>();
  private readonly localQualificationAbort = new AbortController();
  private modelActivityStop?: Promise<void>;
  private modelCapabilityRegistryClosed = false;
  private localSnapshot: LocalModelCatalogSnapshot;
  private readonly localRuntimeAvailability = new Map<
    LocalModelDescriptor['runtime'],
    'checking' | 'ready' | 'unavailable' | 'error'
  >();

  public constructor(private readonly input: RuntimeApplicationFactoryInput) {
    this.disabledLocalModelIds = new Set(input.bootstrap.disabledLocalModelIds ?? []);
    this.credentialResolver = input.hostCapabilities === undefined
      ? undefined
      : new HostCredentialResolver(input.hostCapabilities);
    this.modelCapabilitySource = composeProductionModelCapabilitySource(input.bootstrap.dataRoot);
    const registry = this.modelCapabilitySource.registry;
    const schemas: Record<string, number> = {};
    if (registry !== undefined) schemas.modelCapability = MODEL_CAPABILITY_DB_SCHEMA_VERSION;
    this.storageSchemas = Object.freeze(schemas);
    this.remoteModels = Object.freeze((input.bootstrap.modelProviders ?? []).map((provider) => {
      const fingerprint = fingerprintRemoteProvider(provider);
      registry?.registerFingerprint(provider.providerId, provider.model, fingerprint);
      this.remoteCredentialAvailability.set(
        remoteModelKey(provider.providerId, provider.model),
        initialRemoteAvailability(provider, this.credentialResolver)
      );
      return Object.freeze({
        id: provider.model,
        label: provider.model,
        providerId: provider.providerId,
        enabled: provider.enabled,
        supportsVision: provider.supportsVision === true,
        credentialEnvironmentVariable: provider.credentialEnvironmentVariable,
        ...(provider.credentialRef === undefined
          ? {}
          : { credentialRef: provider.credentialRef })
      });
    }));
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
    const remoteInference = new ProductionExactAgentModelInferenceGateway({
        modelProviders: input.bootstrap.modelProviders,
        agentAdmissionAuthoritySource: input.bootstrap.agentAdmissionAuthoritySource,
        credentialEnvironment: process.env,
        ...(this.credentialResolver === undefined
          ? {}
          : { credentialResolver: this.credentialResolver }),
        resiliencePolicy: input.bootstrap.runtimePolicy.providerResilience,
        ...(input.providerTelemetry === undefined
          ? {}
          : { providerTelemetry: input.providerTelemetry })
      });
    this.inferenceHealth = Object.freeze({
      assertHealthy: () => { this.modelCapabilitySource.health.assertHealthy();
        if (this.lifecycle === 'stopped') throw new Error('runtime_inference_owner_stopped'); },
      hasExternalFailure: () => remoteInference.hasExternalFailure() || this.hasLocalInferenceFailure()
    });
    this.modelInferenceGateway = new RuntimeKernelModelInferenceGateway(
      remoteInference,
      this.localModels,
      input.bootstrap.modelProviders,
      input.bootstrap.routingStrategy ?? 'cloud-first',
      registry,
      (providerId, modelId) => this.remoteCredentialAvailability.get(
        remoteModelKey(providerId, modelId)
      ) === 'ready',
      this.disabledLocalModelIds,
      (providerId,modelId) => {
        const quality = this.modelCapabilities.current(providerId,modelId)?.quality;
        return quality ? modelQualitySummary(quality) : null;
      },
      () => this.inferenceHealth.assertHealthy()
    );
    if (registry !== undefined) this.capabilityTools = {
      text: new LocalTextCapabilityProbe(registry),
      full: new ModelCapabilityProbeHarness(this.modelInferenceGateway, registry),
      quality: new ModelQualityBenchmark(this.modelInferenceGateway, registry)
    };
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
    await this.refreshRemoteCredentialAvailability();
    this.localModels.start();
    this.localSnapshot = await this.localModels.refresh();
    await this.refreshLocalRuntimeAvailability(this.localSnapshot);
    this.scheduleLocalQualification(this.localSnapshot);
  }

  public async execute(
    envelope: RuntimeCommandEnvelope
  ): Promise<RuntimeApplicationCommandResult> {
    if (['model.quality.evaluate', 'model.qualification.run', 'model.availability.check', 'conversation.session.title.generate']
      .includes(envelope.command.kind)) this.inferenceHealth.assertHealthy();
    if (envelope.command.kind === 'model.quality.evaluate') {
      try {
        const binding=this.qualityBinding(envelope.command.modelId);
        const fingerprint=this.modelCapabilities.currentFingerprint(binding.providerId,binding.modelId);
        if(fingerprint===null)throw new Error('model_capability_fingerprint_missing');
        const quality=modelQualitySummary(await this.qualityBenchmark.run({binding,fingerprint,signal:envelope.signal}));
        return {outcome:{ok:true,result:{kind:'model.quality.completed',modelId:envelope.command.modelId,quality}},settlement:'completed'};
      } catch(error) {
        if(envelope.signal.aborted)throw error;
        if (readOwnedAuthorityFault(error) !== null) throw error;
        return {outcome:{ok:false,error:{code:'model_quality_evaluation_failed',message:'模型质量测评未完成，请先确认模型可用并通过文本能力检测。',retryable:true,correlationId:envelope.correlationId}},settlement:'completed'};
      }
    }
    if (envelope.command.kind === 'runtime.status.get') {
      return {
        outcome: { ok: true, result: { kind: 'runtime.status', status: this.status() } },
        settlement: 'completed'
      };
    }
    if (envelope.command.kind === 'model.qualification.run') {
      try {
        const report = await this.qualifyModel(envelope.command.modelId, envelope.signal);
        return {
          outcome: {
            ok: true,
            result: {
              kind: 'model.qualification.completed',
              modelId: report.modelId,
              ...deriveModelCapabilities(report)
            }
          },
          settlement: 'completed'
        };
      } catch (error) {
        if (envelope.signal.aborted) throw error;
        if (readOwnedAuthorityFault(error) !== null) throw error;
        return {
          outcome: {
            ok: false,
            error: {
              code: 'model_qualification_failed',
              message: 'The requested model capability qualification did not complete.',
              retryable: true,
              correlationId: envelope.correlationId
            }
          },
          settlement: 'completed'
        };
      }
    }
    if (envelope.command.kind === 'model.availability.check') {
      try {
        const available = await this.checkRemoteModelAvailability(
          envelope.command.modelId,
          envelope.signal
        );
        return {
          outcome: {
            ok: true,
            result: {
              kind: 'model.availability.completed',
              modelId: envelope.command.modelId,
              available
            }
          },
          settlement: 'completed'
        };
      } catch (error) {
        if (envelope.signal.aborted) throw error;
        if (readOwnedAuthorityFault(error) !== null) throw error;
        return {
          outcome: {
            ok: false,
            error: {
              code: 'model_availability_check_failed',
              message: 'The requested remote model availability check did not complete.',
              retryable: true,
              correlationId: envelope.correlationId
            }
          },
          settlement: 'completed'
        };
      }
    }
    if (envelope.command.kind === 'conversation.session.title.generate') {
      try {
        const title = await this.generateSessionTitle(
          envelope.command.content,
          envelope.command.execution,
          envelope.signal
        );
        return {
          outcome: {
            ok: true,
            result: {
              kind: 'conversation.session.title.generated',
              sessionId: envelope.command.sessionId,
              sessionVersion: envelope.command.expectedSessionVersion,
              title
            }
          },
          settlement: 'completed'
        };
      } catch (error) {
        if (envelope.signal.aborted) throw error;
        if (readOwnedAuthorityFault(error) !== null) throw error;
        return {
          outcome: {
            ok: false,
            error: {
              code: 'conversation_title_generation_failed',
              message: 'The optional conversation title request did not complete.',
              retryable: true,
              correlationId: envelope.correlationId
            }
          },
          settlement: 'completed'
        };
      }
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

  private async generateSessionTitle(
    content: string,
    execution: ConversationMessageExecution | undefined,
    signal: AbortSignal
  ): Promise<string> {
    const binding = this.resolveTitleBinding(execution);
    if (binding === null) throw new Error('conversation_title_model_unavailable');
    const messages: readonly ExactAgentModelInferenceMessage[] = [
      {
        role: 'system',
        content: [{
          type: 'text',
          text: '你是会话标题生成器。根据用户首问生成最短、准确的标题。只输出标题本身，不要引号、解释或句末标点。最多 16 个汉字或 8 个英文单词。'
        }]
      },
      { role: 'user', content: [{ type: 'text', text: content }] }
    ];
    const result = await this.modelInferenceGateway.inferExact({
      binding,
      messages,
      tools: [],
      signal,
      sampling: { temperature: 0.2, maxOutputTokens: 32 }
    });
    if (result.status !== 'completed') throw new Error(`conversation_title_model_${result.status}`);
    const text = result.contentBlocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join(' ');
    const title = normalizeGeneratedTitle(text);
    if (title === null) throw new Error('conversation_title_empty');
    return title;
  }

  private resolveTitleBinding(
    execution: ConversationMessageExecution | undefined
  ): import('@ariadne/agent-core').AgentRunBinding['model'] | null {
    const modelId = execution?.modelId;
    const routingStrategy = execution?.routingStrategy
      ?? this.input.bootstrap.routingStrategy
      ?? 'cloud-first';
    const preference: AgentModelSelectionPreference = {
      ...(execution?.routingStrategy === undefined
        ? {}
        : { routingStrategy: execution.routingStrategy }),
      executionMode: 'chat'
    };
    const revisions = new Map<string, number>();
    for (const model of this.remoteModels) {
      const revision = remoteSettingsRevision(this.input.bootstrap, model.providerId, model.id);
      if (revision !== null) revisions.set(model.id, revision);
    }
    const localCandidates = this.localModels.clients().map((model) => ({
      id: model.name,
      revision: 1
    }));
    const remoteCandidates = this.remoteModels.map((model) => ({
      id: model.id,
      revision: revisions.get(model.id) ?? 1
    }));
    const candidates = modelId === undefined
      ? routingStrategy === 'privacy-first'
        ? localCandidates
        : routingStrategy === 'local-first'
          ? [...localCandidates, ...remoteCandidates]
          : [...remoteCandidates, ...localCandidates]
      : [{ id: modelId, revision: revisions.get(modelId) ?? 1 }];
    for (const candidate of candidates) {
      try {
        const binding = this.modelInferenceGateway.resolveBinding(candidate.revision, {
          ...preference,
          modelId: candidate.id
        });
        if (binding !== null) return binding;
      } catch {
        // Continue with another configured model. The renderer keeps its local fallback.
      }
    }
    return null;
  }

  public status(): RuntimeStatus {
    return {
      availability: this.lifecycle === 'running' ? 'ready' : 'stopped',
      runtimeVersion: this.input.runtimeVersion,
      protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
      capabilities: [...this.input.capabilityManifest.publicCapabilities],
      observedAt: new Date().toISOString()
    };
  }

  public async prepareShutdown(context: ShutdownContext): Promise<void> {
    context.throwIfExpired();
    await this.stopModelActivity();
  }

  public async stop(context: ShutdownContext): Promise<void> {
    context.throwIfExpired();
    await this.stopModelActivity();
    this.lifecycle = 'stopped';
  }

  public async shutdown(context: ShutdownContext): Promise<void> {
    context.throwIfExpired();
    await this.stopModelActivity();
    this.closeModelCapabilityRegistry();
    this.lifecycle = 'stopped';
  }

  public async disposeInitialization(context: ShutdownContext): Promise<void> {
    context.throwIfExpired();
    await this.stopModelActivity();
    this.closeModelCapabilityRegistry();
    this.lifecycle = 'stopped';
  }

  private modelSnapshot(): ReturnType<RuntimeModelCatalogSource['snapshot']> {
    const reports = this.capabilityReports();
    const remoteModels = this.remoteModels.map((model) => {
      const report = reports?.get(remoteModelKey(model.providerId, model.id))
        ?? unknownQualification({
          providerId: model.providerId,
          modelId: model.id,
          fingerprint: `sha256:${'0'.repeat(64)}`
        });
      return Object.freeze({
        id: model.id,
        label: model.label,
        location: 'remote' as const,
        enabled: true,
        availability: reports === null ? 'unavailable' as const : this.remoteCredentialAvailability.get(
          remoteModelKey(model.providerId, model.id)
        ) ?? 'error',
        ...deriveModelCapabilities(report),
        ...(report.quality===undefined?{}:{quality:modelQualitySummary(report.quality)})
      });
    });
    const localModels = this.localSnapshot.models.map((model) => {
      const report = reports?.get(remoteModelKey('ariadne.local', model.id))
        ?? unknownQualification({
          providerId: 'ariadne.local',
          modelId: model.id,
          fingerprint: `sha256:${'0'.repeat(64)}`
        });
      return Object.freeze({
        id: model.id,
        label: model.displayName,
        location: 'local' as const,
        enabled: !this.disabledLocalModelIds.has(model.id),
        availability: reports === null ? 'unavailable' as const : model.status === 'ready'
          ? this.localRuntimeAvailability.get(model.runtime) ?? 'checking'
          : model.status === 'invalid'
            ? 'error' as const
            : 'unavailable' as const,
        ...deriveModelCapabilities(report),
        ...(report.quality===undefined?{}:{quality:modelQualitySummary(report.quality)})
      });
    });
    return Object.freeze([...remoteModels, ...localModels]);
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
    if (this.capabilityReports() === null) return;
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
    this.scheduleLocalQualification(snapshot);
  }

  private scheduleLocalQualification(snapshot: LocalModelCatalogSnapshot): void {
    if (this.capabilityReports() === null) return;
    for (const model of snapshot.models) {
      if (
        model.status !== 'ready'
        || this.disabledLocalModelIds.has(model.id)
        || this.localRuntimeAvailability.get(model.runtime) !== 'ready'
        || this.localQualificationRuns.has(model.id)
      ) continue;
      const run = this.qualifyLocalModel(model).catch(() => undefined).finally(() => {
        if (this.localQualificationRuns.get(model.id) === run) {
          this.localQualificationRuns.delete(model.id);
        }
      });
      this.localQualificationRuns.set(model.id, run);
    }
  }

  private qualityBinding(modelId:string):DispatchExactAgentModelInferenceRequest['binding'] {
    const local=this.localSnapshot.models.find(model=>model.id===modelId);
    const remote=this.remoteModels.find(model=>model.id===modelId);
    if(local && (local.status!=='ready'||this.localRuntimeAvailability.get(local.runtime)!=='ready'))
      throw new Error('model_runtime_unavailable');
    const revision=local ? 1 : remote ? remoteSettingsRevision(this.input.bootstrap,remote.providerId,remote.id) : null;
    if(revision===null)throw new Error('model_quality_target_unknown');
    const binding=this.modelInferenceGateway.resolveBinding(revision,{modelId,executionMode:'chat'});
    if(binding===null)throw new Error('model_quality_binding_unavailable');return binding;
  }

  private async qualifyModel(
    modelId: string,
    signal: AbortSignal
  ): Promise<ModelCapabilityQualification> {
    const local = this.localSnapshot.models.find((model) => model.id === modelId);
    if (local !== undefined) {
      if (
        local.status !== 'ready'
        || this.localRuntimeAvailability.get(local.runtime) !== 'ready'
      ) throw new Error('model_runtime_unavailable');
      const fingerprint = await fingerprintLocalModel(local);
      this.modelCapabilities.registerFingerprint('ariadne.local', local.id, fingerprint);
      const client = this.localModels.clients().find((candidate) => candidate.name === local.id);
      if (client === undefined) throw new Error('model_probe_binding_unavailable');
      const textReport = await this.localTextProbe.run({
        providerId: 'ariadne.local',
        modelId: local.id,
        fingerprint,
        client,
        signal,
        force: true
      });
      if (textReport.textResponse !== 'qualified') return textReport;
      if (client.toolCallCapability !== 'native') {
        return textReport;
      }
      return this.fullCapabilityProbe.run({
        binding: {
          providerId: 'ariadne.local',
          modelId: local.id,
          settingsRevision: 1
        },
        fingerprint,
        signal
      });
    }
    const remote = this.remoteModels.find((model) => model.id === modelId);
    if (remote === undefined) throw new Error('model_qualification_target_unknown');
    if (
      this.remoteCredentialAvailability.get(remoteModelKey(remote.providerId, remote.id))
      !== 'ready'
    ) throw new Error('model_runtime_unavailable');
    const fingerprint = this.modelCapabilities.currentFingerprint(remote.providerId, remote.id);
    if (fingerprint === null) throw new Error('model_capability_fingerprint_missing');
    const settingsRevision = remoteSettingsRevision(
      this.input.bootstrap,
      remote.providerId,
      remote.id
    );
    if (settingsRevision === null) throw new Error('model_probe_binding_unavailable');
    return this.fullCapabilityProbe.run({
      binding: {
        providerId: remote.providerId,
        modelId: remote.id,
        settingsRevision
      },
      fingerprint,
      signal,
      probeVision: remote.supportsVision
    });
  }

  private async checkRemoteModelAvailability(
    modelId: string,
    signal: AbortSignal
  ): Promise<boolean> {
    const remote = this.remoteModels.find((model) => model.id === modelId);
    if (
      remote === undefined
      || !remote.enabled
      || this.remoteCredentialAvailability.get(remoteModelKey(remote.providerId, remote.id)) !== 'ready'
    ) return false;
    const settingsRevision = remoteSettingsRevision(
      this.input.bootstrap,
      remote.providerId,
      remote.id
    );
    if (settingsRevision === null) return false;

    const timeoutSignal = AbortSignal.timeout(REMOTE_AVAILABILITY_PROBE_TIMEOUT_MS);
    const probeSignal = AbortSignal.any([signal, timeoutSignal]);
    try {
      const result = await this.modelInferenceGateway.inferExact({
        binding: {
          providerId: remote.providerId,
          modelId: remote.id,
          settingsRevision
        },
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: 'Reply with READY.' }]
        }],
        tools: [],
        signal: probeSignal,
        sampling: { temperature: 0, maxOutputTokens: 16 }
      });
      probeSignal.throwIfAborted();
      return result.status === 'completed'
        && result.replay.finishReason === 'stop'
        && result.contentBlocks.some((block) => (
          block.type === 'text' && block.text.trim().length > 0
        ));
    } catch (error) {
      if (signal.aborted) throw error;
      return false;
    }
  }

  private async qualifyLocalModel(model: LocalModelDescriptor): Promise<void> {
    const fingerprint = await fingerprintLocalModel(model);
    this.modelCapabilities.registerFingerprint('ariadne.local', model.id, fingerprint);
    const client = this.localModels.clients().find((candidate) => candidate.name === model.id);
    if (client === undefined) throw new Error('model_probe_binding_unavailable');
    await this.localTextProbe.run({
      providerId: 'ariadne.local',
      modelId: model.id,
      fingerprint,
      client,
      signal: this.localQualificationAbort.signal
    });
  }

  private async refreshRemoteCredentialAvailability(): Promise<void> {
    await Promise.all(this.remoteModels.map(async (model) => {
      const key = remoteModelKey(model.providerId, model.id);
      if (!model.enabled) {
        this.remoteCredentialAvailability.set(key, 'unavailable');
        return;
      }
      if (Boolean(process.env[model.credentialEnvironmentVariable]?.trim())) {
        this.remoteCredentialAvailability.set(key, 'ready');
        return;
      }
      if (model.credentialRef === undefined || this.credentialResolver === undefined) {
        this.remoteCredentialAvailability.set(key, 'unavailable');
        return;
      }
      try {
        const description = await this.credentialResolver.describe(
          model.credentialRef,
          this.localQualificationAbort.signal
        );
        this.remoteCredentialAvailability.set(
          key,
          description.configured ? 'ready' : 'unavailable'
        );
      } catch {
        this.remoteCredentialAvailability.set(key, 'error');
      }
    }));
  }

  private async stopModelActivity(): Promise<void> {
    this.modelActivityStop ??= this.performModelActivityStop();
    await this.modelActivityStop;
  }

  private async performModelActivityStop(): Promise<void> {
    this.localQualificationAbort.abort('runtime_shutdown');
    await Promise.allSettled(this.localQualificationRuns.values());
    await this.localModels.stop();
  }

  private closeModelCapabilityRegistry(): void {
    if (this.modelCapabilityRegistryClosed) return;
    this.modelCapabilitySource.registry?.close();
    this.modelCapabilityRegistryClosed = true;
  }

  private hasLocalInferenceFailure(): boolean {
    const models = this.localSnapshot.models.filter(model => model.status === 'ready' && !this.disabledLocalModelIds.has(model.id));
    return this.localModels.runtimes.hasExternalFailure(new Set(models.map(model => model.id)))
      || models.some(model => ['unavailable', 'error'].includes(this.localRuntimeAvailability.get(model.runtime) ?? 'checking'));
  }

  private get modelCapabilities(): ModelCapabilityRegistry {
    this.modelCapabilitySource.health.assertHealthy();
    const registry = this.modelCapabilitySource.registry;
    if (registry === undefined) throw new Error('model_capability_source_composition_invalid');
    return registry;
  }
  private requireCapabilityTools(): NonNullable<RuntimeKernelApplication['capabilityTools']> {
    this.inferenceHealth.assertHealthy();
    if (this.capabilityTools === undefined) throw new Error('model_capability_tools_composition_invalid');
    return this.capabilityTools;
  }
  private get localTextProbe(): LocalTextCapabilityProbe { return this.requireCapabilityTools().text; }
  private get fullCapabilityProbe(): ModelCapabilityProbeHarness { return this.requireCapabilityTools().full; }
  private get qualityBenchmark(): ModelQualityBenchmark { return this.requireCapabilityTools().quality; }

  /** A catalog can still describe discovered/configured models when their
   * qualification authority is unavailable. It never uses old evidence or
   * starts qualification in that state. An unclassified error still escapes. */
  private capabilityReports(): Map<string, ModelCapabilityQualification | null> | null {
    try {
      const registry = this.modelCapabilities;
      const reports = new Map<string, ModelCapabilityQualification | null>();
      for (const model of this.remoteModels) reports.set(remoteModelKey(model.providerId, model.id), registry.current(model.providerId, model.id));
      for (const model of this.localSnapshot.models) reports.set(remoteModelKey('ariadne.local', model.id), registry.current('ariadne.local', model.id));
      registry.assertHealthy(); return reports;
    } catch (error) {
      if (readOwnedAuthorityFault(error)?.source !== 'inference') throw error;
      return null;
    }
  }
}

function fingerprintRemoteProvider(
  provider: NonNullable<RuntimeApplicationFactoryInput['bootstrap']['modelProviders']>[number]
): string {
  const endpoint = new URL(provider.baseUrl);
  endpoint.hash = '';
  endpoint.search = '';
  endpoint.pathname = endpoint.pathname.replace(/\/+$/u, '') || '/';
  const payload = JSON.stringify({
    providerId: provider.providerId,
    protocol: provider.protocol,
    endpoint: endpoint.toString(),
    modelId: provider.model,
    providerAdapterVersion: 1,
    supportsVision: provider.supportsVision === true,
    inference: provider.inference
  });
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

function normalizeGeneratedTitle(value: string): string | null {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/["'“”‘’「」『』]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[。！？!?；;，,：:。]+$/u, '')
    .trim();
  if (normalized.length === 0) return null;
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 79).trimEnd()}…`;
}

function initialRemoteAvailability(
  provider: NonNullable<RuntimeApplicationFactoryInput['bootstrap']['modelProviders']>[number],
  resolver: CredentialResolver | undefined
): 'checking' | 'ready' | 'unavailable' {
  if (!provider.enabled) return 'unavailable';
  if (Boolean(process.env[provider.credentialEnvironmentVariable]?.trim())) return 'ready';
  return provider.credentialRef !== undefined && resolver !== undefined
    ? 'checking'
    : 'unavailable';
}

function remoteModelKey(providerId: string, modelId: string): string {
  return JSON.stringify([providerId, modelId]);
}

function remoteSettingsRevision(
  bootstrap: RuntimeApplicationFactoryInput['bootstrap'],
  providerId: string,
  modelId: string
): number | null {
  if (bootstrap.agentAdmissionAuthoritySource.status !== 'enabled') return null;
  for (const manifest of bootstrap.agentAdmissionAuthoritySource.manifests) {
    for (const candidate of manifest.modelCandidates ?? [manifest.model]) {
      if (candidate.providerId === providerId && candidate.modelId === modelId) {
        return candidate.settingsRevision;
      }
    }
  }
  return null;
}

export function createRuntimeKernelApplicationFactory(): RuntimeApplicationFactory {
  return {
    create: async (input) => new RuntimeKernelApplication(input)
  };
}
