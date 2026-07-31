import { createHash } from "node:crypto";

import type { ChatRequest, ModelResponse } from "../model/types.js";
import type { AgentProposal } from "../assistant/AgentHandoffContracts.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import { redactString } from "../util/redact.js";
import {
  createModelAbortError,
  isModelAbortError,
  throwIfModelAborted,
} from "../model/modelCancellation.js";
import type { RouteOptions } from "../model/routeOptions.js";
import { toPublicError } from "../util/publicError.js";
import {
  CompanionChatRequestSchema,
  CompanionChatResourceNotFoundError,
  CompanionChatResultSchema,
  type CompanionChatInput,
  type CompanionChatResult,
} from "./CompanionChatContracts.js";
import {
  CompanionKnowledgeService,
  combineCompanionVectorStatuses,
  companionModeMetadata,
  filterMessagesForMode,
  filterSummariesForMode,
  normalizeCompanionOutputMode,
  selectPromptSummaries,
} from "./CompanionKnowledgeService.js";
import { applyCompanionSafety, hasCompanionHardBoundaryRisk } from "./CompanionSafety.js";
import {
  CompanionRunCancelResultSchema,
  type CompanionRunCancelResult,
} from "./CompanionRunContracts.js";
import {
  CompanionStreamEventSequence,
  type CompanionStreamEvent,
} from "./CompanionStreamContracts.js";
import { CompanionSummaryStatusSchema } from "./CompanionSessionContracts.js";
import {
  CompanionAgentProposalDeliveryPendingError,
  type CompanionAgentProposalDelivery,
  type CompanionAgentProposalOutboxDispatcher,
} from "./CompanionAgentProposalOutboxDispatcher.js";
import { CompanionStorageManager } from "./CompanionStorageManager.js";
import { CompanionVectorIndex } from "./CompanionVectorIndex.js";
import { composeCompanionMessages } from "./PromptComposer.js";
import type { PersonaProfile } from "./PersonaRuntime.js";
import type {
  CompanionMessage,
  CompanionOutputMode,
} from "./types.js";
import {
  COMPANION_AGENT_PROPOSAL_CLOSE,
  COMPANION_AGENT_PROPOSAL_OPEN,
  COMPANION_AGENT_PROTOCOL_VERSION,
  CompanionEmptyResponseError,
  CompanionTurnProtocolError,
  CompanionTurnStreamDecoder,
  createCompanionAgentProposalTool,
  parseCompanionModelResponse,
  type CompanionModelTurn,
} from "./CompanionTurnProtocol.js";

const BOUNDED_STREAM_GUARD_TAIL_CHARS = 32;
const STREAMING_DRAFT_WRITE_INTERVAL_MS = 350;
const COMPANION_MAX_TOKENS = 4_096;
const AGENT_PROPOSAL_PUBLIC_CONTENT =
  "我已开始处理；需要额外权限时，系统会向你确认具体操作。";

type CompanionRepairRequest =
  | { kind: "proposal_protocol"; error: CompanionTurnProtocolError }
  | { kind: "empty_response" };

type CompanionStorageHandle = ReturnType<CompanionStorageManager["get"]>;

export interface CompanionConversationWorkflowDeps {
  storageManager: CompanionStorageManager;
  knowledge: CompanionKnowledgeService;
  directChat: (request: ChatRequest, opts?: RouteOptions) => Promise<ModelResponse>;
  agentProposalOutbox?: CompanionAgentProposalOutboxDispatcher;
  browserAvailable?: () => boolean;
  trace?: TraceLogger;
}

export interface CompanionConversationRunContext {
  signal?: AbortSignal;
}

interface PreparedCompanionTurn {
  input: CompanionChatInput;
  message: string;
  outputMode: CompanionOutputMode;
  storage: CompanionStorageHandle;
  session?: ReturnType<CompanionStorageHandle["createSession"]>;
  userMessage?: CompanionMessage;
  assistantDraft?: CompanionMessage;
  agentProposalEnabled: boolean;
  browserAvailable: boolean;
  request: ChatRequest;
  retrieved: Awaited<ReturnType<CompanionKnowledgeService["searchMemoryVectors"]>>;
}

/** Owns the normal and streaming Companion conversation state machine. */
export class CompanionConversationWorkflow {
  private readonly activeRuns = new Map<string, AbortController>();

  constructor(private readonly deps: CompanionConversationWorkflowDeps) {}

  async chat(input: CompanionChatInput): Promise<CompanionChatResult> {
    const operationId = crypto.randomUUID();
    let turn: PreparedCompanionTurn | undefined;
    try {
      turn = await this.prepareTurn(input, false);
      this.logTurnInput(turn, operationId, false);
      const initialResponse = await this.deps.directChat(turn.request, this.routeOptions(input));
      const resolved = await this.parseOrRepairModelTurn(turn, initialResponse, undefined, operationId);
      const { response, modelTurn } = resolved;
      const safety = applyCompanionSafety({
        userText: turn.message,
        assistantText: modelTurnContent(modelTurn),
        outputMode: turn.outputMode,
      });
      const proposalDelivery = await this.deliverProposal(turn, modelTurn, safety, response);
      const result = await this.completeTurn(turn, response, safety, proposalDelivery);
      this.logTurnCompleted(turn, operationId, modelTurn, response);
      return result;
    } catch (error) {
      this.logTurnFailure(turn, operationId, error);
      throw error;
    }
  }

