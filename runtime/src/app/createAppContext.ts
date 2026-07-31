import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LoopChatFn } from "../agent/AgentLoop.js";
import type { UserPermissionPolicy } from "../agent/RunPolicyTypes.js";
import type { ToolPermission } from "../core/permissions.js";
import { BackgroundTaskManager, NotificationQueue } from "../background/index.js";
import { loadConfig } from "../config/loadConfig.js";
import {
  buildWorkspaceCatalog,
  decodeCustomWorkspaceKey,
  resolveWorkspaceRootFromCatalog,
  type WorkspaceCatalog,
} from "../config/workspaceCatalog.js";
import type { AppConfig, ModelClientConfig } from "../config/types.js";
import { ContextManager } from "../context/index.js";
import {
  EmbeddingService,
  LocalGgufEmbeddingProvider,
  LocalLexicalEmbeddingProvider,
} from "../context/EmbeddingService.js";
import { CompanionService } from "../companion/CompanionService.js";
import type { AgentHandoffCoordinator } from "../assistant/AgentHandoffCoordinator.js";
import { createModelClient } from "../model/ModelFactory.js";
import { MetricsRegistry } from "../model/MetricsRegistry.js";
import { createDirectChatFn, type ClientPricing } from "../model/directChat.js";
import type { ModelClient } from "../model/types.js";
import { createProcessSandbox } from "../sandbox/createProcessSandbox.js";
import type { ProcessSandbox } from "../sandbox/ProcessSandbox.js";
import { LocalModelService } from "../model/local/LocalModelService.js";
import { PlanApprovalManager, PlanDraftApiService, PlanService, PlanStore, PlanValidator } from "../plan/index.js";
import { AgentPlanStore } from "../plan/AgentPlanStore.js";
import { Orchestrator } from "../orchestrator/Orchestrator.js";
import { RunAggregateRepository } from "../run/RunAggregateRepository.js";
import { RunStateStore } from "../orchestrator/RunStateStore.js";
import { ProjectIndex } from "../context/ProjectIndex.js";
import {
  CodeIntelligenceService,
  TextFallbackIntelligenceProvider,
} from "../context/CodeIntelligenceService.js";
import { LspCodeIntelligenceProvider } from "../context/LspCodeIntelligenceProvider.js";
import { TreeSitterWasmIntelligenceProvider } from "../context/TreeSitterWasmIntelligenceProvider.js";
import { ProjectSemanticIndexer } from "../context/ProjectSemanticIndexer.js";
import { HistoryFileRecaller } from "../context/HistoryFileRecaller.js";
import { Scheduler } from "../scheduler/index.js";
import { SubAgentCoordinator } from "../subagent/index.js";
import { SubAgentWorkflow } from "../subagent/SubAgentWorkflow.js";
import { SubAgentWorkflowStateCenter } from "../subagent/SubAgentWorkflowStateCenter.js";
import { SubAgentLocalModelGate } from "../subagent/SubAgentLocalModelGate.js";
import { SubAgentWorkspaceManager } from "../subagent/SubAgentWorkspaceManager.js";
import { AgentRunRegistry } from "../orchestrator/AgentRunRegistry.js";
import { createDefaultRegistry } from "../tools/index.js";
import { createShellPolicy, type ShellPolicy } from "../policy/ShellPolicy.js";
import { createNetworkPolicy, type NetworkPolicy } from "../policy/NetworkPolicy.js";
import { resolveProjectAllowedPermissions } from "../policy/PermissionPolicy.js";
import {
  defaultPermissionRequestStore,
  PermissionRequestStore,
} from "../policy/PermissionRequestStore.js";
import {
  defaultSessionPermissionGrants,
  SessionPermissionGrants,
} from "../policy/SessionPermissionGrants.js";
import {
  WorkspaceGrantStore,
  type WorkspaceScopePermission,
} from "../policy/WorkspaceScopeManager.js";
import {
  defaultPlanHandoffStore,
  PlanHandoffStore,
} from "../policy/PlanHandoffStore.js";
import { defaultPausedRunStore, PausedRunStore } from "../agent/PausedRunStore.js";
import {
  ModelAvailabilityRegistry,
  AGENT_PROTOCOL_REQUIRED_CAPABILITIES,
  profileSupportsAgentProtocol,
} from "../model-router/index.js";
import { recoverOnStartup, type StartupRecoverySummary } from "./startupRecovery.js";
import { TraceLogger, createSegmentedTraceLogger } from "../trace/TraceLogger.js";
import { loadLifecyclePolicy } from "../lifecycle/policy.js";
import type { TraceCatalog } from "../trace/traceCatalog.js";
import { DataLifecycleService } from "../lifecycle/DataLifecycleService.js";
import { AppRuntimeController } from "./AppRuntimeController.js";
import {
  createAppModelRoutingRuntime,
  type AppModelRoutingRuntime,
} from "./AppModelRoutingRuntime.js";
import { collectSubAgentRecoveryRoots } from "./subAgentRecoveryRoots.js";
import { resolveAppPaths, type AppPaths } from "./appPaths.js";
import { AppShutdownCoordinator } from "./AppShutdownCoordinator.js";
import { resolveLocalModelPathLayout } from "./localModelPathLayout.js";
import { createUnifiedAssistantRuntime } from "./createUnifiedAssistantRuntime.js";
import type { UnifiedAssistantHandoffService } from "./UnifiedAssistantHandoffService.js";
import { McpClientManager } from "../mcp/McpClientManager.js";
import {
  AgentInstructionResolver,
  SkillRegistry,
  WorkspaceInstructionLoader,
  renderInstructionBlocks,
} from "../skills/SkillRegistry.js";
import { HookManager } from "../hooks/HookManager.js";
import { ResourceRegistry } from "../resources/ResourceRegistry.js";
import type { HostCapabilityBroker } from "../host/HostCapabilityBroker.js";
import { createBrowserToolProvider } from "../tools/browserTools.js";
import { TelemetryService } from "../telemetry/TelemetryService.js";
import { HookedModelClient } from "../model/HookedModelClient.js";

