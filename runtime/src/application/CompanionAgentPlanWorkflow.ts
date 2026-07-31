import { randomUUID } from "node:crypto";
import type {
  ModelInferenceOptions,
} from "@ariadne/protocol/public";

import type { LoopChatFn } from "../agent/AgentLoop.js";
import type { UserPermissionPolicy } from "../agent/RunPolicyTypes.js";
import type { AppContext } from "../app/createAppContext.js";
import type { ApiResult } from "../core/apiResult.js";
import type { CompanionMessage } from "../companion/CompanionSessionContracts.js";
import type { AgentModelTurnEvent } from "../agent/AgentModelTurn.js";
import type { AgentStreamEvent } from "../orchestrator/AgentStream.js";
import {
  renderAgentPlanClarification,
  type AgentPlanContract,
} from "../plan/AgentPlanContract.js";
import type { PlanHandoffPayload } from "../policy/planHandoffTypes.js";

export interface CompanionAgentPlanWorkflowCallbacks {
  onMessage(message: CompanionMessage): void;
  onPlanHandoff(handoff: PlanHandoffPayload): void;
  onRunChanged(runId: string): void;
}

export interface CompanionAgentPlanStartInput {
  sessionId: string;
  workspaceKey: string;
  message: string;
  userMessageId: string;
  clientName?: string;
  inference?: ModelInferenceOptions;
}

export interface CompanionAgentPlanRunOptions {
  sessionId: string;
  sourceMessageId: string;
  assistantMessageId: string;
  clientName?: string;
  inference?: ModelInferenceOptions;
}

export interface CompanionAgentPlanStart {
  started: Promise<{ runId: string; sessionId: string }>;
  completion: Promise<void>;
}

export interface CompanionAgentPlanTerminalState {
  status: "completed" | "failed" | "cancelled";
  processingDurationMs?: number;
}

interface PersistedReasoningSegment {
  segmentId: string;
  kind: "thought" | "intermediate_response";
  content: string;
  occurredAt: string;
  iteration?: number;
}

/**
 * Bridges the existing Agent plan runtime into Companion chat persistence.
 * Agent policy, plan generation, tool admission and resume behavior remain owned by Agent.
 */
export class CompanionAgentPlanWorkflow {
  private readonly runs = new Map<string, CompanionAgentPlanRunOptions>();
  private readonly hydratedSessions = new Set<string>();

  constructor(
    private readonly app: AppContext,
    private readonly callbacks: CompanionAgentPlanWorkflowCallbacks,
    private readonly executionPermissionPolicy: UserPermissionPolicy,
  ) {}

  start(input: CompanionAgentPlanStartInput): CompanionAgentPlanStart {
    const start = deferred<{ runId: string; sessionId: string }>();
    let startedRunId: string | undefined;
    const startedAtMs = Date.now();
    const previousPlan = this.app.agentPlanStore.getLatestForSession(input.sessionId);
    const completion = this.app.orchestrator.runAgentStream(
      {
        message: input.message,
        ...(previousPlan?.planState === "needs_clarification"
          ? { system: buildPlanClarificationContinuation(previousPlan) }
          : {}),
        mode: "plan",
        forceMode: true,
        // Plan capabilities remain read-only. Persist the desktop policy so an approved
        // handoff resumes in implement mode with the user's selected permission boundary.
        permissionPolicy: this.executionPermissionPolicy,
        autoConfirm: false,
        sessionId: input.sessionId,
        workspaceKey: input.workspaceKey,
        persist: true,
        skipPlanHandoff: false,
        streamTokens: false,
      },
      (event) => {
        try {
          if (event.type === "run_start") {
            startedRunId = event.runId;
            this.handleRunStart(event, input, startedAtMs);
            start.resolve({ runId: event.runId, sessionId: input.sessionId });
            return;
          }
          if (event.type === "model_turn") {
            if (startedRunId) this.handleModelTurn(startedRunId, event);
            return;
          }
          if (event.type === "done") {
            this.handleDone(event, startedAtMs);
            return;
          }
          if (event.type === "error") {
            const error = new Error(event.error);
            if (!startedRunId) {
              start.reject(error);
            } else {
              this.handleError(event, startedAtMs);
            }
          }
        } catch (error) {
          if (!startedRunId) start.reject(error);
          else this.handlePersistenceFailure(startedRunId, error, startedAtMs);
        }
      },
      this.createChat(input.clientName, input.inference),
    ).catch((error) => {
      if (!startedRunId) start.reject(error);
      else this.handlePersistenceFailure(startedRunId, error, startedAtMs);
      throw error;
    });
    return { started: start.promise, completion };
  }

