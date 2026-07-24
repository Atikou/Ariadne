import type { DelegatedTask } from "../subagent/delegatedTask.js";
import { analyzeTaskRoutingSignals } from "../subagent/routingSignals.js";
import { buildAgentRoutingMeta } from "./agent-routing-summary.js";
import { applyPromptStrategyToMessages } from "./apply-prompt-strategy-messages.js";
import { defaultPromptStrategyBuilder } from "./prompt-strategy-builder.js";
import { resolveRuleOnlyAnswer } from "./rule-only-responses.js";
import { isModelUnavailableError } from "./model-availability.js";
import type { SmartModelRouter } from "./smart-model-router.js";
import { RouterError, type RouterInput } from "./types.js";
import type { ModelChatFn } from "../model-orchestrator/types.js";
import type { LoopChatFn } from "./agent-chat-types.js";
import { extractLastUserMessage } from "./create-smart-single-model-chat.js";
import type { ModelLocation } from "../model/types.js";
import type { SubAgentLocalModelGate } from "../subagent/SubAgentLocalModelGate.js";

export interface SubAgentChatContext {
  sensitive?: boolean;
  taskText?: string;
  parentTaskId?: string;
  parentIntent?: string;
  parentWorkflowType?: string;
}

export function buildDelegatedTaskRouterInput(
  task: DelegatedTask,
  userInput: string,
  opts?: SubAgentChatContext & {
    messages?: ReadonlyArray<{ role: string; content: string }>;
  },
): RouterInput {
  const text = userInput.trim() || [task.goal, task.input].filter(Boolean).join("\n");
  const messages = opts?.messages ?? [];
  const signals = analyzeTaskRoutingSignals(text, task.input, task.modelPolicy);

  let qualityMode = signals.qualityMode;
  let taskTypeOverride = signals.taskType;
  const parentIntent = opts?.parentIntent ?? "";
  const parentWorkflow = opts?.parentWorkflowType ?? "";
  if (
    parentIntent === "debug" ||
    parentWorkflow.includes("debug") ||
    parentIntent === "run" ||
    parentWorkflow.includes("verify")
  ) {
    taskTypeOverride = "debug";
    if (qualityMode === "fast") qualityMode = "balanced";
  } else if (
    parentIntent === "edit" ||
    parentIntent === "refactor" ||
    parentWorkflow.includes("edit") ||
    parentWorkflow.includes("refactor")
  ) {
    taskTypeOverride = "code_edit";
  }

  return {
    userInput: text,
    mode: "tool",
    qualityMode,
    localOnly: opts?.sensitive === true || task.modelPolicy?.prefer === "local",
    forceSingleModel: true,
    allowCollaboration: false,
    mayUseTools: true,
    mayModifyWorkspace: task.toolPolicy?.writeAllowed ?? false,
    taskTypeOverride,
    contextTokenEstimate: signals.contextTokenEstimate,
    recentMessagesCount: messages.length > 0 ? messages.length : undefined,
  };
}

export type DelegatedTaskChatFactory = (
  task: DelegatedTask,
  ctx: SubAgentChatContext,
) => LoopChatFn;

export function createDelegatedTaskChatFn(deps: {
  smartRouter: SmartModelRouter;
  modelChatFn: ModelChatFn;
  localModelGate: SubAgentLocalModelGate;
  resolveModelLocation: (modelId: string) => ModelLocation | undefined;
}): DelegatedTaskChatFactory {
  return (task, ctx) => {
    const boundCtx = ctx;
    return async (request, chatOpts) => {
      const userInput = extractLastUserMessage(request.messages);
      const routerInput = buildDelegatedTaskRouterInput(task, userInput, {
        ...boundCtx,
        sensitive: boundCtx.sensitive ?? chatOpts?.sensitive,
        taskText: task.goal,
        messages: request.messages,
      });
      let lastUnavailable: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let routed;
        try {
          routed = deps.smartRouter.routeDetailed(routerInput);
        } catch (error) {
          if (error instanceof RouterError) {
            throw new Error(lastUnavailable ? `${error.message}；上一候选不可用：${String(lastUnavailable)}` : error.message);
          }
          throw error;
        }

        const decision = routed.decision;
        const promptStrategy = defaultPromptStrategyBuilder.build({
          decision,
          routingContext: routed.routingContext,
          userInput,
          qualityMode: routerInput.qualityMode,
        });
        const routingMeta = buildAgentRoutingMeta(decision, promptStrategy);

        if (decision.executionStrategy === "rule_only") {
          const content = JSON.stringify({
            action: "final",
            answer: resolveRuleOnlyAnswer(decision.taskType, userInput),
          });
          return {
            content,
            toolCalls: [],
            clientName: "rule-only",
            modelName: "rule-only",
            location: "local",
            latencyMs: 0,
            routingMeta,
          };
        }

        const modelId = decision.selectedModelId;
        if (!modelId) {
          throw new Error(`子任务「${task.goal.slice(0, 40)}」路由未选出可用模型`);
        }

        const chatRequest = {
          ...request,
          temperature: promptStrategy.temperature,
          messages: applyPromptStrategyToMessages(request.messages, promptStrategy),
        };
        try {
          const invoke = () =>
            deps.modelChatFn(modelId, chatRequest, {
              routeLogId: decision.id,
              role: "primary",
              sessionId: decision.sessionId,
            });
          const { response } = await deps.localModelGate.runIfLocal(
            deps.resolveModelLocation(modelId),
            request.signal,
            invoke,
          );
          return { ...response, routingMeta };
        } catch (error) {
          if (!isModelUnavailableError(error)) throw error;
          lastUnavailable = error;
        }
      }
      throw new Error(`子任务「${task.goal.slice(0, 40)}」候选模型均不可用：${String(lastUnavailable)}`);
    };
  };
}