export type { AppPaths } from "./appPaths.js";
/** 应用级依赖容器：server / CLI / 测试共用。 */
export class AppContext {
  readonly profile: string;
  readonly config: AppConfig;
  readonly workspaceRoot: string;
  readonly workspaceCatalog: WorkspaceCatalog;
  readonly defaultWorkspaceKey: string;
  readonly paths: AppPaths;
  readonly clientMap: Map<string, ModelClient>;
  readonly localModelService: LocalModelService;
  readonly metrics: MetricsRegistry;
  readonly trace: TraceLogger;
  readonly traceCatalog: TraceCatalog;
  readonly notificationQueue: NotificationQueue;
  readonly scheduler: Scheduler;
  readonly backgroundTasks: BackgroundTaskManager;
  readonly processSandbox: ProcessSandbox;
  readonly directChat: ReturnType<typeof createDirectChatFn>;
  readonly planner: AppModelRoutingRuntime["planner"];
  readonly registry: ReturnType<typeof createDefaultRegistry>;
  readonly contextManager: ContextManager;
  readonly agentRuntime: AppModelRoutingRuntime["agentRuntime"];
  readonly companionService: CompanionService;
  readonly agentHandoffCoordinator: AgentHandoffCoordinator;
  readonly unifiedAssistantHandoffService: UnifiedAssistantHandoffService;
  readonly runs: RunAggregateRepository;
  readonly runStateStore: RunStateStore;
  readonly projectIndex: ProjectIndex;
  readonly projectSemanticIndexer: ProjectSemanticIndexer;
  readonly historyFileRecaller: HistoryFileRecaller;
  readonly orchestrator: Orchestrator;
  readonly subAgentLocalModelGate: SubAgentLocalModelGate;
  readonly subAgentWorkflow: SubAgentWorkflow;
  readonly subAgentWorkflowStateCenter: SubAgentWorkflowStateCenter;
  readonly smartModelRouter: AppModelRoutingRuntime["smartModelRouter"];
  readonly modelOrchestrator: AppModelRoutingRuntime["modelOrchestrator"];
  readonly routingProbeService: AppModelRoutingRuntime["routingProbeService"];
  readonly planService: PlanService;
  readonly planDraftApiService: PlanDraftApiService;
  readonly routeLogStore: AppModelRoutingRuntime["routeLogStore"];
  readonly modelCallLogStore: AppModelRoutingRuntime["modelCallLogStore"];
  readonly modelAvailability: ModelAvailabilityRegistry;
  readonly collaborationRunStore: AppModelRoutingRuntime["collaborationRunStore"];
  readonly fallbackLogStore: AppModelRoutingRuntime["fallbackLogStore"];
  readonly modelEvalStore: AppModelRoutingRuntime["modelEvalStore"];
  readonly evalSetRunner: AppModelRoutingRuntime["evalSetRunner"];
  readonly modelProfileStore: AppModelRoutingRuntime["modelProfileStore"];
  readonly modelProfileRegistry: AppModelRoutingRuntime["modelProfileRegistry"];
  readonly agentProtocolQualificationStore: AppModelRoutingRuntime["agentProtocolQualificationStore"];
  readonly projectAllowedPermissions: ToolPermission[];
  readonly shellPolicy: ShellPolicy;
  readonly networkPolicy: NetworkPolicy;
  readonly dataLifecycle: DataLifecycleService;
  readonly permissionRequestStore: PermissionRequestStore;
  readonly planHandoffStore: PlanHandoffStore;
  readonly agentPlanStore: AgentPlanStore;
  readonly sessionPermissionGrants: SessionPermissionGrants;
  readonly workspaceGrantStore: WorkspaceGrantStore;
  readonly pausedRunStore: PausedRunStore;
  readonly mcp: McpClientManager;
  readonly resources: ResourceRegistry;
  readonly hooks: HookManager;
  readonly hostCapabilities?: HostCapabilityBroker;
  readonly telemetry: TelemetryService;
  readonly runtime: AppRuntimeController;
  private readonly makeAgentChat: AppModelRoutingRuntime["makeAgentChatFn"];
  private readonly shutdownCoordinator: AppShutdownCoordinator;
  readonly startupRecovery?: StartupRecoverySummary;