  async chatStream(
    input: CompanionChatInput,
    emit: (event: CompanionStreamEvent) => void,
    context: CompanionConversationRunContext = {},
  ): Promise<void> {
    const runId = crypto.randomUUID();
    let runStartedAtMs = Date.now();
    const controller = new AbortController();
    const events = new CompanionStreamEventSequence(emit);
    const abortFromContext = (): void =>
      controller.abort(createModelAbortError(context.signal?.reason));
    if (context.signal?.aborted) abortFromContext();
    else context.signal?.addEventListener("abort", abortFromContext, { once: true });
    this.activeRuns.set(runId, controller);
    let turn: PreparedCompanionTurn;
    try {
      turn = await this.prepareTurn(input, true, controller.signal);
      this.logTurnInput(turn, runId, true);
    } catch (error) {
      this.logTurnFailure(undefined, runId, error, input.message);
      this.activeRuns.delete(runId);
      context.signal?.removeEventListener("abort", abortFromContext);
      throw error;
    }
    let relay: ReturnType<typeof createCompanionStreamRelay>;
    let protocol: CompanionTurnStreamDecoder;
    try {
      if (turn.session && (!turn.userMessage || !turn.assistantDraft)) {
        throw new Error("companion_stream_missing_persisted_messages");
      }
      relay = createCompanionStreamRelay({
        runId,
        userText: turn.message,
        outputMode: turn.outputMode,
        emit: (event) => events.send(event),
        storage: turn.storage,
        assistantDraft: turn.assistantDraft,
      });
      protocol = new CompanionTurnStreamDecoder({
        protocolEnabled: turn.outputMode === "bounded",
        agentProposalEnabled: turn.agentProposalEnabled,
        onMessageToken: (delta) => relay.onToken(delta),
      });
    } catch (error) {
      this.activeRuns.delete(runId);
      context.signal?.removeEventListener("abort", abortFromContext);
      throw error;
    }

    try {
      runStartedAtMs = Date.now();
      const storage = turn.storage.status();
      if (turn.session && turn.userMessage && turn.assistantDraft) {
        events.send({
          type: "run_start",
          runId,
          persistence: "stored",
          outputMode: turn.outputMode,
          session: turn.session,
          userMessage: turn.userMessage,
          assistantMessage: turn.assistantDraft,
          storage,
        });
      } else {
        events.send({
          type: "run_start",
          runId,
          persistence: "incognito",
          outputMode: turn.outputMode,
          storage,
        });
      }
      throwIfModelAborted(controller.signal);
      const initialResponse = await this.deps.directChat(
        {
          ...turn.request,
          signal: controller.signal,
          onToken: (delta) => {
            throwIfModelAborted(controller.signal);
            protocol.push(delta);
          },
          onReasoningToken: (delta) => {
            throwIfModelAborted(controller.signal);
            relay.onReasoningToken(delta);
          },
        },
        this.routeOptions(input),
      );
      throwIfModelAborted(controller.signal);
      const resolved = await this.parseOrRepairModelTurn(
        turn,
        initialResponse,
        controller.signal,
        runId,
        () => protocol.finish(initialResponse),
      );
      const { response, modelTurn } = resolved;
      const safety = applyCompanionSafety({
        userText: turn.message,
        assistantText: modelTurnContent(modelTurn),
        outputMode: turn.outputMode,
      });
      const publicContent = safety.content;
      relay.finish(publicContent);
      const proposalDelivery = await this.deliverProposal(turn, modelTurn, safety, response);
      this.activeRuns.delete(runId);
      context.signal?.removeEventListener("abort", abortFromContext);
      const result = await this.completeTurn(
        turn,
        response,
        safety,
        proposalDelivery,
        { runId, startedAtMs: runStartedAtMs, emit: (event) => events.send(event) },
      );
      if (proposalDelivery) {
        events.send({
          type: "agent_proposal",
          runId,
          proposal: proposalDelivery.proposal,
          content: publicContent,
          ...(proposalDelivery.sessionReadGrant
            ? { sessionReadGrant: proposalDelivery.sessionReadGrant }
            : {}),
          ...(proposalDelivery.companionPresentation
            ? { companionPresentation: proposalDelivery.companionPresentation }
            : {}),
        });
      }
      this.logTurnCompleted(turn, runId, modelTurn, response);
      events.send({ type: "done", runId, result });
    } catch (error) {
      if (events.hasTerminated) throw error;
      if (error instanceof CompanionAgentProposalDeliveryPendingError) {
        this.deps.trace?.write({
          type: "companion.proposal.delivery.warning",
          level: "warning",
          category: "companion.proposal.delivery",
          message: error.message,
          runId,
          ...(turn.session ? { sessionId: turn.session.id } : {}),
          metadata: {
            lifecycleStage: "proposal_delivery",
            errorCode: error.code,
            retryable: true,
            idempotencyProtected: true,
          },
        });
        events.send({
          type: "error",
          runId,
          code: error.code,
          message: error.message,
          retryable: true,
        });
        return;
      }
      const cancelled = isModelAbortError(error, controller.signal);
      const publicError = cancelled
        ? { code: "CANCELLED", message: "生成已停止" }
        : toPublicError(error, "Companion 流式请求失败");
      const partialSafety = applyCompanionSafety({
        userText: turn.message,
        assistantText: protocol.publicPartial,
        outputMode: turn.outputMode,
      });
      relay.finish(partialSafety.content, "interrupted");
      let interruptedMessage: CompanionMessage | null | undefined;
      if (turn.assistantDraft) {
        interruptedMessage = turn.storage.finalizeStreamingMessage(turn.assistantDraft.id, {
          content: partialSafety.content,
          status: "interrupted",
          metadata: {
            ...(cancelled
              ? { interruptionCode: "cancelled" }
                : {
                  errorCode: publicError.code,
                  interruptionCode: "runtime_error",
                  ...(error instanceof CompanionTurnProtocolError
                    ? { protocolDiagnostic: error.diagnostic }
                    : {}),
                }),
            safety: partialSafety,
            interruptedRawLength: protocol.rawText.length,
            ...companionModeMetadata(turn.outputMode),
          },
        });
      }
      if (cancelled) {
        if (turn.session && turn.assistantDraft) {
          events.send({
            type: "cancelled",
            runId,
            persistence: "stored",
            code: "CANCELLED",
            messageId: interruptedMessage?.id ?? turn.assistantDraft.id,
            content: interruptedMessage?.content ?? partialSafety.content,
            storage: turn.storage.status(),
          });
        } else {
          events.send({
            type: "cancelled",
            runId,
            persistence: "incognito",
            code: "CANCELLED",
            messageId: null,
            content: partialSafety.content,
            storage: turn.storage.status(),
          });
        }
      } else {
        this.logTurnFailure(turn, runId, error);
        events.send({
          type: "error",
          runId,
          code: publicError.code,
          message: publicError.message,
          retryable: errorRetryable(error),
        });
      }
    } finally {
      this.activeRuns.delete(runId);
      context.signal?.removeEventListener("abort", abortFromContext);
    }
  }

