import type { DatabaseSync } from "node:sqlite";

import { Planner } from "../agent/Planner.js";
import { ModelRoutingProbeService } from "./ModelRoutingProbeService.js";
import type { LoopChatFn } from "../agent/AgentLoop.js";
import { createAgentRuntimeServices, type AgentRuntimeServices } from "../agent/AgentRuntimeServices.js";
import { createIntentClassifierChatFn } from "../agent/routing/AIIntentClassifier.js";
import type { ModelClientConfig } from "../config/types.js";
import { parseAgentModelAction } from "../core/AgentActionProtocol.js";
import type { MetricsRegistry } from "../model/MetricsRegistry.js";
import type { createDirectChatFn } from "../model/directChat.js";
import type { ModelClient } from "../model/types.js";
import { ModelOrchestrator } from "../model-orchestrator/index.js";
import {
  AgentProtocolQualificationStore,
  buildModelProfiles,
  CollaborationRunStore,
  createAgentChatFn,
  createDelegatedTaskChatFn,
  createModelChatFn,
  createPlannerChatFn,
  EvalSetRunner,
  FallbackLogStore,
  FallbackManager,
  ModelAvailabilityRegistry,
  ModelCallLogStore,
  ModelEvalStore,
  ModelProfileStore,
  type ModelRegistry,
  type ModelProfile,
  RouteLogStore,
  RuntimeStatsFeedback,
  SmartModelRouter,
  validateCapabilityMatrixCoverage,
  validateModelProfiles,
} from "../model-router/index.js";
import { SubAgentLocalModelGate } from "../subagent/SubAgentLocalModelGate.js";
import type { TraceLogger } from "../trace/TraceLogger.js";

type DirectChatFn = ReturnType<typeof createDirectChatFn>;

export interface AppModelRoutingRuntime {
  agentRuntime: AgentRuntimeServices;
  agentProtocolQualificationStore: AgentProtocolQualificationStore;
  collaborationRunStore: CollaborationRunStore;
  createChatForDelegatedTask: ReturnType<typeof createDelegatedTaskChatFn>;
  defaultAgentChat: LoopChatFn;
  evalSetRunner: EvalSetRunner;
  fallbackLogStore: FallbackLogStore;
  makeAgentChatFn: (forceClient?: string) => LoopChatFn;
  modelAvailability: ModelAvailabilityRegistry;
  modelCallLogStore: ModelCallLogStore;
  modelEvalStore: ModelEvalStore;
  modelOrchestrator: ModelOrchestrator;
  modelProfileRegistry: ModelRegistry;
  modelProfileStore: ModelProfileStore;
  planner: Planner;
  routingProbeService: ModelRoutingProbeService;
  routeLogStore: RouteLogStore;
  smartModelRouter: SmartModelRouter;
}

export interface AppModelRoutingRuntimeOptions {
  allModelConfigs: () => ModelClientConfig[];
  clientMap: Map<string, ModelClient>;
  db: DatabaseSync;
  directChat: DirectChatFn;
  metrics: MetricsRegistry;
  modelAvailability: ModelAvailabilityRegistry;
  subAgentLocalModelGate: SubAgentLocalModelGate;
  trace: TraceLogger;
}