  constructor(opts: {
    profile: string;
    config: AppConfig;
    workspaceRoot: string;
    workspaceCatalog: WorkspaceCatalog;
    paths: AppPaths;
    clientMap: Map<string, ModelClient>;
    localModelService: LocalModelService;
    metrics: MetricsRegistry;
    trace: TraceLogger;
    traceCatalog: TraceCatalog;
    notificationQueue: NotificationQueue;
    scheduler: Scheduler;
    backgroundTasks: BackgroundTaskManager;
    processSandbox: ProcessSandbox;
    directChat: ReturnType<typeof createDirectChatFn>;
    planner: AppModelRoutingRuntime["planner"];
    registry: ReturnType<typeof createDefaultRegistry>;
    contextManager: ContextManager;
    agentRuntime: AppModelRoutingRuntime["agentRuntime"];
    companionService: CompanionService;
    agentHandoffCoordinator: AgentHandoffCoordinator;
    unifiedAssistantHandoffService: UnifiedAssistantHandoffService;
    runs: RunAggregateRepository;
    runStateStore: RunStateStore;
    projectIndex: ProjectIndex;
    projectSemanticIndexer: ProjectSemanticIndexer;
    historyFileRecaller: HistoryFileRecaller;
    orchestrator: Orchestrator;
    subAgentLocalModelGate: SubAgentLocalModelGate;
    subAgentWorkflow: SubAgentWorkflow;
    subAgentWorkflowStateCenter: SubAgentWorkflowStateCenter;
    smartModelRouter: AppModelRoutingRuntime["smartModelRouter"];
    modelOrchestrator: AppModelRoutingRuntime["modelOrchestrator"];
    routingProbeService: AppModelRoutingRuntime["routingProbeService"];
    planService: PlanService;
    planDraftApiService: PlanDraftApiService;
    routeLogStore: AppModelRoutingRuntime["routeLogStore"];
    modelCallLogStore: AppModelRoutingRuntime["modelCallLogStore"];
    modelAvailability: ModelAvailabilityRegistry;
    collaborationRunStore: AppModelRoutingRuntime["collaborationRunStore"];
    fallbackLogStore: AppModelRoutingRuntime["fallbackLogStore"];
    modelEvalStore: AppModelRoutingRuntime["modelEvalStore"];
    evalSetRunner: AppModelRoutingRuntime["evalSetRunner"];
    modelProfileStore: AppModelRoutingRuntime["modelProfileStore"];
    modelProfileRegistry: AppModelRoutingRuntime["modelProfileRegistry"];
    agentProtocolQualificationStore: AppModelRoutingRuntime["agentProtocolQualificationStore"];
    makeAgentChatFn: AppModelRoutingRuntime["makeAgentChatFn"];
    projectAllowedPermissions: ToolPermission[];
    shellPolicy: ShellPolicy;
    networkPolicy: NetworkPolicy;
    dataLifecycle: DataLifecycleService;
    permissionRequestStore?: PermissionRequestStore;
    planHandoffStore?: PlanHandoffStore;
    agentPlanStore?: AgentPlanStore;
    sessionPermissionGrants?: SessionPermissionGrants;
    workspaceGrantStore?: WorkspaceGrantStore;
    pausedRunStore?: PausedRunStore;
    mcp: McpClientManager;
    resources: ResourceRegistry;
    hooks: HookManager;
    hostCapabilities?: HostCapabilityBroker;
    telemetry: TelemetryService;
    startupRecovery?: StartupRecoverySummary;
    runtime: AppRuntimeController;
  }) {
    this.profile = opts.profile;
    this.config = opts.config;
    this.workspaceRoot = opts.workspaceRoot;
    this.workspaceCatalog = opts.workspaceCatalog;
    this.defaultWorkspaceKey = opts.workspaceCatalog.defaultKey;
    this.paths = opts.paths;
    this.clientMap = opts.clientMap;
    this.localModelService = opts.localModelService;
    this.metrics = opts.metrics;
    this.trace = opts.trace;
    this.traceCatalog = opts.traceCatalog;
    this.notificationQueue = opts.notificationQueue;
    this.scheduler = opts.scheduler;
    this.backgroundTasks = opts.backgroundTasks;
    this.processSandbox = opts.processSandbox;
    this.directChat = opts.directChat;
    this.planner = opts.planner;
    this.registry = opts.registry;
    this.contextManager = opts.contextManager;
    this.agentRuntime = opts.agentRuntime;
    this.companionService = opts.companionService;
    this.agentHandoffCoordinator = opts.agentHandoffCoordinator;
    this.unifiedAssistantHandoffService = opts.unifiedAssistantHandoffService;
    this.runs = opts.runs;
    this.runStateStore = opts.runStateStore;
    this.projectIndex = opts.projectIndex;
    this.projectSemanticIndexer = opts.projectSemanticIndexer;
    this.historyFileRecaller = opts.historyFileRecaller;
    this.orchestrator = opts.orchestrator;
    this.subAgentLocalModelGate = opts.subAgentLocalModelGate;
    this.subAgentWorkflow = opts.subAgentWorkflow;
    this.subAgentWorkflowStateCenter = opts.subAgentWorkflowStateCenter;
    this.smartModelRouter = opts.smartModelRouter;
    this.modelOrchestrator = opts.modelOrchestrator;
    this.routingProbeService = opts.routingProbeService;
    this.planService = opts.planService;
    this.planDraftApiService = opts.planDraftApiService;
    this.routeLogStore = opts.routeLogStore;
    this.modelCallLogStore = opts.modelCallLogStore;
    this.modelAvailability = opts.modelAvailability;
    this.collaborationRunStore = opts.collaborationRunStore;
    this.fallbackLogStore = opts.fallbackLogStore;
    this.modelEvalStore = opts.modelEvalStore;
    this.evalSetRunner = opts.evalSetRunner;
    this.modelProfileStore = opts.modelProfileStore;
    this.modelProfileRegistry = opts.modelProfileRegistry;
    this.agentProtocolQualificationStore = opts.agentProtocolQualificationStore;
    this.makeAgentChat = opts.makeAgentChatFn;
    this.projectAllowedPermissions = opts.projectAllowedPermissions;
    this.shellPolicy = opts.shellPolicy;
    this.networkPolicy = opts.networkPolicy;
    this.dataLifecycle = opts.dataLifecycle;
    this.permissionRequestStore = opts.permissionRequestStore ?? defaultPermissionRequestStore;
    this.planHandoffStore = opts.planHandoffStore ?? defaultPlanHandoffStore;
    this.agentPlanStore = opts.agentPlanStore ?? new AgentPlanStore();
    this.sessionPermissionGrants = opts.sessionPermissionGrants ?? defaultSessionPermissionGrants;
    this.workspaceGrantStore = opts.workspaceGrantStore ?? new WorkspaceGrantStore();
    this.pausedRunStore = opts.pausedRunStore ?? defaultPausedRunStore;
    this.mcp = opts.mcp;
    this.resources = opts.resources;
    this.hooks = opts.hooks;
    this.hostCapabilities = opts.hostCapabilities;
    this.telemetry = opts.telemetry;
    this.startupRecovery = opts.startupRecovery;
    this.runtime = opts.runtime;
    this.shutdownCoordinator = new AppShutdownCoordinator({
      runtime: opts.runtime,
      orchestrator: opts.orchestrator,
      backgroundTasks: opts.backgroundTasks,
      trace: opts.trace,
      registry: opts.registry,
      companionService: opts.companionService,
      mcp: opts.mcp,
      projectIndex: opts.projectIndex,
      contextDb: opts.contextManager.db,
      telemetry: opts.telemetry,
      hooks: opts.hooks,
    });
  }