  cancelRun(runId: string): CompanionRunCancelResult {
    const controller = this.activeRuns.get(runId);
    if (!controller || controller.signal.aborted) {
      return CompanionRunCancelResultSchema.parse({ runId, cancelled: false });
    }
    controller.abort(createModelAbortError(new Error("用户停止生成")));
    return CompanionRunCancelResultSchema.parse({ runId, cancelled: true });
  }

  close(): void {
    for (const controller of this.activeRuns.values()) {
      controller.abort(createModelAbortError("服务正在关闭"));
    }
    this.activeRuns.clear();
  }

  private async prepareTurn(
    rawInput: CompanionChatInput,
    streaming: boolean,
    signal?: AbortSignal,
  ): Promise<PreparedCompanionTurn> {
    const input = CompanionChatRequestSchema.parse(rawInput);
    throwIfModelAborted(signal);
    const message = input.message;
    const storage = this.deps.storageManager.get(input.storageRoot);
    const outputMode = normalizeCompanionOutputMode(input.outputMode);
    const requestedSession = input.sessionId
      ? storage.getSession(input.sessionId)
      : undefined;
    if (input.sessionId && !requestedSession) {
      throw new CompanionChatResourceNotFoundError("session", input.sessionId);
    }
    const persona = this.resolvePersona(
      storage,
      input.personaId ?? requestedSession?.personaId,
    );
    const persistent = input.incognito !== true;
    this.deps.knowledge.migrateLegacyUnrestrictedMemories(input.storageRoot);
    let retrieved: PreparedCompanionTurn["retrieved"];
    if (persistent) {
      retrieved = await this.deps.knowledge.searchMemoryVectors(input.storageRoot, {
        query: message,
        outputMode,
        topK: 6,
      });
    } else {
      const primary = new CompanionVectorIndex(storage).status(0);
      if (outputMode === "unrestricted") {
        const unrestrictedStorage = this.deps.storageManager.getUnrestrictedMemory(input.storageRoot);
        const unrestrictedMemory = new CompanionVectorIndex(unrestrictedStorage).status(0);
        retrieved = {
          outputMode: "unrestricted",
          memories: [],
          summaries: [],
          matches: [],
          status: combineCompanionVectorStatuses(primary, unrestrictedMemory, 0),
          vectors: { primary, unrestrictedMemory },
        };
      } else {
        retrieved = {
          outputMode: "bounded",
          memories: [],
          summaries: [],
          matches: [],
          status: primary,
          vectors: { primary },
        };
      }
    }
    throwIfModelAborted(signal);
    const session = persistent
      ? requestedSession
        ? requestedSession
        : storage.createSession({
            personaId: persona.id,
            title: outputMode === "unrestricted"
              ? "原始输出会话"
              : message.slice(0, 40) || "纯聊天会话",
          })
      : undefined;
    const userMessage = session
      ? storage.createMessage({
          ...(input.userMessageId ? { id: input.userMessageId } : {}),
          sessionId: session.id,
          role: "user",
          content: message,
          memoryEligible: false,
          metadata: companionModeMetadata(outputMode),
        })
      : undefined;
    const assistantDraft = streaming && session
      ? storage.createMessage({
          sessionId: session.id,
          role: "assistant",
          content: "",
          status: "streaming",
          memoryEligible: false,
          metadata: companionModeMetadata(outputMode),
        })
      : undefined;
    const agentProposalEnabled = Boolean(
      session
      && outputMode === "bounded"
      && this.deps.agentProposalOutbox,
    );
    const browserAvailable = this.deps.browserAvailable?.() === true;
    const recent = session ? storage.listMessages(session.id, 30) : [];
    const summaries = session
      ? selectPromptSummaries({
          sessionId: session.id,
          recentMessages: recent,
          stored: filterSummariesForMode(storage.listSummaries(session.id, 24), outputMode),
          retrieved: retrieved.summaries,
        })
      : [];
    const request: ChatRequest = {
      messages: composeCompanionMessages({
        persona,
        currentUserMessage: message,
        recentMessages: filterMessagesForMode(
          recent.filter((item) =>
            item.id !== userMessage?.id && item.id !== assistantDraft?.id),
          outputMode,
        ),
        summaries,
        memories: retrieved.memories,
        outputMode,
        agentProposalEnabled,
        browserAvailable,
      }),
      ...(agentProposalEnabled
        ? { tools: [createCompanionAgentProposalTool(browserAvailable)] }
        : {}),
      temperature: 0.7,
      maxTokens: COMPANION_MAX_TOKENS,
      ...(input.inference ? { inference: input.inference } : {}),
    };
    return {
      input,
      message,
      outputMode,
      storage,
      session,
      userMessage,
      assistantDraft,
      agentProposalEnabled,
      browserAvailable,
      request,
      retrieved,
    };
  }

