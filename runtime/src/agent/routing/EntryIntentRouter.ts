import { intentForExplicitMode, runModeForIntent } from "../intentPatterns.js";
import { parseRunModeValue } from "../RunPolicyTypes.js";
import type { ModelTaskType } from "../../model/taskType.js";
import type { TaskContext } from "../task/TaskContext.js";
import { AIIntentClassifier } from "./AIIntentClassifier.js";
import { shouldInheritActiveTaskOnUncertain } from "./ContinuationDetector.js";
import { extractMessageContinuationSignals } from "./MessageSignalExtractor.js";
import {
  evaluateTaskContinuation,
  shouldGuardrailOverrideAiClassifier,
  type TaskContinuationDecision,
} from "./TaskContinuationEngine.js";
import { evaluateTaskBoundary } from "./TaskBoundaryDecision.js";
import type { IntentDecision } from "./IntentDecision.js";
import { resolveLegacyIntentFallback } from "./LegacyIntentFallback.js";
import type { SessionTaskManager } from "../task/SessionTaskManager.js";
import { SessionTaskManager as SessionTaskManagerImpl } from "../task/SessionTaskManager.js";
import { resolveForContinuation, resolveWorkflow } from "./WorkflowResolver.js";
import { buildRoutingSnapshot, shouldMarkSessionInactive } from "./RoutingSnapshot.js";
import { enrichIntentDecision } from "./IntentDecisionEnrichment.js";

export interface EntryIntentRouteInput {
  requestedMode?: string;
  forceRequestedMode?: boolean;
  message?: string;
  taskType?: ModelTaskType;
  sessionId?: string;
  taskContext?: TaskContext;
}

/**
 * 入口意图路由：
 * RoutingSnapshot → WorkflowResolver（含续写 workflow 重解析）
 */
export class EntryIntentRouter {
  constructor(
    private readonly sessionTasks: SessionTaskManager = new SessionTaskManagerImpl(),
    private readonly aiClassifier: AIIntentClassifier = new AIIntentClassifier(),
  ) {}

  resolve(input: EntryIntentRouteInput = {}): IntentDecision {
    return this.finalizeDecision(input, null);
  }

  async resolveAsync(input: EntryIntentRouteInput = {}): Promise<IntentDecision> {
    if (input.forceRequestedMode && parseRunModeValue(input.requestedMode)) {
      return this.finalizeDecision(input, null);
    }
    const sessionId = input.sessionId?.trim();
    const taskContext =
      input.taskContext ?? (sessionId ? this.sessionTasks.getContext(sessionId) : undefined);
    const aiDecision = await this.aiClassifier.classifyAsync({
      message: input.message ?? "",
      taskType: input.taskType,
      sessionId,
      taskContext,
    });
    return this.finalizeDecision(input, aiDecision);
  }