  /** Start process-level schedulers only when the application is actually served. */
  async start(): Promise<void> {
    this.runtime.start();
    await this.initializeHostCapabilities();
    void this.mcp.start().catch((error) => {
      this.trace.write({ type: "mcp_start_error", error: String(error) });
    });
  }

  private async initializeHostCapabilities(): Promise<void> {
    if (!this.hostCapabilities) return;
    try {
      const health = await this.hostCapabilities.request({ kind: "browser.health" }, 10_000);
      if (health.available !== true) throw new Error("browser_health_unavailable");
      this.registry.replaceProvider(createBrowserToolProvider());
      this.trace.write({ type: "browser_capability_registered" });
    } catch (error) {
      this.registry.unregisterProvider("browser-main");
      this.trace.write({ type: "browser_capability_unavailable", error: String(error) });
    }
  }

  makeChatFn(forceClient?: string): LoopChatFn {
    return this.makeAgentChat(forceClient);
  }

  resolveForceClient(
    clientName?: string,
    useCase: "general" | "agent" = "general",
  ): { forceClient?: string; error?: string; status?: 404 | 422 } {
    if (!clientName || clientName === "__default__") return {};
    if (!this.clientMap.has(clientName)) {
      return { error: `未找到模型客户端：${clientName}`, status: 404 };
    }
    if (useCase === "agent") {
      const profile = this.modelProfileRegistry.get(clientName);
      if (!profile || !profileSupportsAgentProtocol(profile)) {
        return {
          error: `模型 ${clientName} 不支持 Agent 执行协议；必须具备 ${AGENT_PROTOCOL_REQUIRED_CAPABILITIES.join(" + ")} 能力。请改用兼容模型，或仅在纯聊天中使用该模型。`,
          status: 422,
        };
      }
      if (!this.agentProtocolQualificationStore.isAdmitted(profile)) {
        const qualification = this.agentProtocolQualificationStore.get(profile);
        return {
          error: `模型 ${clientName} 因连续违反严格 AgentAction 协议而暂时隔离至 ${qualification.quarantineUntil ?? "稍后"}；普通聊天仍可使用。`,
          status: 422,
        };
      }
    }
    return { forceClient: clientName };
  }

  isValidWorkspaceKey(key: string, allowCustom = false): boolean {
    if (this.workspaceCatalog.byId.has(key)) return true;
    return allowCustom && decodeCustomWorkspaceKey(key) !== undefined;
  }

  resolveWorkspaceRootForSession(sessionId?: string): string {
    if (!sessionId) return this.workspaceRoot;
    const session = this.contextManager.getSession(sessionId);
    return resolveWorkspaceRootFromCatalog(
      this.workspaceCatalog,
      session?.workspaceKey ?? this.defaultWorkspaceKey,
    );
  }

  workspaceConfigScopesForSession(sessionId?: string): Array<{
    id: string;
    rootPath: string;
    label?: string;
    permissions?: WorkspaceScopePermission[];
  }> {
    const workspaceRoot = this.resolveWorkspaceRootForSession(sessionId);
    return this.workspaceCatalog.entries
      .filter((entry) => entry.resolvedRoot !== workspaceRoot)
      .map((entry) => ({
        id: `config:${entry.id}`,
        label: entry.label,
        rootPath: entry.resolvedRoot,
        permissions: ["read"] as WorkspaceScopePermission[],
      }));
  }

  /** Stop producers and cancel active work without closing stores used by draining HTTP handlers. */
  prepareShutdown(): Promise<void> {
    return this.shutdownCoordinator.prepare();
  }

  /** Ordered, idempotent final shutdown after callers have drained their ingress. */
  shutdown(): Promise<void> {
    return this.shutdownCoordinator.shutdown();
  }

  allModelConfigs(): ModelClientConfig[] {
    return [...this.config.models.clients, ...this.localModelService.clientConfigs()];
  }

}