  private async completeTurn(
    turn: PreparedCompanionTurn,
    response: ModelResponse,
    safety: ReturnType<typeof applyCompanionSafety>,
    proposalDelivery?: CompanionAgentProposalDelivery,
    streamActivity?: {
      runId: string;
      startedAtMs: number;
      emit: (event: unknown) => void;
    },
  ): Promise<CompanionChatResult> {
    const proposal = proposalDelivery?.proposal;
    const publicContent = proposalDelivery?.assistantMessage.content ?? safety.content;
    let completedReasoning = turn.assistantDraft
      ? turn.storage.getMessage(turn.assistantDraft.id)?.reasoning
      : undefined;
    if (response.reasoningContent && !completedReasoning) {
      const completedAt = new Date().toISOString();
      const durationMs = Math.max(0, Math.round(response.latencyMs));
      const startedAt = new Date(
        new Date(completedAt).getTime() - durationMs,
      ).toISOString();
      if (turn.assistantDraft) {
        turn.storage.appendMessageReasoning(
          turn.assistantDraft.id,
          response.reasoningContent,
          "provider",
          startedAt,
        );
        completedReasoning = turn.storage.finishMessageReasoning(
          turn.assistantDraft.id,
          "completed",
          completedAt,
        )?.reasoning;
      } else {
        completedReasoning = {
          content: response.reasoningContent,
          status: "completed",
          source: "provider",
          startedAt,
          completedAt,
          durationMs,
        };
      }
    }
    let assistantMessage = proposalDelivery?.assistantMessage ?? (turn.session
      ? turn.assistantDraft
        ? turn.storage.finalizeStreamingMessage(turn.assistantDraft.id, {
            content: publicContent,
            status: "completed",
            modelName: response.modelName,
            clientName: response.clientName,
            metadata: {
              latencyMs: response.latencyMs,
              usage: response.usage,
              safety,
              responseType: proposal ? "agent_proposal" : "message",
              ...(streamActivity ? { companionRunId: streamActivity.runId } : {}),
              ...(proposal ? { agentProposalId: proposal.id } : {}),
              ...companionModeMetadata(turn.outputMode),
            },
          })
        : turn.storage.createMessage({
            sessionId: turn.session.id,
            role: "assistant",
            content: publicContent,
            modelName: response.modelName,
            clientName: response.clientName,
            ...(completedReasoning ? { reasoning: completedReasoning } : {}),
            metadata: {
              latencyMs: response.latencyMs,
              usage: response.usage,
              safety,
              responseType: proposal ? "agent_proposal" : "message",
              ...(streamActivity ? { companionRunId: streamActivity.runId } : {}),
              ...(proposal ? { agentProposalId: proposal.id } : {}),
              ...companionModeMetadata(turn.outputMode),
            },
          })
      : undefined);

    if (turn.session && turn.userMessage && !proposal) {
      await this.deps.knowledge.extractAndIndexUserMemory({
        storageRoot: turn.input.storageRoot,
        outputMode: turn.outputMode,
        message: turn.message,
        sessionId: turn.session.id,
        sourceMessageId: turn.userMessage.id,
      });
    }
    const summaryStatus = turn.session
      ? await this.deps.knowledge.summarizeSession({
          storage: turn.storage,
          sessionId: turn.session.id,
          modelName: response.modelName,
          outputMode: turn.outputMode,
          ...(streamActivity
            ? {
                lifecycle: createCompanionCompressionLifecycle(streamActivity),
              }
            : {}),
        })
      : CompanionSummaryStatusSchema.parse({
          generated: false,
          reason: "incognito",
        });
    if (assistantMessage && streamActivity) {
      assistantMessage = turn.storage.updateMessage(assistantMessage.id, {
        metadata: {
          ...assistantMessage.metadata,
          companionRunId: streamActivity.runId,
          processingDurationMs: Math.max(0, Date.now() - streamActivity.startedAtMs),
        },
      }) ?? assistantMessage;
    }
    const common = {
      content: publicContent,
      storage: turn.storage.status(),
      safety,
      summaryStatus,
      vector: turn.retrieved.status,
      retrieval: {
        memoryCount: turn.retrieved.memories.length,
        summaryCount: turn.retrieved.summaries.length,
      },
      response: proposal
        ? {
            type: "agent_proposal" as const,
            proposal,
            ...(proposalDelivery?.sessionReadGrant
              ? { sessionReadGrant: proposalDelivery.sessionReadGrant }
              : {}),
            ...(proposalDelivery?.companionPresentation
              ? { companionPresentation: proposalDelivery.companionPresentation }
              : {}),
          }
        : { type: "message" as const },
    };
    if (!turn.session) {
      return CompanionChatResultSchema.parse({
        persistence: "incognito",
        ...common,
      });
    }
    if (!turn.userMessage || !assistantMessage) {
      throw new Error("companion_stored_chat_missing_persisted_messages");
    }
    return CompanionChatResultSchema.parse({
      persistence: "stored",
      ...common,
      session: turn.storage.getSession(turn.session.id) ?? turn.session,
      userMessage: turn.userMessage,
      assistantMessage,
    });
  }

