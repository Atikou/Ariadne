import type { ChatRequest, ModelResponse } from "../model/types.js";
import type { AgentProposal } from "../assistant/AgentHandoffContracts.js";
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
  CompanionEmptyResponseError,
  CompanionTurnProtocolError,
  CompanionTurnStreamDecoder,
  parseCompanionModelTurn,
  type CompanionModelTurn,
} from "./CompanionTurnProtocol.js";

const BOUNDED_STREAM_GUARD_TAIL_CHARS = 32;
const STREAMING_DRAFT_WRITE_INTERVAL_MS = 350;
const COMPANION_MAX_TOKENS = 4_096;
const AGENT_PROPOSAL_PUBLIC_CONTENT =
  "我已开始处理；需要额外权限时，系统会向你确认具体操作。";

type CompanionStorageHandle = ReturnType<CompanionStorageManager["get"]>;

export interface CompanionConversationWorkflowDeps {
  storageManager: CompanionStorageManager;
  knowledge: CompanionKnowledgeService;
  directChat: (request: ChatRequest, opts?: RouteOptions) => Promise<ModelResponse>;
  agentProposalOutbox?: CompanionAgentProposalOutboxDispatcher;
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
  request: ChatRequest;
  retrieved: Awaited<ReturnType<CompanionKnowledgeService["searchMemoryVectors"]>>;
}

/** Owns the normal and streaming Companion conversation state machine. */
export class CompanionConversationWorkflow {
  private readonly activeRuns = new Map<string, AbortController>();

  constructor(private readonly deps: CompanionConversationWorkflowDeps) {}

  async chat(input: CompanionChatInput): Promise<CompanionChatResult> {
    const turn = await this.prepareTurn(input, false);
    const initialResponse = await this.deps.directChat(turn.request, this.routeOptions(input));
    const resolved = await this.parseOrRepairModelTurn(turn, initialResponse);
    const { response, modelTurn } = resolved;
    const safety = applyCompanionSafety({
      userText: turn.message,
      assistantText: modelTurnContent(modelTurn),
      outputMode: turn.outputMode,
    });
    const proposalDelivery = await this.deliverProposal(turn, modelTurn, safety, response);
    return this.completeTurn(turn, response, safety, proposalDelivery);
  }

