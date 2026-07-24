import { randomUUID } from "node:crypto";

import type { ModelOrchestrator } from "../model-orchestrator/index.js";
import type { OrchestratorInput, OrchestratorResult } from "../model-orchestrator/types.js";
import type { RouteOptions } from "../model/routeOptions.js";
import type { ChatRequest, ModelResponse } from "../model/types.js";
import { buildRouterInputFromChat } from "../model-router/router-input.js";
import { estimateRouterContextTokens } from "../model-router/router-context-estimate.js";
import {
  applyPromptStrategyToSystemText,
  defaultPromptStrategyBuilder,
  type PromptStrategy,
} from "../model-router/prompt-strategy-builder.js";
import type { SmartModelRouter } from "../model-router/smart-model-router.js";
import type { RouterDecision } from "../model-router/types.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import {
  ModelRoutingProbeResultSchema,
  type ModelRoutingProbeRequest,
  type ModelRoutingProbeResult,
  type ModelRoutingProbeStreamEvent,
} from "./ModelRoutingProbeContracts.js";

export interface ModelRoutingProbeServiceDeps {
  directChat: (request: ChatRequest, opts?: RouteOptions) => Promise<ModelResponse>;
  smartModelRouter: SmartModelRouter;
  modelOrchestrator: ModelOrchestrator;
  trace?: TraceLogger;
}

interface ProbeExecutionOptions {
  requestId: string;
  signal?: AbortSignal;
  onToken?: (delta: string) => void;
}

/**
 * Stateless model-routing diagnostic. It never creates a user conversation,
 * writes chat memory, owns tools, or creates an Agent grant.
 */
export class ModelRoutingProbeService {
  constructor(private readonly deps: ModelRoutingProbeServiceDeps) {}

  async run(input: ModelRoutingProbeRequest): Promise<ModelRoutingProbeResult> {
    return this.execute(input, { requestId: randomUUID() });
  }