  private resolvePersona(
    storage: CompanionStorageHandle,
    personaId?: string,
  ): PersonaProfile {
    const resolvedId = personaId ?? "default";
    const stored = storage.getPersona(resolvedId);
    if (!stored?.active) {
      throw new CompanionChatResourceNotFoundError("persona", resolvedId);
    }
    return { id: stored.id, name: stored.name, systemPrompt: stored.systemPrompt };
  }

  private async deliverProposal(
    turn: PreparedCompanionTurn,
    modelTurn: CompanionModelTurn,
    safety: ReturnType<typeof applyCompanionSafety>,
    response: ModelResponse,
  ): Promise<CompanionAgentProposalDelivery | undefined> {
    if (modelTurn.kind !== "agent_proposal") return undefined;
    if (
      !turn.agentProposalEnabled
      || !this.deps.agentProposalOutbox
      || !turn.session
      || !turn.userMessage
    ) {
      throw new Error("companion_agent_proposal_source_turn_unavailable");
    }
    const publicContent = safety.content;
    const requestedClientName =
      turn.input.clientName && turn.input.clientName !== "__default__"
        ? turn.input.clientName
        : undefined;
    const outbox = turn.storage.enqueueAgentProposalOutbox({
      payload: {
        sourceTurnId: turn.userMessage.id,
        companionSessionId: turn.session.id,
        originalRequest: turn.message,
        workspaceKey: turn.input.workspaceKey,
        draft: { ...modelTurn.draft, reason: publicContent },
        source: {
          protocolVersion: COMPANION_AGENT_PROTOCOL_VERSION,
          transport: modelTurn.transport,
          selectionMode: requestedClientName ? "manual" : "automatic",
          ...(requestedClientName ? { requestedClientName } : {}),
          clientName: response.clientName,
          modelName: response.modelName,
          responseHash: modelResponseHash(response),
        },
      },
      assistantMessageId: turn.assistantDraft?.id,
      content: publicContent,
      modelName: response.modelName,
      clientName: response.clientName,
      metadata: {
        latencyMs: response.latencyMs,
        usage: response.usage,
        safety,
        ...companionModeMetadata(turn.outputMode),
      },
    });
    return this.deps.agentProposalOutbox.dispatch(turn.storage, outbox.id);
  }

  private routeOptions(input: CompanionChatInput): RouteOptions {
    return {
      forceClient:
        input.clientName && input.clientName !== "__default__"
          ? input.clientName
          : undefined,
      strategy: input.routingStrategy,
      taskType: "simple",
    };
  }

  private async parseOrRepairModelTurn(
    turn: PreparedCompanionTurn,
    response: ModelResponse,
    signal?: AbortSignal,
    runId?: string,
    initialParser?: () => CompanionModelTurn,
  ): Promise<{ response: ModelResponse; modelTurn: CompanionModelTurn }> {
    try {
      const modelTurn = initialParser
        ? initialParser()
        : parseCompanionModelResponse(response, {
            protocolEnabled: turn.outputMode === "bounded",
            agentProposalEnabled: turn.agentProposalEnabled,
          });
      this.logProposalNormalization(turn, runId, response, modelTurn, "initial");
      return {
        response,
        modelTurn,
      };
    } catch (error) {
      const idempotencyProtected = Boolean(turn.userMessage?.id);
      const repair = modelTurnRepairRequest(error, response, idempotencyProtected);
      if (!repair) {
        if (error instanceof CompanionTurnProtocolError) {
          this.logProposalProtocol(
            turn,
            runId,
            response,
            error,
            "error",
            "initial",
          );
        }
        throw error;
      }
      if (repair.kind === "proposal_protocol") {
        this.logProposalProtocol(
          turn,
          runId,
          response,
          repair.error,
          "warning",
          "initial",
        );
      }
      return this.repairModelTurn(turn, response, repair, signal, runId);
    }
  }