  async chatStream(
    input: CompanionChatInput,
    emit: (event: CompanionStreamEvent) => void,
    context: CompanionConversationRunContext = {},
  ): Promise<void> {
    const runId = crypto.randomUUID();
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
    } catch (error) {
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
        },
        this.routeOptions(input),
      );
      throwIfModelAborted(controller.signal);
      let response = initialResponse;
      let modelTurn: CompanionModelTurn;
      try {
        modelTurn = protocol.finish(response.content);
      } catch (error) {
        const repairKind = modelTurnRepairKind(error, response);
        if (!repairKind) throw error;
        const repaired = await this.repairModelTurn(
          turn,
          response,
          repairKind,
          controller.signal,
        );
        response = repaired.response;
        modelTurn = repaired.modelTurn;
      }
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
      const result = await this.completeTurn(turn, response, safety, proposalDelivery);
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
      events.send({ type: "done", runId, result });
    } catch (error) {
      if (events.hasTerminated) throw error;
      if (error instanceof CompanionAgentProposalDeliveryPendingError) {
        events.send({
          type: "error",
          runId,
          code: error.code,
          message: error.message,
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
      relay.finish(partialSafety.content);
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
        events.send({
          type: "error",
          runId,
          code: publicError.code,
          message: publicError.message,
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
      }),
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
      request,
      retrieved,
    };
  }

  private async completeTurn(
    turn: PreparedCompanionTurn,
    response: ModelResponse,
    safety: ReturnType<typeof applyCompanionSafety>,
    proposalDelivery?: CompanionAgentProposalDelivery,
  ): Promise<CompanionChatResult> {
    const proposal = proposalDelivery?.proposal;
    const publicContent = proposalDelivery?.assistantMessage.content ?? safety.content;
    const assistantMessage = proposalDelivery?.assistantMessage ?? (turn.session
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
            metadata: {
              latencyMs: response.latencyMs,
              usage: response.usage,
              safety,
              responseType: proposal ? "agent_proposal" : "message",
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
        })
      : CompanionSummaryStatusSchema.parse({
          generated: false,
          reason: "incognito",
        });
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
    const outbox = turn.storage.enqueueAgentProposalOutbox({
      payload: {
        sourceTurnId: turn.userMessage.id,
        companionSessionId: turn.session.id,
        originalRequest: turn.message,
        workspaceKey: turn.input.workspaceKey,
        draft: { ...modelTurn.draft, reason: publicContent },
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
  ): Promise<{ response: ModelResponse; modelTurn: CompanionModelTurn }> {
    try {
      return {
        response,
        modelTurn: parseCompanionModelTurn(response.content, {
          protocolEnabled: turn.outputMode === "bounded",
          agentProposalEnabled: turn.agentProposalEnabled,
        }),
      };
    } catch (error) {
      const repairKind = modelTurnRepairKind(error, response);
      if (!repairKind) throw error;
      return this.repairModelTurn(turn, response, repairKind, signal);
    }
  }

  private async repairModelTurn(
    turn: PreparedCompanionTurn,
    previousResponse: ModelResponse,
    repairKind: "mixed_proposal" | "empty_response",
    signal?: AbortSignal,
  ): Promise<{ response: ModelResponse; modelTurn: CompanionModelTurn }> {
    const previousAssistantMessage = previousResponse.content || previousResponse.reasoningContent
      ? [{
          role: "assistant" as const,
          content: previousResponse.content,
          ...(previousResponse.reasoningContent
            ? { reasoningContent: previousResponse.reasoningContent }
            : {}),
        }]
      : [];
    const repairInstruction = repairKind === "mixed_proposal"
      ? [
          "上一条响应包含 Agent 提案标记，但没有遵守提案必须是整条响应唯一内容的协议。",
          "请重新生成本轮响应：需要现实操作时只输出一个完整严格的 Agent 提案信封；否则只输出普通自然语言。",
          "不要解释修复过程，也不要在提案信封前后添加任何文字。",
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
      ...(signal ? { signal } : {}),
    }, this.routeOptions(turn.input));
    const modelTurn = parseCompanionModelTurn(response.content, {
      protocolEnabled: turn.outputMode === "bounded",
      agentProposalEnabled: turn.agentProposalEnabled,
    });
    return { response, modelTurn };
  }
}

function modelTurnContent(turn: CompanionModelTurn): string {
  return turn.kind === "message" ? turn.content : AGENT_PROPOSAL_PUBLIC_CONTENT;
}

function isRepairableMixedProposal(error: unknown, content: string): boolean {
  if (!(error instanceof CompanionTurnProtocolError)) return false;
  const trimmed = content.trim();
  const mentionsMarker = trimmed.includes(COMPANION_AGENT_PROPOSAL_OPEN)
    || trimmed.includes(COMPANION_AGENT_PROPOSAL_CLOSE);
  if (!mentionsMarker) return false;
  return !trimmed.startsWith(COMPANION_AGENT_PROPOSAL_OPEN)
    || !trimmed.endsWith(COMPANION_AGENT_PROPOSAL_CLOSE);
}

function modelTurnRepairKind(
  error: unknown,
  response: ModelResponse,
): "mixed_proposal" | "empty_response" | undefined {
  if (isRepairableMixedProposal(error, response.content)) return "mixed_proposal";
  if (
    error instanceof CompanionEmptyResponseError
    && !response.content.trim()
    && response.toolCalls.length === 0
  ) {
    return "empty_response";
  }
  return undefined;
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

  return {
    onToken(delta: string) {
      if (!delta) return;
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

    finish(finalContent: string) {
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