  async stream(
    input: ModelRoutingProbeRequest,
    emit: (event: ModelRoutingProbeStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const requestId = randomUUID();
    emit({ type: "probe_start", requestId });
    const result = await this.execute(input, {
      requestId,
      signal,
      onToken: input.streamTokens
        ? (delta) => {
            if (delta) emit({ type: "token", requestId, delta });
          }
        : undefined,
    });
    emit({ type: "done", requestId, result });
  }

  private async execute(
    input: ModelRoutingProbeRequest,
    options: ProbeExecutionOptions,
  ): Promise<ModelRoutingProbeResult> {
    this.deps.trace?.write({
      type: "model_routing_probe_start",
      requestId: options.requestId,
      forcedClient: input.clientName,
    });
    try {
      const result = input.clientName
        ? await this.executeForced({ ...input, clientName: input.clientName }, options)
        : await this.executeSmart(input, options);
      this.deps.trace?.write({
        type: "model_routing_probe_end",
        requestId: options.requestId,
        status: "completed",
        routingKind: result.routing.kind,
        usedModelIds: result.execution.usedModelIds,
      });
      return ModelRoutingProbeResultSchema.parse(result);
    } catch (error) {
      this.deps.trace?.write({
        type: "model_routing_probe_end",
        requestId: options.requestId,
        status: "failed",
      });
      throw error;
    }
  }

  private async executeForced(
    input: ModelRoutingProbeRequest & { clientName: string },
    options: ProbeExecutionOptions,
  ): Promise<ModelRoutingProbeResult> {
    const response = await this.deps.directChat(
      {
        messages: probeMessages(input.system, input.message),
        temperature: 0.3,
        signal: options.signal,
        onToken: options.onToken,
      },
      {
        forceClient: input.clientName,
        sensitive: input.sensitive,
        taskType: input.taskType,
      },
    );
    return {
      requestId: options.requestId,
      kind: "model_routing_probe",
      content: response.content,
      routing: {
        kind: "forced_client",
        requestedClientName: input.clientName,
      },
      model: publicModel(response),
      execution: {
        usedModelIds: [response.clientName],
        modelCallIds: [],
      },
    };
  }

  private async executeSmart(
    input: ModelRoutingProbeRequest,
    options: ProbeExecutionOptions,
  ): Promise<ModelRoutingProbeResult> {
    const baseMessages = probeMessages(input.system, input.message);
    const routed = this.deps.smartModelRouter.routeDetailed(buildRouterInputFromChat({
      message: input.message,
      sensitive: input.sensitive,
      qualityMode: input.qualityMode,
      taskType: input.taskType,
      allowCollaboration: input.allowCollaboration,
      forceSingleModel: input.forceSingleModel,
      contextTokenEstimate: estimateRouterContextTokens(baseMessages),
      recentMessagesCount: baseMessages.length,
      maxCostUsd: input.maxCostUsd,
      spentCostUsd: input.spentCostUsd,
    }));
    const promptStrategy = defaultPromptStrategyBuilder.build({
      decision: routed.decision,
      routingContext: routed.routingContext,
      userInput: input.message,
      qualityMode: input.qualityMode,
    });
    const orchestratorInput: OrchestratorInput = {
      routerDecision: routed.decision,
      userInput: input.message,
      localOnly: input.sensitive,
      temperature: promptStrategy.temperature,
      onToken: options.onToken,
      signal: options.signal,
      renderedPrompt: {
        systemSectionsText: applyPromptStrategyToSystemText(input.system ?? "", promptStrategy),
        finalMessages: probeMessages(
          applyPromptStrategyToSystemText(input.system ?? "", promptStrategy),
          input.message,
        ),
      },
    };
    const result = await this.deps.modelOrchestrator.run(orchestratorInput);
    return {
      requestId: options.requestId,
      kind: "model_routing_probe",
      content: result.finalAnswer,
      routing: {
        kind: "smart",
        decision: publicDecision(routed.decision, promptStrategy),
      },
      model: publicOrchestratedModel(result),
      execution: publicExecution(result),
    };
  }
}

function probeMessages(
  system: string | undefined,
  message: string,
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  return [
    ...(system?.trim() ? [{ role: "system" as const, content: system.trim() }] : []),
    { role: "user" as const, content: message },
  ];
}

function publicDecision(decision: RouterDecision, promptStrategy: PromptStrategy) {
  return {
    id: decision.id,
    taskType: decision.taskType,
    executionStrategy: decision.executionStrategy,
    risk: decision.risk,
    reason: decision.reason,
    source: decision.source,
    requiresSafetyReview: decision.requireUserConfirmation,
    selectedModelId: decision.selectedModelId,
    draftModelId: decision.draftModelId,
    reviewModelId: decision.reviewModelId,
    finalModelId: decision.finalModelId,
    voteModelIds: decision.voteModelIds,
    judgeModelId: decision.judgeModelId,
    contextSignals: decision.contextSignals,
    promptStrategy: {
      temperature: promptStrategy.temperature,
      responseStyle: promptStrategy.responseStyle,
      preferJsonMode: promptStrategy.preferJsonMode,
      hints: promptStrategy.hints,
    },
  };
}

function publicModel(response: ModelResponse): ModelRoutingProbeResult["model"] {
  return {
    clientName: response.clientName,
    modelName: response.modelName,
    location: response.location,
    latencyMs: Math.max(0, Math.round(response.latencyMs)),
    usage: response.usage,
  };
}

function publicOrchestratedModel(result: OrchestratorResult): ModelRoutingProbeResult["model"] {
  const location = result.location;
  if (
    !result.clientName
    || !result.modelName
    || (location !== "local" && location !== "remote")
  ) return null;
  return {
    clientName: result.clientName,
    modelName: result.modelName,
    location,
    latencyMs: Math.max(0, Math.round(result.latencyMs ?? 0)),
    usage: result.usage,
  };
}

function publicExecution(result: OrchestratorResult) {
  const vote = result.voteResult
    ? {
        winnerModelId: result.voteResult.winnerModelId,
        candidateModelIds: result.voteResult.candidates.map((candidate) => candidate.modelId),
        reason: result.voteResult.reason,
      }
    : undefined;
  return {
    usedModelIds: result.usedModelIds,
    modelCallIds: result.modelCallIds,
    collaborationRunId: result.collaborationRunId,
    fallbackCount: result.fallbackCount,
    fallbackLogIds: result.fallbackLogIds,
    vote,
  };
}