  private async repairModelTurn(
    turn: PreparedCompanionTurn,
    previousResponse: ModelResponse,
    repair: CompanionRepairRequest,
    signal?: AbortSignal,
    runId?: string,
  ): Promise<{ response: ModelResponse; modelTurn: CompanionModelTurn }> {
    const previousAssistantMessage = repair.kind === "empty_response"
      && (previousResponse.content || previousResponse.reasoningContent)
      ? [{
          role: "assistant" as const,
          content: previousResponse.content,
          ...(previousResponse.reasoningContent
          ? { reasoningContent: previousResponse.reasoningContent }
          : {}),
        }]
      : [];
    const repairInstruction = repair.kind === "proposal_protocol"
      ? [
          `上一条 Agent 能力请求未通过协议校验：${repair.error.diagnostic.issue}。`,
          `请重新生成本轮响应并优先调用 ${createCompanionAgentProposalTool(turn.browserAvailable).name}；工具参数必须严格符合其 JSON Schema，且不要同时输出普通文本。`,
          `如果当前模型不支持工具调用，才输出一个完整严格的 ${COMPANION_AGENT_PROPOSAL_OPEN} JSON ${COMPANION_AGENT_PROPOSAL_CLOSE} 信封；信封前后不得添加文字。`,
        ]
      : [
          previousResponse.reasoningContent
            ? "上一条响应只产生了内部推理，没有生成可展示的最终内容。"
            : "上一条响应没有生成任何可展示内容。",
          "现在直接输出本轮最终响应：需要现实操作时只输出一个完整严格的 Agent 提案信封；否则输出非空的普通自然语言。",
          "不要重述内部推理，不要输出空白响应。",
        ];
    const response = await this.deps.directChat({
      ...turn.request,
      messages: [
        ...turn.request.messages,
        ...previousAssistantMessage,
        {
          role: "system",
          content: repairInstruction.join("\n"),
        },
      ],
      maxTokens: COMPANION_MAX_TOKENS,
      temperature: repair.kind === "proposal_protocol" ? 0 : turn.request.temperature,
      ...(signal ? { signal } : {}),
    }, this.routeOptions(turn.input));
    try {
      const modelTurn = parseCompanionModelResponse(response, {
        protocolEnabled: turn.outputMode === "bounded",
        agentProposalEnabled: turn.agentProposalEnabled,
      });
      this.logProposalNormalization(turn, runId, response, modelTurn, "repair");
      return { response, modelTurn };
    } catch (error) {
      if (error instanceof CompanionTurnProtocolError) {
        this.logProposalProtocol(
          turn,
          runId,
          response,
          error,
          "error",
          "repair",
        );
      }
      throw error;
    }
  }

  private logTurnInput(
    turn: PreparedCompanionTurn,
    runId: string,
    streaming: boolean,
  ): void {
    this.deps.trace?.write({
      type: "companion.turn.input",
      level: "info",
      category: "companion.turn.input",
      message: `收到 Companion 输入：${safeLogPreview(turn.message, 320)}`,
      runId,
      ...(turn.session ? { sessionId: turn.session.id } : {}),
      metadata: {
        streaming,
        outputMode: turn.outputMode,
        persistent: Boolean(turn.session),
        inputChars: turn.message.length,
        inputPreview: safeLogPreview(turn.message, 512),
        agentProposalEnabled: turn.agentProposalEnabled,
        browserAvailable: turn.browserAvailable,
        requestedToolCount: turn.request.tools?.length ?? 0,
        modelSelectionMode:
          turn.input.clientName && turn.input.clientName !== "__default__"
            ? "manual"
            : "automatic",
        requestedClientName:
          turn.input.clientName && turn.input.clientName !== "__default__"
            ? turn.input.clientName
            : null,
        routingStrategy: turn.input.routingStrategy ?? null,
      },
    });
  }

  private logTurnCompleted(
    turn: PreparedCompanionTurn,
    runId: string,
    modelTurn: CompanionModelTurn,
    response: ModelResponse,
  ): void {
    this.deps.trace?.write({
      type: "companion.turn.completed",
      level: "info",
      category: "companion.turn.completed",
      message: modelTurn.kind === "agent_proposal"
        ? `Agent 授权提案已创建（${modelTurn.transport}）`
        : "Companion 回复已完成",
      runId,
      ...(turn.session ? { sessionId: turn.session.id } : {}),
      metadata: {
        responseType: modelTurn.kind,
        ...(modelTurn.kind === "agent_proposal"
          ? { proposalTransport: modelTurn.transport }
          : {}),
        clientName: response.clientName,
        modelName: response.modelName,
        latencyMs: Math.max(0, Math.round(response.latencyMs)),
        outputChars: response.content.length,
        toolCallCount: response.toolCalls.length,
      },
    });
  }

  private logTurnFailure(
    turn: PreparedCompanionTurn | undefined,
    runId: string,
    error: unknown,
    fallbackInput?: string,
  ): void {
    const publicError = toPublicError(error, "Companion 请求失败");
    this.deps.trace?.write({
      type: "companion.turn.error",
      level: "error",
      category: "companion.turn.error",
      message: `${publicError.code}: ${publicError.message}`,
      runId,
      ...(turn?.session ? { sessionId: turn.session.id } : {}),
      metadata: {
        errorCode: publicError.code,
        retryable: errorRetryable(error),
        inputChars: turn?.message.length ?? fallbackInput?.length ?? 0,
        inputPreview: safeLogPreview(turn?.message ?? fallbackInput ?? "", 512),
        ...(error instanceof CompanionTurnProtocolError
          ? { protocol: error.diagnostic }
          : {}),
      },
    });
  }