  isPlanRun(runId: string, sessionId?: string): boolean {
    return this.optionsFor(runId, sessionId) !== undefined;
  }

  optionsFor(runId: string, sessionId?: string): CompanionAgentPlanRunOptions | undefined {
    const cached = this.runs.get(runId);
    if (cached) return cached;
    if (!sessionId) return undefined;
    this.hydrateSession(sessionId);
    return this.runs.get(runId);
  }

  sourceMessageId(runId: string, sessionId?: string): string | undefined {
    return this.optionsFor(runId, sessionId)?.sourceMessageId;
  }

  forgetSession(sessionId: string): void {
    this.hydratedSessions.delete(sessionId);
    for (const [runId, options] of this.runs) {
      if (options.sessionId === sessionId) this.runs.delete(runId);
    }
  }

  makeChatForRun(
    runId: string,
    sessionId: string | undefined,
    makeChat: (clientName?: string) => LoopChatFn,
  ): LoopChatFn {
    const options = this.optionsFor(runId, sessionId);
    const chat = makeChat(options?.clientName);
    if (!options?.inference) return chat;
    return (request, runtimeOptions) => chat(
      { ...request, inference: options.inference },
      runtimeOptions,
    );
  }

  recordModelTurn(
    runId: string,
    sessionId: string | undefined,
    turn: AgentModelTurnEvent,
  ): void {
    this.handleModelTurn(runId, { type: "model_turn", turn }, sessionId);
  }

  recordIntermediateResult(
    runId: string,
    sessionId: string | undefined,
    result: ApiResult,
    checkpointId: string,
  ): void {
    const options = this.optionsFor(runId, sessionId);
    const answer = extractAnswer(result.body);
    if (!options || !answer) return;
    const updated = this.appendReasoningSegment(runId, options, {
      segmentId: `${runId}:intermediate:${checkpointId}`,
      kind: "intermediate_response",
      content: answer,
      occurredAt: new Date().toISOString(),
    });
    if (updated) this.callbacks.onMessage(updated);
  }

  recordTerminalResult(
    runId: string,
    sessionId: string | undefined,
    result: ApiResult,
    terminal: CompanionAgentPlanTerminalState,
  ): void {
    const options = this.optionsFor(runId, sessionId);
    if (!options) return;
    const storage = this.app.companionService.storageManager.get();
    const current = storage.getMessage(options.assistantMessageId);
    if (!current || current.metadata?.planExecutionRecorded === true) return;
    const answer = extractAnswer(result.body);
    const succeeded = terminal.status === "completed"
      && result.status >= 200
      && result.status < 300
      && Boolean(answer);
    storage.finishMessageReasoning(
      current.id,
      succeeded ? "completed" : "interrupted",
    );
    const metadata = {
      ...current.metadata,
      planExecutionRecorded: true,
      ...(terminal.processingDurationMs !== undefined
        ? { processingDurationMs: Math.max(0, Math.round(terminal.processingDurationMs)) }
        : {}),
      ...(!succeeded
        ? {
            errorCode: terminal.status === "cancelled"
              ? "CANCELLED"
              : extractErrorCode(result.body) ?? "AGENT_PLAN_EXECUTION_FAILED",
          }
        : {}),
    };
    const updated = current.status === "streaming"
      ? storage.finalizeStreamingMessage(current.id, {
          content: answer ?? extractErrorMessage(result.body) ?? "",
          status: succeeded ? "completed" : "interrupted",
          clientName: current.clientName ?? options.clientName,
          modelName: current.modelName,
          metadata,
        })
      : storage.updateMessage(current.id, {
          content: answer ?? extractErrorMessage(result.body) ?? current.content,
          status: succeeded ? "completed" : "interrupted",
          metadata,
        });
    if (updated) this.callbacks.onMessage(updated);
  }