/** Composes the application-scoped model routing, qualification and collaboration runtime. */
export function createAppModelRoutingRuntime(
  options: AppModelRoutingRuntimeOptions,
): AppModelRoutingRuntime {
  const modelProfiles = buildModelProfiles(options.allModelConfigs());
  for (const message of validateModelProfiles(modelProfiles)) {
    console.warn(`[model-router] 配置校验：${message}`);
  }
  for (const message of validateCapabilityMatrixCoverage(modelProfiles)) {
    console.warn(`[model-router] 能力矩阵覆盖：${message}`);
  }

  const agentProtocolQualificationStore = new AgentProtocolQualificationStore(options.db);
  const modelProfileStore = ModelProfileStore.fromClients(options.allModelConfigs(), {
    db: options.db,
    metrics: options.metrics,
    availability: options.modelAvailability,
    agentProtocolQualification: agentProtocolQualificationStore,
  });
  const modelProfileRegistry = modelProfileStore.registry;
  const routeLogStore = new RouteLogStore(options.db);
  const modelCallLogStore = new ModelCallLogStore(options.db);
  const collaborationRunStore = new CollaborationRunStore(options.db);
  const fallbackLogStore = new FallbackLogStore(options.db);
  const modelEvalStore = new ModelEvalStore(options.db);
  const evalSetRunner = new EvalSetRunner(modelProfileRegistry, modelEvalStore);
  const fallbackManager = new FallbackManager(modelProfileRegistry);
  const runtimeStatsFeedback = new RuntimeStatsFeedback(options.db);
  const smartModelRouter = new SmartModelRouter(
    modelProfileRegistry,
    routeLogStore,
    runtimeStatsFeedback,
  );
  const modelChatFn = createModelChatFn(
    options.clientMap,
    modelCallLogStore,
    options.trace,
    options.modelAvailability,
  );
  const agentRuntime = createAgentRuntimeServices({
    db: options.db,
    classifierChatFn: createIntentClassifierChatFn({ smartRouter: smartModelRouter, modelChatFn }),
  });
  const defaultAgentChat = createAgentChatFn({
    smartRouter: smartModelRouter,
    modelChatFn,
    modelRegistry: modelProfileRegistry,
    qualificationStore: agentProtocolQualificationStore,
  });
  const createChatForDelegatedTask = createDelegatedTaskChatFn({
    smartRouter: smartModelRouter,
    modelChatFn,
    localModelGate: options.subAgentLocalModelGate,
    resolveModelLocation: (modelId) => options.clientMap.get(modelId)?.location,
  });
  const planner = new Planner(
    createPlannerChatFn({ smartRouter: smartModelRouter, modelChatFn }),
  );
  const modelOrchestrator = new ModelOrchestrator(
    modelChatFn,
    collaborationRunStore,
    fallbackManager,
    fallbackLogStore,
  );
  const routingProbeService = new ModelRoutingProbeService({
    directChat: options.directChat,
    smartModelRouter,
    modelOrchestrator,
    trace: options.trace,
  });
  const makeAgentChatFn = createAgentChatFactory({
    directChat: options.directChat,
    defaultAgentChat,
    modelProfileRegistry,
    qualificationStore: agentProtocolQualificationStore,
  });
  return {
    agentRuntime,
    agentProtocolQualificationStore,
    collaborationRunStore,
    createChatForDelegatedTask,
    defaultAgentChat,
    evalSetRunner,
    fallbackLogStore,
    makeAgentChatFn,
    modelAvailability: options.modelAvailability,
    modelCallLogStore,
    modelEvalStore,
    modelOrchestrator,
    modelProfileRegistry,
    modelProfileStore,
    planner,
    routingProbeService,
    routeLogStore,
    smartModelRouter,
  };
}

export function createAgentChatFactory(input: {
  directChat: DirectChatFn;
  defaultAgentChat: LoopChatFn;
  modelProfileRegistry: Pick<ModelRegistry, "get">;
  qualificationStore: {
    recordSuccess(profile: ModelProfile): unknown;
    recordFailure(profile: ModelProfile, reason: string): unknown;
  };
}): (forceClient?: string) => LoopChatFn {
  return (forceClient?: string): LoopChatFn => {
    if (!forceClient) return input.defaultAgentChat;
    return async (request, options) => {
      const response = await input.directChat(request, {
        sensitive: options?.sensitive,
        taskType: options?.taskType,
        forceClient,
      });
      const profile = input.modelProfileRegistry.get(forceClient);
      if (profile) {
        if (parseAgentModelAction(response.content, response.toolCalls)) {
          input.qualificationStore.recordSuccess(profile);
        } else {
          input.qualificationStore.recordFailure(
            profile,
            "模型响应未通过严格 AgentAction schema",
          );
        }
      }
      return response;
    };
  };
}