  private logProposalProtocol(
    turn: PreparedCompanionTurn,
    runId: string | undefined,
    response: ModelResponse,
    error: CompanionTurnProtocolError,
    level: "warning" | "error",
    attempt: "initial" | "repair",
  ): void {
    this.deps.trace?.write({
      type: level === "error"
        ? "companion.proposal.protocol.error"
        : "companion.proposal.protocol.warning",
      level,
      category: "companion.proposal.protocol",
      message: `${
        level === "warning"
          ? "Agent 提案协议校验失败，正在自动重试"
          : attempt === "repair"
            ? "Agent 提案自动修复后仍无效"
            : "Agent 提案校验失败且不可自动重试"
      }：${error.message}`,
      ...(runId ? { runId } : {}),
      ...(turn.session ? { sessionId: turn.session.id } : {}),
      metadata: {
        attempt,
        idempotencyProtected: Boolean(turn.userMessage?.id),
        diagnostic: error.diagnostic,
        clientName: response.clientName,
        modelName: response.modelName,
        modelVersion: response.modelName,
        protocolVersion: COMPANION_AGENT_PROTOCOL_VERSION,
        lifecycleStage: error.diagnostic.stage,
        fieldPaths: error.diagnostic.schemaIssues?.map((issue) => issue.path) ?? [],
        responseHash: modelResponseHash(response),
        responseChars: response.content.length,
        responsePreview: safeLogPreview(response.content, 1_024),
        toolArgumentsPreview: safeLogPreview(
          safeJsonStringify(response.toolCalls.map((call) => ({
            name: call.name,
            arguments: call.arguments,
          }))),
          1_024,
        ),
        toolCallCount: response.toolCalls.length,
        toolNames: response.toolCalls.map((call) => call.name).slice(0, 8),
      },
    });
  }

  private logProposalNormalization(
    turn: PreparedCompanionTurn,
    runId: string | undefined,
    response: ModelResponse,
    modelTurn: CompanionModelTurn,
    attempt: "initial" | "repair",
  ): void {
    if (modelTurn.kind !== "agent_proposal" || !response.content.trim()) return;
    this.deps.trace?.write({
      type: "companion.proposal.protocol.normalized",
      level: "warning",
      category: "companion.proposal.protocol",
      message: "原生 Agent 提案附带了普通回复文本；已丢弃文本并继续校验结构化工具参数",
      ...(runId ? { runId } : {}),
      ...(turn.session ? { sessionId: turn.session.id } : {}),
      metadata: {
        attempt,
        normalization: "discarded_text_with_tool_call",
        idempotencyProtected: Boolean(turn.userMessage?.id),
        clientName: response.clientName,
        modelName: response.modelName,
        modelVersion: response.modelName,
        protocolVersion: COMPANION_AGENT_PROTOCOL_VERSION,
        lifecycleStage: "protocol_parse",
        fieldPaths: [],
        responseHash: modelResponseHash(response),
        responseChars: response.content.length,
        responsePreview: safeLogPreview(response.content, 1_024),
        toolArgumentsPreview: safeLogPreview(
          safeJsonStringify(response.toolCalls.map((call) => ({
            name: call.name,
            arguments: call.arguments,
          }))),
          1_024,
        ),
        toolCallCount: response.toolCalls.length,
        toolNames: response.toolCalls.map((call) => call.name).slice(0, 8),
      },
    });
  }
}

function createCompanionCompressionLifecycle(input: {
  runId: string;
  emit: (event: unknown) => void;
}) {
  const activityId = `compaction_${crypto.randomUUID()}`;
  let startedAt: string | undefined;
  return {
    onStarted(stats: {
      processedMessages: number;
      beforeChars: number;
      summaryType: string;
    }) {
      startedAt = new Date().toISOString();
      input.emit({
        type: "context_activity",
        runId: input.runId,
        activityId,
        status: "running",
        title: "正在自动压缩上下文",
        startedAt,
        ...stats,
      });
    },
    onCompleted(stats: {
      processedMessages: number;
      beforeChars: number;
      afterChars: number;
      summaryType: string;
    }) {
      if (!startedAt) return;
      const completedAt = new Date().toISOString();
      input.emit({
        type: "context_activity",
        runId: input.runId,
        activityId,
        status: "completed",
        title: "已自动压缩上下文",
        startedAt,
        completedAt,
        durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
        ...stats,
      });
    },
    onFailed(error: unknown) {
      if (!startedAt) return;
      const completedAt = new Date().toISOString();
      input.emit({
        type: "context_activity",
        runId: input.runId,
        activityId,
        status: "failed",
        title: "自动压缩上下文失败",
        startedAt,
        completedAt,
        durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
        error: error instanceof Error ? error.message : String(error),
      });
    },
  };
}

function modelTurnContent(turn: CompanionModelTurn): string {
  return turn.kind === "message" ? turn.content : AGENT_PROPOSAL_PUBLIC_CONTENT;
}

function modelTurnRepairRequest(
  error: unknown,
  response: ModelResponse,
  idempotencyProtected: boolean,
): CompanionRepairRequest | undefined {
  if (
    error instanceof CompanionTurnProtocolError
    && error.retryable
    && idempotencyProtected
  ) {
    return { kind: "proposal_protocol", error };
  }
  if (
    error instanceof CompanionEmptyResponseError
    && idempotencyProtected
    && !response.content.trim()
    && response.toolCalls.length === 0
  ) {
    return { kind: "empty_response" };
  }
  return undefined;
}