  private appendReasoningSegment(
    runId: string,
    options: CompanionAgentPlanRunOptions,
    segment: PersistedReasoningSegment,
  ): CompanionMessage | null {
    const storage = this.app.companionService.storageManager.get();
    const current = storage.getMessage(options.assistantMessageId);
    if (!current || current.status !== "streaming") return current;
    const segments = reasoningSegments(current.metadata);
    if (segments.some((candidate) => candidate.segmentId === segment.segmentId)) return current;
    const content = segment.content.trim().slice(0, 200_000);
    if (!content) return current;
    const normalized = { ...segment, content };
    const separator = current.reasoning?.content.trim() ? "\n\n" : "";
    const withReasoning = storage.appendMessageReasoning(
      current.id,
      `${separator}${content}`,
      "summary",
      segment.occurredAt,
    );
    if (!withReasoning) return null;
    return storage.updateMessage(withReasoning.id, {
      metadata: {
        ...withReasoning.metadata,
        reasoningSegments: [...segments, normalized],
        runId,
      },
    });
  }

  private handleRunStart(
    event: Extract<AgentStreamEvent, { type: "run_start" }>,
    input: CompanionAgentPlanStartInput,
    startedAtMs: number,
  ): void {
    const storage = this.app.companionService.storageManager.get();
    const userMessage = storage.createMessage({
      id: input.userMessageId,
      sessionId: input.sessionId,
      role: "user",
      content: input.message,
      status: "completed",
      metadata: {
        responseType: "agent_plan_request",
        agentMode: "plan",
      },
    });
    const assistantMessage = storage.createMessage({
      id: randomUUID(),
      sessionId: input.sessionId,
      role: "assistant",
      content: "",
      status: "streaming",
      clientName: input.clientName,
      metadata: {
        responseType: "agent_plan",
        agentMode: "plan",
        runId: event.runId,
        sourceMessageId: input.userMessageId,
        workspaceKey: input.workspaceKey,
        startedAtMs,
        ...(input.clientName ? { requestedClientName: input.clientName } : {}),
        ...(input.inference ? { inference: input.inference } : {}),
      },
    });
    this.runs.set(event.runId, {
      sessionId: input.sessionId,
      sourceMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
      ...(input.clientName ? { clientName: input.clientName } : {}),
      ...(input.inference ? { inference: input.inference } : {}),
    });
    this.callbacks.onMessage(userMessage);
    this.callbacks.onMessage(assistantMessage);
    this.callbacks.onRunChanged(event.runId);
  }

  private handleModelTurn(
    runId: string,
    event: Extract<AgentStreamEvent, { type: "model_turn" }>,
    sessionId?: string,
  ): void {
    if (event.turn.phase !== "completed") return;
    const options = this.optionsFor(runId, sessionId);
    if (!options) return;
    const storage = this.app.companionService.storageManager.get();
    let updated: CompanionMessage | null = storage.getMessage(options.assistantMessageId);
    const thought = event.turn.thought?.trim();
    if (thought) {
      updated = this.appendReasoningSegment(runId, options, {
        segmentId: `${runId}:model:${event.turn.iteration}:thought`,
        kind: "thought",
        content: thought,
        occurredAt: new Date().toISOString(),
        iteration: event.turn.iteration,
      });
    }
    if (updated && (event.turn.clientName || event.turn.modelName)) {
      updated = storage.updateMessage(updated.id, {
        ...(event.turn.clientName ? { clientName: event.turn.clientName } : {}),
        ...(event.turn.modelName ? { modelName: event.turn.modelName } : {}),
      });
    }
    if (updated) this.callbacks.onMessage(updated);
  }