export interface CreateAppContextOptions {
  processSandbox?: ProcessSandbox;
  appDataRoot?: string;
  requireExternalAppDataRoot?: boolean;
  requireTrustedSandboxHelper?: boolean;
  projectRoot?: string;
  profile?: string;
  config?: AppConfig;
  modelDirectories?: readonly string[];
  agentHandoffPermissionPolicy?: UserPermissionPolicy;
  hostCapabilities?: HostCapabilityBroker;
}

export function createAppContext(opts: CreateAppContextOptions = {}): AppContext {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(opts.projectRoot ?? path.resolve(moduleDir, "..", ".."));
  const paths = resolveAppPaths({
    projectRoot,
    ...(opts.appDataRoot ? { appDataRoot: opts.appDataRoot } : {}),
    ...(opts.requireExternalAppDataRoot
      ? { requireExternalAppDataRoot: true }
      : {}),
  });
  const { dataDir } = paths;

  const lifecyclePolicy = loadLifecyclePolicy(dataDir);
  const { logger: trace, index: traceIndex } = createSegmentedTraceLogger(paths.tracesDir, {
    rotationMaxBytes: lifecyclePolicy.trace.rotationMaxBytes,
    rotationMaxAgeHours: lifecyclePolicy.trace.rotationMaxAgeHours,
    compressOldSegments: lifecyclePolicy.trace.compressOldSegments,
  });
  const traceCatalog: TraceCatalog = { tracesDir: paths.tracesDir, index: traceIndex };

  const { profile, config, workspaceRoot, modelsDirectory } = loadConfig({
    ...(opts.profile ? { profile: opts.profile } : {}),
    projectRoot,
    ...(opts.config ? { config: opts.config } : {}),
  });
  const telemetry = new TelemetryService(config.telemetry, "0.1.0");
  const localModelPaths = resolveLocalModelPathLayout(
    paths,
    modelsDirectory,
    opts.modelDirectories,
  );
  const workspaceCatalog = buildWorkspaceCatalog(projectRoot, config);
  const shellPolicy = createShellPolicy(config.security?.shell);
  const networkPolicy = createNetworkPolicy(config.security?.network);
  const projectAllowedPermissions = resolveProjectAllowedPermissions(config.security?.permissions);
  const processSandbox = opts.processSandbox ?? createProcessSandbox(
    config.security,
    projectRoot,
    (event) => trace.write(event),
    { requireTrustedHelper: opts.requireTrustedSandboxHelper ?? false },
  );
  const maxSubAgentDispatchDepth = config.security?.subagent?.maxDispatchDepth ?? 1;
  const maxSubAgentBatchConcurrency = config.security?.subagent?.maxBatchConcurrency ?? 2;
  const subagentDefaultTimeoutMs = config.security?.subagent?.defaultTimeoutMs;
  const subagentLocalMaxConcurrent = config.security?.subagent?.localModelMaxConcurrent ?? 1;
  const subAgentLocalModelGate = new SubAgentLocalModelGate(subagentLocalMaxConcurrent);

  const clientMap = new Map<string, ModelClient>();
  const pricing = new Map<string, ClientPricing>();
  const metrics = new MetricsRegistry();
  const modelAvailability = new ModelAvailabilityRegistry();
  const dynamicClientNames = new Set<string>();
  let applyModelHooks = (client: ModelClient): ModelClient => client;
  let modelProfileStoreForRefresh: AppModelRoutingRuntime["modelProfileStore"] | undefined;
  const localModelService = new LocalModelService({
    directory: localModelPaths.primaryModelsDirectory,
    readOnlyDirectories: localModelPaths.readOnlyModelDirectories,
    autoDiscover: config.models.autoDiscover,
    watch: config.models.watch,
    maxLoadedModels: config.models.maxLoadedModels,
    idleUnloadMs: config.models.idleUnloadMs,
    transformersRuntimeDirectory:
      localModelPaths.transformersRuntimeDirectory,
    runtimeCacheDirectory: localModelPaths.runtimeCacheDirectory,
    reservedClientNames: config.models.clients.map((client) => client.name),
    onChanged: (_snapshot, clients, configs) => {
      for (const name of dynamicClientNames) clientMap.delete(name);
      dynamicClientNames.clear();
      for (const client of clients) {
        clientMap.set(client.name, applyModelHooks(client));
        dynamicClientNames.add(client.name);
      }
      const validation = modelProfileStoreForRefresh?.reloadFromClients([
        ...config.models.clients,
        ...configs,
      ]);
      for (const message of validation ?? []) {
        console.warn(`[model-router] Models 热更新校验：${message}`);
      }
      void Promise.all(
        clients.map((client) => modelAvailability.refreshModel(client.name, client)),
      ).catch((error) => {
        trace.write({ type: "local_model_availability_refresh_error", error: String(error) });
      });
    },
  });
  for (const c of config.models.clients) {
    clientMap.set(c.name, createModelClient(c, {
      localRuntimes: localModelService.runtimes,
      resilience: config.providerResilience,
      telemetry,
    }));
    if (c.pricePer1kInputUsd !== undefined || c.pricePer1kOutputUsd !== undefined) {
      pricing.set(c.name, { inputPer1k: c.pricePer1kInputUsd, outputPer1k: c.pricePer1kOutputUsd });
    }
  }
  for (const client of localModelService.clients()) {
    clientMap.set(client.name, client);
    dynamicClientNames.add(client.name);
  }
  const allModelConfigs = (): ModelClientConfig[] => [
    ...config.models.clients,
    ...localModelService.clientConfigs(),
  ];
  const notificationQueue = new NotificationQueue(
    path.join(dataDir, "notifications", "notifications.jsonl"),
  );

  const schedCfg = config.scheduler;
  const scheduler = new Scheduler(
    path.join(dataDir, "scheduler", "triggers.jsonl"),
    notificationQueue,
    trace,
    {
      workspaceRoot,
      unattendedGoalPatterns: schedCfg?.unattendedGoalPatterns ?? [],
      gitPollIntervalMs: schedCfg?.gitPollIntervalMs ?? 5000,
      defaultCronMissPolicy: schedCfg?.cronMissPolicy ?? "skip",
    },
  );

  const orchestratorHolder: { current?: Orchestrator } = {};
  const backgroundRunStoreHolder: { current?: RunAggregateRepository } = {};

  const backgroundTasks = new BackgroundTaskManager(
    workspaceRoot,
    notificationQueue,
    processSandbox,
    trace,
    (record) => {
      scheduler.handleBackgroundCompleted(record);
      const runs = backgroundRunStoreHolder.current;
      if (!runs || !record.runId) return;
      const existing = runs.get(record.runId);
      let prior: Record<string, unknown> = {};
      if (!existing) return;
      if (existing.result && typeof existing.result === "object" && !Array.isArray(existing.result)) {
        prior = existing.result as Record<string, unknown>;
      }
      if (record.status === "completed") {
        runs.execute({
          type: "run.complete",
          runId: existing.id,
          expectedAggregateVersion: existing.aggregateVersion,
          result: { ...prior, backgroundTask: record },
        });
      } else if (record.status === "cancelled") {
        runs.execute({
          type: "run.cancel",
          runId: existing.id,
          expectedAggregateVersion: existing.aggregateVersion,
          reason: record.error,
        });
      } else {
        runs.execute({
          type: "run.fail",
          runId: existing.id,
          expectedAggregateVersion: existing.aggregateVersion,
          error: record.error ?? `Background task ${record.status}`,
        });
      }
    },
    (input) => {
      const orch = orchestratorHolder.current;
      if (!orch) return;
      void orch
        .executeUnattendedTrigger({
          triggerId: `background:${input.record.id}`,
          goal: input.goal,
        })
        .then(({ runId }) => {
          backgroundTasks.markTriggeredRun(input.record.id, runId);
        })
        .catch((error) => {
          trace.write({
            type: "background_trigger_next_error",
            taskId: input.record.id,
            error: String(error),
          });
        });
    },
    shellPolicy,
  );

  const directChat = createDirectChatFn(() => [...clientMap.values()], {
    strategy: config.routing.strategy,
    fallback: config.routing.fallback,
    metrics,
    trace,
    pricing,
  });

  const registry = createDefaultRegistry({ trace, dataDir, shellPolicy, networkPolicy, processSandbox });
  if (opts.hostCapabilities) registry.setDefaultContext({ hostCapabilities: opts.hostCapabilities });
  registry.register(backgroundTasks.startTool);
  const contextManager = new ContextManager({
    dataDir,
    useLanceDb: true,
    embeddingService: createEmbeddingService(config, modelsDirectory),
  });
  const hooks = new HookManager(contextManager.db.connection);
  hooks.registerConfigured(config.hooks);
  applyModelHooks = (client) => new HookedModelClient(client, hooks);
  for (const [name, client] of clientMap) {
    clientMap.set(name, applyModelHooks(client));
  }
  registry.setHookManager(hooks);
  const resources = new ResourceRegistry(contextManager.db.connection, dataDir);
  registry.setDefaultContext({ resources });
  const runs = new RunAggregateRepository(contextManager.db);
  backgroundRunStoreHolder.current = runs;
  const runStateStore = new RunStateStore(contextManager.db);
  const permissionRequestStore = new PermissionRequestStore(contextManager.db.connection);
  const planHandoffStore = new PlanHandoffStore(contextManager.db.connection);
  const agentPlanStore = new AgentPlanStore(contextManager.db.connection);
  const sessionPermissionGrants = new SessionPermissionGrants(contextManager.db.connection);
  const workspaceGrantStore = new WorkspaceGrantStore(contextManager.db.connection);
  const pausedRunStore = new PausedRunStore(contextManager.db.connection);
  const codeIntelligence = new CodeIntelligenceService([
    ...config.codeIntelligence.lspServers.map((server) =>
      new LspCodeIntelligenceProvider(server)),
    new TreeSitterWasmIntelligenceProvider(),
    new TextFallbackIntelligenceProvider(),
  ]);
  const projectIndex = new ProjectIndex(contextManager.db, codeIntelligence);
  const projectSemanticIndexer = new ProjectSemanticIndexer(
    contextManager.embeddings,
    contextManager.vectors,
  );
  const historyFileRecaller = new HistoryFileRecaller(
    contextManager.db,
    contextManager.memories,
    contextManager.retriever,
  );
  registry.setDefaultContext({ projectIndex, projectSemanticIndexer, historyFileRecaller });
  const mcp = new McpClientManager(
    registry,
    config.mcp.servers,
    workspaceRoot,
    undefined,
    processSandbox,
    opts.hostCapabilities,
  );

  const modelRuntime = createAppModelRoutingRuntime({
    allModelConfigs,
    clientMap,
    db: contextManager.db.connection,
    directChat,
    metrics,
    modelAvailability,
    subAgentLocalModelGate,
    trace,
  });
  modelProfileStoreForRefresh = modelRuntime.modelProfileStore;
  const {
    agentProtocolQualificationStore,
    agentRuntime,
    collaborationRunStore,
    createChatForDelegatedTask,
    defaultAgentChat,
    evalSetRunner,
    fallbackLogStore,
    makeAgentChatFn,
    modelCallLogStore,
    modelEvalStore,
    modelOrchestrator,
    routingProbeService,
    modelProfileRegistry: profileRegistry,
    modelProfileStore,
    planner,
    routeLogStore,
    smartModelRouter,
  } = modelRuntime;
  const agentRunRegistry = new AgentRunRegistry();
  const subAgentWorkspaceManager = new SubAgentWorkspaceManager(processSandbox);
  const subAgentWorkspaceRecovery = subAgentWorkspaceManager.recoverOrphanedScopes(
    collectSubAgentRecoveryRoots(workspaceCatalog, contextManager.listSessions()));
  const subAgentCoordinator = new SubAgentCoordinator({
    chat: defaultAgentChat,
    createChatForDelegatedTask,
    registry,
    trace,
    projectAllowedPermissions,
    notificationQueue,
    maxSubAgentDispatchDepth,
    maxBatchConcurrency: maxSubAgentBatchConcurrency,
    defaultTimeoutMs: subagentDefaultTimeoutMs,
    workspaceManager: subAgentWorkspaceManager,
    hooks,
  });
  const subAgentWorkflowStateCenter = new SubAgentWorkflowStateCenter();
  const subAgentWorkflow = new SubAgentWorkflow(subAgentCoordinator, {
    stateCenter: subAgentWorkflowStateCenter,
    trace,
  });
  registry.setDefaultContext({
    subAgentWorkflow,
    projectAllowedPermissions,
    maxSubAgentDispatchDepth,
  });
  void modelAvailability.refreshAll(clientMap).catch((error) => {
    trace.write({
      type: "model_availability_refresh_error",
      error: String(error),
    });
  });
  const planStore = new PlanStore(contextManager.db);
  const planValidator = new PlanValidator({
    workspaceRoot,
    registry,
  });
  const planApproval = new PlanApprovalManager(planStore);
  const planService = new PlanService({
    workspaceRoot,
    store: planStore,
    validator: planValidator,
    approval: planApproval,
    registry,
    trace,
  });
  const planDraftApiService = new PlanDraftApiService({
    planner,
    planService,
    runs,
    trace,
  });
  const userSkillsDirectory = config.skills.userDirectory
    ? path.resolve(projectRoot, config.skills.userDirectory)
    : path.join(dataDir, "skills");
  const resolveInstructions = (activeWorkspaceRoot: string): string => {
    const resolver = new AgentInstructionResolver(
      new SkillRegistry({
        builtIn: path.join(projectRoot, "skills"),
        user: userSkillsDirectory,
        workspace: activeWorkspaceRoot,
      }),
      new WorkspaceInstructionLoader(),
      config.skills.enabled,
    );
    return renderInstructionBlocks(resolver.resolve(activeWorkspaceRoot));
  };

  const orchestrator = new Orchestrator({
    workspaceRoot,
    activityDataRoot: dataDir,
    resolveWorkspaceRoot: (sessionId?: string) => {
      if (!sessionId) return workspaceCatalog.defaultRoot;
      const session = contextManager.getSession(sessionId);
      return resolveWorkspaceRootFromCatalog(
        workspaceCatalog,
        session?.workspaceKey ?? workspaceCatalog.defaultKey,
      );
    },
    resolveWorkspaceConfigScopes: (sessionId?: string) => {
      const root = (() => {
        if (!sessionId) return workspaceCatalog.defaultRoot;
        const session = contextManager.getSession(sessionId);
        return resolveWorkspaceRootFromCatalog(
          workspaceCatalog,
          session?.workspaceKey ?? workspaceCatalog.defaultKey,
        );
      })();
      return workspaceCatalog.entries
        .filter((entry) => entry.resolvedRoot !== root)
        .map((entry) => ({
          id: `config:${entry.id}`,
          label: entry.label,
          rootPath: entry.resolvedRoot,
          permissions: ["read" as const],
        }));
    },
    planner,
    registry,
    contextManager,
    agentRuntime,
    tasks: contextManager.tasks,
    runs,
    runStateStore,
    projectIndex,
    notificationQueue,
    trace,
    makeChatFn: makeAgentChatFn,
    planService,
    maxCostUsdPerRun: config.security?.budget?.maxCostUsdPerRun,
    projectAllowedPermissions,
    maxSubAgentDispatchDepth,
    agentRunRegistry,
    permissionRequestStore,
    planHandoffStore,
    agentPlanStore,
    sessionPermissionGrants,
    workspaceGrantStore,
    pausedRunStore,
    shellPolicy,
    networkPolicy,
    resolveInstructions,
    hooks,
  });
  orchestratorHolder.current = orchestrator;
  const unifiedAssistantRuntime = createUnifiedAssistantRuntime({
    projectRoot, companionDataDir: paths.companionDataDir, directChat, contextManager,
    workspaceCatalog, orchestrator, trace, makeChatFn: makeAgentChatFn,
    browserAvailable: () =>
      registry.listProviders().some((provider) => provider.id === "browser-main"),
    ...(opts.agentHandoffPermissionPolicy
      ? { permissionPolicy: opts.agentHandoffPermissionPolicy }
      : {}),
  });

  scheduler.setFireHandler((ctx) => {
    if (ctx.unattended) {
      void orchestrator.executeUnattendedTrigger({
        triggerId: ctx.triggerId,
        goal: ctx.goal,
        sessionId: ctx.sessionId,
      });
      return undefined;
    } else {
      return orchestrator.createScheduledRun({
        triggerId: ctx.triggerId,
        goal: ctx.goal,
        sessionId: ctx.sessionId,
      });
    }
  });

  const recoveredResumeClaims = pausedRunStore.recoverInterruptedClaims();
  if (recoveredResumeClaims > 0) {
    trace.write({
      type: "startup_recovery_paused_run_claims",
      recoveredClaims: recoveredResumeClaims,
    });
  }
  const startupRecovery = recoverOnStartup({
    runs,
    notificationQueue,
    trace,
    pausedRunStore,
    permissionRequestStore,
    planHandoffStore,
    subAgentWorkspaceRecovery,
  });
  void orchestrator.recoverPlanAgentContinuations().then((resumed) => {
    if (resumed > 0) {
      trace.write({
        type: "startup_recovery_plan_agent_continuations",
        resumed,
      });
    }
  }).catch((error) => {
    trace.write({
      type: "startup_recovery_plan_agent_continuations_error",
      error: String(error),
    });
  });

  const toolsDbPath = registry.getStorage()?.dbPath;
  const dataLifecycle = new DataLifecycleService({
    dataDir,
    workspaceRoot,
    traceFile: paths.traceFile,
    tracesDir: paths.tracesDir,
    traceCatalog,
    notificationFile: path.join(dataDir, "notifications", "notifications.jsonl"),
    schedulerJournalFile: path.join(dataDir, "scheduler", "triggers.jsonl"),
    memoryDb: contextManager.db,
    toolsDbPath,
    getActiveRunIds: () => agentRunRegistry.listRunning().map((r) => r.runId),
  });
  const runtime = new AppRuntimeController({
    scheduler,
    dataLifecycle,
    autoCleanupEnabled: lifecyclePolicy.cleanup.autoEnabled,
    autoCleanupIntervalMs: lifecyclePolicy.cleanup.autoIntervalHours * 60 * 60 * 1000,
    managedRuntime: localModelService,
  });

  const app = new AppContext({
    profile,
    config,
    workspaceRoot,
    workspaceCatalog,
    paths,
    clientMap,
    localModelService,
    metrics,
    trace,
    traceCatalog,
    notificationQueue,
    scheduler,
    backgroundTasks,
    processSandbox,
    directChat,
    planner,
    registry,
    contextManager,
    agentRuntime,
    ...unifiedAssistantRuntime,
    runs,
    runStateStore,
    projectIndex,
    projectSemanticIndexer,
    historyFileRecaller,
    orchestrator,
    subAgentLocalModelGate,
    subAgentWorkflow,
    subAgentWorkflowStateCenter,
    smartModelRouter,
    modelOrchestrator,
    routingProbeService,
    planService,
    planDraftApiService,
    routeLogStore,
    modelCallLogStore,
    modelAvailability,
    collaborationRunStore,
    fallbackLogStore,
    modelEvalStore,
    evalSetRunner,
    modelProfileStore,
    modelProfileRegistry: profileRegistry,
    agentProtocolQualificationStore,
    makeAgentChatFn,
    projectAllowedPermissions,
    shellPolicy,
    networkPolicy,
    dataLifecycle,
    permissionRequestStore,
    planHandoffStore,
    agentPlanStore,
    sessionPermissionGrants,
    workspaceGrantStore,
    pausedRunStore,
    mcp,
    resources,
    hooks,
    hostCapabilities: opts.hostCapabilities,
    telemetry,
    startupRecovery,
    runtime,
  });
  if (
    startupRecovery.interruptedRuns > 0 ||
    startupRecovery.preservedPausedRuns > 0 ||
    startupRecovery.recoveredSubAgentScopes > 0 ||
    startupRecovery.preservedActiveSubAgentScopes > 0 ||
    startupRecovery.quarantinedSubAgentScopeEntries > 0 ||
    startupRecovery.pendingNotifications > 0
  ) {
    console.warn(
      `[startupRecovery] interruptedRuns=${startupRecovery.interruptedRuns} preservedPausedRuns=${startupRecovery.preservedPausedRuns} recoveredSubAgentScopes=${startupRecovery.recoveredSubAgentScopes} preservedActiveSubAgentScopes=${startupRecovery.preservedActiveSubAgentScopes} quarantinedSubAgentScopeEntries=${startupRecovery.quarantinedSubAgentScopeEntries} pendingNotifications=${startupRecovery.pendingNotifications}`,
    );
  }
  if (schedCfg?.dailySummaryCron && schedCfg.dailySummaryGoal) {
    const hasDaily = scheduler.list().some((t) => t.name === "__daily_summary__");
    if (!hasDaily) {
      scheduler.register({
        name: "__daily_summary__",
        kind: "cron",
        goal: schedCfg.dailySummaryGoal,
        cron: schedCfg.dailySummaryCron,
        cronMissPolicy: schedCfg.cronMissPolicy ?? "skip",
      });
    }
  }

  return app;
}

function createEmbeddingService(config: AppConfig, modelsDirectory: string): EmbeddingService {
  const embedding = config.models.embedding;
  if (!embedding || embedding.provider === "lexical") {
    return new EmbeddingService(new LocalLexicalEmbeddingProvider());
  }
  return new EmbeddingService(new LocalGgufEmbeddingProvider({
    modelId: embedding.modelId!,
    modelPath: path.resolve(modelsDirectory, embedding.modelPath!),
    sha256: embedding.sha256!,
    dimension: embedding.dimension!,
    gpuLayers: embedding.gpuLayers,
  }));
}