function safeLogPreview(value: string, maxLength: number): string {
  const normalized = redactString(value).replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function modelResponseHash(response: ModelResponse): string {
  return createHash("sha256")
    .update(safeJsonStringify({
      content: response.content,
      toolCalls: response.toolCalls.map((call) => ({
        name: call.name,
        arguments: call.arguments,
      })),
    }), "utf8")
    .digest("hex");
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function errorRetryable(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "retryable" in error
    && (error as { retryable?: unknown }).retryable === true,
  );
}

function createCompanionStreamRelay(input: {
  runId: string;
  userText: string;
  outputMode: CompanionOutputMode;
  emit: (event: unknown) => void;
  storage: CompanionStorageHandle;
  assistantDraft?: CompanionMessage;
}) {
  let raw = "";
  let emitted = "";
  let guardHeld = false;
  let guardNoticeEmitted = false;
  let lastDraftWriteAt = 0;
  let reasoningContent = "";
  let reasoningStartedAt: string | undefined;
  let reasoningFinished = false;
  let persistedReasoningLength = 0;
  let lastReasoningWriteAt = 0;

  const writeDraft = (content: string, force = false) => {
    if (!input.assistantDraft) return;
    const now = Date.now();
    if (!force && now - lastDraftWriteAt < STREAMING_DRAFT_WRITE_INTERVAL_MS) return;
    lastDraftWriteAt = now;
    input.storage.updateMessage(input.assistantDraft.id, {
      content,
      status: "streaming",
      metadata: {
        ...input.assistantDraft.metadata,
        ...companionModeMetadata(input.outputMode),
        streamMode: input.outputMode === "unrestricted" ? "direct" : "guarded_buffer",
        guardHeld,
      },
    });
  };

  const emitToken = (delta: string, provisional: boolean, final = false) => {
    if (!delta) return;
    if (input.outputMode === "unrestricted") {
      input.emit({
        type: "token",
        runId: input.runId,
        delta,
        final,
        outputMode: "unrestricted",
        streamMode: "direct",
        provisional: false,
      });
      return;
    }
    input.emit({
      type: "token",
      runId: input.runId,
      delta,
      final,
      outputMode: "bounded",
      streamMode: "guarded_buffer",
      provisional,
    });
  };

  const writeReasoning = (force = false) => {
    if (!input.assistantDraft || !reasoningStartedAt) return;
    const delta = reasoningContent.slice(persistedReasoningLength);
    if (!delta) return;
    const now = Date.now();
    if (!force && now - lastReasoningWriteAt < STREAMING_DRAFT_WRITE_INTERVAL_MS) return;
    const persisted = input.storage.appendMessageReasoning(
      input.assistantDraft.id,
      delta,
      "provider",
      reasoningStartedAt,
    );
    if (!persisted) return;
    persistedReasoningLength = reasoningContent.length;
    lastReasoningWriteAt = now;
  };

  const finishReasoning = (status: "completed" | "interrupted") => {
    if (!reasoningStartedAt || reasoningFinished) return;
    reasoningFinished = true;
    writeReasoning(true);
    const completedAt = new Date().toISOString();
    const persisted = input.assistantDraft
      ? input.storage.finishMessageReasoning(
          input.assistantDraft.id,
          status,
          completedAt,
        )?.reasoning
      : undefined;
    input.emit({
      type: "reasoning_end",
      runId: input.runId,
      reasoning: persisted ?? {
        content: reasoningContent,
        status,
        source: "provider",
        startedAt: reasoningStartedAt,
        completedAt,
        durationMs: Math.max(
          0,
          new Date(completedAt).getTime() - new Date(reasoningStartedAt).getTime(),
        ),
      },
    });
  };

  return {
    onReasoningToken(delta: string) {
      if (!delta || reasoningFinished) return;
      reasoningStartedAt ??= new Date().toISOString();
      reasoningContent += delta;
      writeReasoning();
      input.emit({
        type: "reasoning",
        runId: input.runId,
        delta,
        source: "provider",
        startedAt: reasoningStartedAt,
      });
    },

    onToken(delta: string) {
      if (!delta) return;
      finishReasoning("completed");
      raw += delta;
      if (input.outputMode === "unrestricted") {
        emitted += delta;
        emitToken(delta, false);
        writeDraft(raw);
        return;
      }
      if (hasCompanionHardBoundaryRisk({ userText: input.userText, assistantText: raw })) {
        guardHeld = true;
        if (!guardNoticeEmitted) {
          guardNoticeEmitted = true;
          input.emit({
            type: "stream_guard",
            runId: input.runId,
            status: "held",
            reason: "hard_boundary_risk",
            outputMode: "bounded",
          });
        }
        writeDraft(emitted);
        return;
      }
      const safeLength = Math.max(0, raw.length - BOUNDED_STREAM_GUARD_TAIL_CHARS);
      if (safeLength > emitted.length) {
        const next = raw.slice(emitted.length, safeLength);
        emitted += next;
        emitToken(next, true);
        writeDraft(emitted);
      }
    },

    finish(
      finalContent: string,
      reasoningStatus: "completed" | "interrupted" = "completed",
    ) {
      finishReasoning(reasoningStatus);
      const final = finalContent || "";
      if (final.startsWith(emitted)) {
        const remaining = final.slice(emitted.length);
        if (remaining) emitToken(remaining, false, true);
      } else if (final !== emitted) {
        input.emit({
          type: "replace",
          runId: input.runId,
          content: final,
          reason: guardHeld ? "safety_rewrite" : "final_reconcile",
          outputMode: input.outputMode,
        });
      }
      emitted = final;
      writeDraft(final, true);
    },
  };
}