  private handleDone(
    event: Extract<AgentStreamEvent, { type: "done" }>,
    startedAtMs: number,
  ): void {
    const options = this.runs.get(event.runId);
    if (!options) return;
    const storage = this.app.companionService.storageManager.get();
    const stopReason = event.executionMeta.stopReason;
    const planHandoff = event.planHandoff;
    const agentPlan = event.agentPlan;
    if (agentPlan?.planState === "needs_clarification") {
      storage.finishMessageReasoning(options.assistantMessageId, "completed");
      const current = storage.getMessage(options.assistantMessageId);
      const clarified = storage.finalizeStreamingMessage(options.assistantMessageId, {
        content: renderAgentPlanClarification(agentPlan),
        status: "completed",
        clientName: current?.clientName ?? options.clientName,
        modelName: current?.modelName,
        metadata: {
          ...current?.metadata,
          processingDurationMs: Math.max(0, Date.now() - startedAtMs),
          agentStopReason: stopReason,
          planId: agentPlan.planId,
          planVersion: agentPlan.version,
          planState: agentPlan.planState,
          planExecutionState: agentPlan.executionState,
          planCompleteness: agentPlan.completeness,
        },
      });
      if (clarified) this.callbacks.onMessage(clarified);
      this.callbacks.onRunChanged(event.runId);
      return;
    }
    const validPlanHandoff = stopReason === "awaiting_plan_handoff"
      && planHandoff?.runId === event.runId
      && agentPlan?.planState === "ready_for_confirmation"
      && Boolean(planHandoff.planMarkdown.trim());
    if (validPlanHandoff && planHandoff) {
      const updated = this.appendReasoningSegment(event.runId, options, {
        segmentId: `${event.runId}:plan:${planHandoff.id}`,
        kind: "intermediate_response",
        content: planHandoff.planMarkdown,
        occurredAt: new Date().toISOString(),
      });
      const withHandoff = updated
        ? storage.updateMessage(updated.id, {
            metadata: {
              ...updated.metadata,
              planHandoffId: planHandoff.id,
              agentStopReason: stopReason,
              planId: agentPlan?.planId,
              planVersion: agentPlan?.version,
              planState: agentPlan?.planState,
              planExecutionState: agentPlan?.executionState,
              planCompleteness: agentPlan?.completeness,
            },
          })
        : null;
      if (withHandoff) this.callbacks.onMessage(withHandoff);
      this.callbacks.onPlanHandoff(planHandoff);
      this.callbacks.onRunChanged(event.runId);
      return;
    }

    if (stopReason === "awaiting_permission" || stopReason === "budget_exhausted") {
      const intermediate = event.answer.trim();
      const updated = intermediate
        ? this.appendReasoningSegment(event.runId, options, {
            segmentId: `${event.runId}:pause:${stopReason}:${event.iterations}`,
            kind: "intermediate_response",
            content: intermediate,
            occurredAt: new Date().toISOString(),
            iteration: event.iterations,
          })
        : storage.getMessage(options.assistantMessageId);
      if (updated) this.callbacks.onMessage(updated);
      this.callbacks.onRunChanged(event.runId);
      return;
    }

    {
      storage.finishMessageReasoning(options.assistantMessageId, "interrupted");
      const current = storage.getMessage(options.assistantMessageId);
      const interrupted = storage.finalizeStreamingMessage(options.assistantMessageId, {
        content: event.answer.trim() || planFailureMessage(stopReason),
        status: "interrupted",
        clientName: current?.clientName ?? options.clientName,
        modelName: current?.modelName,
        metadata: {
          ...current?.metadata,
          processingDurationMs: Math.max(0, Date.now() - startedAtMs),
          errorCode: planFailureCode(stopReason),
          agentStopReason: stopReason,
        },
      });
      if (interrupted) this.callbacks.onMessage(interrupted);
      this.callbacks.onRunChanged(event.runId);
    }
  }

  private handleError(
    event: Extract<AgentStreamEvent, { type: "error" }>,
    startedAtMs: number,
  ): void {
    const options = this.runs.get(event.runId);
    if (!options) return;
    const storage = this.app.companionService.storageManager.get();
    storage.finishMessageReasoning(options.assistantMessageId, "interrupted");
    const current = storage.getMessage(options.assistantMessageId);
    const interrupted = storage.finalizeStreamingMessage(options.assistantMessageId, {
      content: current?.content ?? "",
      status: "interrupted",
      clientName: current?.clientName ?? options.clientName,
      modelName: current?.modelName,
      metadata: {
        ...current?.metadata,
        processingDurationMs: Math.max(0, Date.now() - startedAtMs),
        errorCode: event.code ?? "AGENT_PLAN_FAILED",
      },
    });
    if (interrupted) this.callbacks.onMessage(interrupted);
    this.callbacks.onRunChanged(event.runId);
  }