  private finalizeDecision(
    input: EntryIntentRouteInput,
    aiDecision: IntentDecision | null,
  ): IntentDecision {
    const explicit = input.forceRequestedMode ? parseRunModeValue(input.requestedMode) : undefined;
    if (explicit) {
      const fallback = resolveLegacyIntentFallback({
        requestedMode: input.requestedMode,
        forceRequestedMode: true,
        message: input.message,
        taskType: input.taskType,
      });
      const intent = intentForExplicitMode(explicit);
      return enrichIntentDecision(
        {
          ...fallback,
          mode: explicit,
          intent,
          modeSource: "explicit",
          source: "explicit_mode",
          reason: "显式 mode 覆盖",
          confidence: 1,
        },
        {
          boundary: {
            hasExplicitActionAnchor: true,
            requiredSideEffects: [],
            breaksContinuation: false,
            reason: "",
          },
          effectiveTaskContext: undefined,
        },
        fallback,
      );
    }

    const sessionId = input.sessionId?.trim();
    const rawTaskContext =
      input.taskContext ?? (sessionId ? this.sessionTasks.getContext(sessionId) : undefined);
    const message = input.message ?? "";
    const signals = extractMessageContinuationSignals(message);
    const boundary = evaluateTaskBoundary(message, rawTaskContext, signals);
    let continuation = evaluateTaskContinuation(message, rawTaskContext, signals);

    const snapshot = buildRoutingSnapshot({
      taskContext: rawTaskContext,
      signals,
      boundary,
      continuation,
      aiDecision,
    });

    if (boundary.breaksContinuation) {
      continuation = {
        kind: "new_task",
        score: 1,
        reason: boundary.reason,
        signals: {
          ...continuation.signals,
          breaksContinuation: true,
          boundaryBreak: true,
        },
      };
      snapshot.continuation = continuation;
      snapshot.effectiveTaskContext = undefined;
    }

    if (sessionId && shouldMarkSessionInactive(snapshot)) {
      this.sessionTasks.markInactive(sessionId);
      snapshot.effectiveTaskContext = undefined;
    }

    const effectiveCtx = snapshot.effectiveTaskContext;

    const legacy = resolveLegacyIntentFallback({
      message,
      taskType: input.taskType,
    });
    snapshot.legacyDecision = legacy;

    this.aiClassifier.recordDiff({
      sessionId,
      message,
      aiDecision,
      legacyIntent: legacy.legacyIntentHint ?? legacy.intent,
    });

    if (
      sessionId &&
      continuation.kind === "inherit" &&
      continuation.inheritIntent &&
      continuation.inheritWorkflowType
    ) {
      return enrichIntentDecision(
        resolveForContinuation({
          message,
          continuation,
          candidate: {} as IntentDecision,
          candidateSource: "task_continuation",
          signals,
          boundary,
          taskContext: effectiveCtx,
          taskType: input.taskType,
        }),
        snapshot,
        legacy,
      );
    }

    if (aiDecision && aiDecision.confidence >= 0.6) {
      if (
        effectiveCtx &&
        !boundary.breaksContinuation &&
        shouldGuardrailOverrideAiClassifier({
          ctx: effectiveCtx,
          aiIntent: aiDecision.intent,
          aiIsContinuation: aiDecision.isContinuation === true,
          continuation,
        })
      ) {
        return enrichIntentDecision(
          resolveForContinuation({
            message,
            continuation: {
              ...continuation,
              kind: "inherit",
              inheritIntent: effectiveCtx.intent,
              inheritWorkflowType: effectiveCtx.workflowType,
              inheritedTaskId: effectiveCtx.taskId,
              reason: `AI 降级为 ${aiDecision.intent}，任务延续守卫继承活跃任务`,
            },
            candidate: aiDecision,
            candidateSource: "task_continuation",
            signals,
            boundary,
            taskContext: effectiveCtx,
            taskType: input.taskType,
          }),
          snapshot,
          legacy,
        );
      }

      const decision = resolveWorkflow({
        message,
        candidate: aiDecision,
        candidateSource: "ai_classifier",
        signals,
        boundary,
        taskContext: effectiveCtx,
        taskType: input.taskType,
      });
      return enrichIntentDecision(
        { ...decision, aiOverridden: decision.source === "intent_adjudicator" },
        snapshot,
        legacy,
      );
    }

    if (
      sessionId &&
      effectiveCtx?.isActive &&
      !boundary.breaksContinuation &&
      shouldInheritActiveTaskOnUncertain(effectiveCtx, legacy.legacyIntentHint ?? legacy.intent)
    ) {
      return enrichIntentDecision(
        resolveForContinuation({
          message,
          continuation: {
            kind: "inherit",
            score: continuation.score,
            reason: `活跃任务覆盖 legacy ${legacy.legacyIntentHint ?? legacy.intent}`,
            inheritIntent: effectiveCtx.intent,
            inheritWorkflowType: effectiveCtx.workflowType,
            inheritedTaskId: effectiveCtx.taskId,
            signals: continuation.signals,
          },
          candidate: legacy,
          candidateSource: "session_continuation",
          signals,
          boundary,
          taskContext: effectiveCtx,
          taskType: input.taskType,
        }),
        snapshot,
        legacy,
      );
    }

    return enrichIntentDecision(
      resolveWorkflow({
        message,
        candidate: legacy,
        candidateSource: "legacy_fallback",
        signals,
        boundary,
        taskContext: effectiveCtx,
        taskType: input.taskType,
      }),
      snapshot,
      legacy,
    );
  }
}
