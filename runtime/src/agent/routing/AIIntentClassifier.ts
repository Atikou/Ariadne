import type { ModelTaskType } from "../../model/taskType.js";
import type { ChatRequest } from "../../model/types.js";
import type { ModelChatFn } from "../../model-orchestrator/types.js";
import { isModelUnavailableError } from "../../model-router/model-availability.js";
import { buildRouterInputFromChat } from "../../model-router/router-input.js";
import type { SmartModelRouter } from "../../model-router/smart-model-router.js";
import type { AgentIntentType } from "../IntentTypes.js";
import { defaultWorkflowPlanner } from "../WorkflowPlanner.js";
import { defaultWorkflowRouter } from "../WorkflowRouter.js";
import { runModeForIntent } from "../intentPatterns.js";
import type { TaskContext } from "../task/TaskContext.js";
import type { IntentDecision } from "./IntentDecision.js";
import {
  buildIntentClassifierUserMessage,
  INTENT_CLASSIFIER_SYSTEM_PROMPT,
} from "./intentClassifierPrompt.js";

export interface AIIntentClassifierInput {
  message: string;
  taskType?: ModelTaskType;
  sessionId?: string;
  taskContext?: TaskContext;
}

export type IntentClassifierChatFn = (
  input: AIIntentClassifierInput,
) => Promise<string | null>;

const VALID_INTENTS = new Set<AgentIntentType>([
  "answer",
  "plan",
  "edit",
  "run",
  "debug",
  "review",
  "verify",
  "summarize",
  "search",
  "refactor",
  "generate_file",
]);

const CLASSIFIER_TIMEOUT_MS = 8_000;
const MIN_CONFIDENCE = 0.6;

export interface IntentClassifierDiff {
  sessionId?: string;
  messagePreview: string;
  aiIntent?: AgentIntentType;
  legacyIntent?: AgentIntentType;
  aiConfidence?: number;
}

export class AIIntentClassifier {
  private lastDiff: IntentClassifierDiff | null = null;

  constructor(private readonly classifierChatFn: IntentClassifierChatFn | null = null) {}

  getLastDiff(): IntentClassifierDiff | null {
    return this.lastDiff;
  }

  async classifyAsync(input: AIIntentClassifierInput): Promise<IntentDecision | null> {
    if (!this.classifierChatFn) return null;
    try {
      const raw = await withTimeout(this.classifierChatFn(input), CLASSIFIER_TIMEOUT_MS);
      if (!raw?.trim()) return null;
      const parsed = parseClassifierJson(raw);
      if (!parsed || !VALID_INTENTS.has(parsed.intent)) return null;
      if (parsed.confidence < MIN_CONFIDENCE) return null;

      const workflowType = defaultWorkflowRouter.routeIntent(parsed.intent).workflowType;
      const mode = runModeForIntent(parsed.intent);
      return {
        mode,
        modeSource: "inferred",
        intent: parsed.intent,
        workflowType,
        workflowPlan: defaultWorkflowPlanner.plan(input.message, mode, parsed.intent),
        isContinuation: parsed.isContinuation,
        isNewTask: parsed.isNewTask,
        needsWrite:
          parsed.intent === "edit" || parsed.intent === "generate_file" || parsed.intent === "refactor",
        needsRunCommand: parsed.intent === "run" || parsed.intent === "verify" || parsed.intent === "debug",
        confidence: parsed.confidence,
        reason: "ai_intent_classifier",
        source: "ai_classifier",
      };
    } catch {
      return null;
    }
  }

  recordDiff(input: {
    sessionId?: string;
    message: string;
    aiDecision: IntentDecision | null;
    legacyIntent: AgentIntentType;
  }): void {
    this.lastDiff = {
      sessionId: input.sessionId,
      messagePreview: input.message.slice(0, 120),
      aiIntent: input.aiDecision?.intent,
      legacyIntent: input.legacyIntent,
      aiConfidence: input.aiDecision?.confidence,
    };
  }
}

export function createIntentClassifierChatFn(deps: {
  smartRouter: SmartModelRouter;
  modelChatFn: ModelChatFn;
}): IntentClassifierChatFn {
  return async (input) => {
    const userContent = buildIntentClassifierUserMessage({
      message: input.message,
      context: {
        taskContext: input.taskContext,
        reconciledWorkflowType: input.taskContext?.reconciledWorkflowType,
        reconciledIntent: input.taskContext?.reconciledIntent,
        completionStatus: input.taskContext?.lastCompletionStatus,
        lastStopReason: input.taskContext?.lastStopReason,
        toolLedgerSummary: formatTaskSideEffectSummary(input.taskContext?.lastSideEffectSummary),
      },
    });
    const request: ChatRequest = {
      messages: [
        { role: "system", content: INTENT_CLASSIFIER_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      temperature: 0,
    };
    const routerInput = buildRouterInputFromChat({
      message: input.message,
      taskType: "simple",
      forceSingleModel: true,
      allowCollaboration: false,
    });
    let lastUnavailable: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const routed = deps.smartRouter.routeDetailed(routerInput);
        const modelId = routed.decision.selectedModelId;
        if (!modelId || routed.decision.executionStrategy === "rule_only") return null;
        const { response } = await deps.modelChatFn(modelId, request, {
          routeLogId: routed.decision.id,
          role: "primary",
          sessionId: input.sessionId,
        });
        return response.content;
      } catch (error) {
        if (isModelUnavailableError(error)) {
          lastUnavailable = error;
          continue;
        }
        throw error;
      }
    }
    if (lastUnavailable) throw lastUnavailable;
    return null;
  };
}

interface ClassifierJson {
  intent: AgentIntentType;
  isContinuation: boolean;
  isNewTask: boolean;
  confidence: number;
}

function parseClassifierJson(raw: string): ClassifierJson | null {
  const trimmed = raw.trim();
  const candidates = [trimmed];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.unshift(fence[1].trim());
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate) as Record<string, unknown>;
      const intent = obj.intent;
      if (typeof intent !== "string" || !VALID_INTENTS.has(intent as AgentIntentType)) continue;
      const confidence = typeof obj.confidence === "number" ? obj.confidence : 0;
      return {
        intent: intent as AgentIntentType,
        isContinuation: obj.isContinuation === true,
        isNewTask: obj.isNewTask === true,
        confidence,
      };
    } catch {
      // try next candidate
    }
  }
  return null;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("intent_classifier_timeout")), ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function formatTaskSideEffectSummary(
  summary?: import("../task/TaskContext.js").TaskSideEffectSummary,
): string | undefined {
  if (!summary) return undefined;
  const parts: string[] = [];
  if (summary.wroteFiles.length) parts.push(`wrote=${summary.wroteFiles.slice(0, 3).join(",")}`);
  if (summary.ranShell) parts.push("ranShell=true");
  return parts.length ? parts.join("; ") : undefined;
}