  private handlePersistenceFailure(runId: string, error: unknown, startedAtMs: number): void {
    this.handleError({
      type: "error",
      runId,
      taskId: "",
      code: "AGENT_PLAN_PRESENTATION_FAILED",
      error: error instanceof Error ? error.message : String(error),
    }, startedAtMs);
  }

  private createChat(
    clientName?: string,
    inference?: ModelInferenceOptions,
  ): LoopChatFn {
    const chat = this.app.makeChatFn(clientName);
    if (!inference) return chat;
    return (request, options) => chat({ ...request, inference }, options);
  }

  private hydrateSession(sessionId: string): void {
    if (this.hydratedSessions.has(sessionId)) return;
    this.hydratedSessions.add(sessionId);
    const result = this.app.companionService.listMessages({ sessionId, limit: 1_000 });
    for (const message of result?.messages ?? []) {
      if (message.role !== "assistant" || message.metadata?.agentMode !== "plan") continue;
      const runId = stringValue(message.metadata.runId);
      const sourceMessageId = stringValue(message.metadata.sourceMessageId);
      if (!runId || !sourceMessageId) continue;
      const inference = inferenceValue(message.metadata.inference);
      const clientName = stringValue(message.metadata.requestedClientName);
      this.runs.set(runId, {
        sessionId,
        sourceMessageId,
        assistantMessageId: message.id,
        ...(clientName ? { clientName } : {}),
        ...(inference ? { inference } : {}),
      });
    }
  }
}

function buildPlanClarificationContinuation(plan: AgentPlanContract): string {
  return [
    `当前会话存在尚待澄清的结构化计划 ${plan.planId} v${plan.version}。`,
    "如果本轮用户消息是在回答该计划的待确认决策，请基于它生成新版本，",
    `并在 final.plan 中原样填写 basePlanId=${JSON.stringify(plan.planId)}、baseVersion=${plan.version}。`,
    "不得覆盖旧版本，也不得静默改变目标或范围。",
    "如果本轮消息明显是一个无关的新任务，请省略 basePlanId/baseVersion，创建独立 Plan v1。",
    "以下是只读的上一版计划契约：",
    JSON.stringify(plan),
  ].join("\n");
}

function extractAnswer(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const answer = (body as Record<string, unknown>).answer;
  return typeof answer === "string" && answer.trim() ? answer.trim() : undefined;
}

function extractErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const error = (body as Record<string, unknown>).error;
  return typeof error === "string" && error.trim() ? error.trim().slice(0, 16_384) : undefined;
}

function extractErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const code = (body as Record<string, unknown>).code;
  return typeof code === "string" && code.trim() ? code.trim().slice(0, 128) : undefined;
}

function reasoningSegments(metadata: Record<string, unknown> | undefined): PersistedReasoningSegment[] {
  const value = metadata?.reasoningSegments;
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): PersistedReasoningSegment[] => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const record = candidate as Record<string, unknown>;
    const segmentId = stringValue(record.segmentId);
    const content = stringValue(record.content);
    const occurredAt = stringValue(record.occurredAt);
    const kind = record.kind;
    if (
      !segmentId
      || !content
      || !occurredAt
      || !Number.isFinite(Date.parse(occurredAt))
      || (kind !== "thought" && kind !== "intermediate_response")
    ) {
      return [];
    }
    const iteration = typeof record.iteration === "number"
      && Number.isInteger(record.iteration)
      && record.iteration >= 0
      ? record.iteration
      : undefined;
    return [{
      segmentId,
      kind,
      content,
      occurredAt,
      ...(iteration !== undefined ? { iteration } : {}),
    }];
  }).slice(-2_000);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function inferenceValue(value: unknown): ModelInferenceOptions | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as ModelInferenceOptions;
}

function planFailureCode(stopReason: string): string {
  if (stopReason === "budget_exhausted") return "AGENT_PLAN_BUDGET_EXHAUSTED";
  if (stopReason === "user_cancelled") return "CANCELLED";
  return "AGENT_PLAN_DID_NOT_HANDOFF";
}

function planFailureMessage(stopReason: string): string {
  if (stopReason === "budget_exhausted") {
    return "计划生成已暂停，等待追加执行预算。";
  }
  if (stopReason === "user_cancelled") return "计划生成已取消。";
  return "计划模式没有生成可确认的执行计划。";
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}
