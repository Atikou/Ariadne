import { z } from "zod";

import {
  CompanionAgentProposalSubmissionResultShape,
  addCompanionAgentProposalSubmissionIssues,
} from "./CompanionAgentProposalOutboxContracts.js";
import {
  CompanionChatResultSchema,
  CompanionIncognitoChatResultSchema,
  CompanionStoredChatResultSchema,
} from "./CompanionChatContracts.js";
import { CompanionOutputModeSchema } from "./CompanionMemoryContracts.js";
import {
  CompanionMessageSchema,
  CompanionSessionSchema,
  CompanionStorageStatusSchema,
} from "./CompanionSessionContracts.js";

const streamRunId = z.string().uuid();
const storedSession = CompanionSessionSchema.extend({ incognito: z.literal(false) });
const storedUserMessage = CompanionMessageSchema.extend({
  role: z.literal("user"),
  status: z.literal("completed"),
});
const storedAssistantDraft = CompanionMessageSchema.extend({
  role: z.literal("assistant"),
  status: z.literal("streaming"),
});

export const CompanionStoredStreamStartEventSchema = z.object({
  type: z.literal("run_start"),
  runId: streamRunId,
  persistence: z.literal("stored"),
  outputMode: CompanionOutputModeSchema,
  session: storedSession,
  userMessage: storedUserMessage,
  assistantMessage: storedAssistantDraft,
  storage: CompanionStorageStatusSchema,
}).strict().superRefine((event, ctx) => {
  for (const [field, sessionId] of [
    ["userMessage", event.userMessage.sessionId],
    ["assistantMessage", event.assistantMessage.sessionId],
  ] as const) {
    if (sessionId === event.session.id) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${field}.sessionId 必须指向启动事件的 session`,
      path: [field, "sessionId"],
    });
  }
});

export const CompanionIncognitoStreamStartEventSchema = z.object({
  type: z.literal("run_start"),
  runId: streamRunId,
  persistence: z.literal("incognito"),
  outputMode: CompanionOutputModeSchema,
  storage: CompanionStorageStatusSchema,
}).strict();

export const CompanionStreamStartEventSchema = z.union([
  CompanionStoredStreamStartEventSchema,
  CompanionIncognitoStreamStartEventSchema,
]);

const streamTokenBase = {
  type: z.literal("token"),
  runId: streamRunId,
  delta: z.string().min(1),
  final: z.boolean(),
};

export const CompanionDirectStreamTokenEventSchema = z.object({
  ...streamTokenBase,
  outputMode: z.literal("unrestricted"),
  streamMode: z.literal("direct"),
  provisional: z.literal(false),
}).strict();

export const CompanionGuardedStreamTokenEventSchema = z.object({
  ...streamTokenBase,
  outputMode: z.literal("bounded"),
  streamMode: z.literal("guarded_buffer"),
  provisional: z.boolean(),
}).strict().superRefine((event, ctx) => {
  if (!event.final || !event.provisional) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: "final token 不能仍标记为 provisional",
    path: ["provisional"],
  });
});

export const CompanionStreamTokenEventSchema = z.union([
  CompanionDirectStreamTokenEventSchema,
  CompanionGuardedStreamTokenEventSchema,
]);

export const CompanionStreamReplaceEventSchema = z.object({
  type: z.literal("replace"),
  runId: streamRunId,
  content: z.string(),
  reason: z.enum(["safety_rewrite", "final_reconcile"]),
  outputMode: CompanionOutputModeSchema,
}).strict();

export const CompanionStreamGuardEventSchema = z.object({
  type: z.literal("stream_guard"),
  runId: streamRunId,
  status: z.literal("held"),
  reason: z.literal("hard_boundary_risk"),
  outputMode: z.literal("bounded"),
}).strict();

export const CompanionStreamAgentProposalEventSchema = z.object({
  type: z.literal("agent_proposal"),
  runId: streamRunId,
  ...CompanionAgentProposalSubmissionResultShape,
  content: z.string(),
}).strict().superRefine((event, ctx) => {
  addCompanionAgentProposalSubmissionIssues(event, ctx);
  if (event.content !== event.proposal.reason) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "提案事件公开内容必须与 proposal.reason 一致",
      path: ["content"],
    });
  }
});

export const CompanionStreamDoneEventSchema = z.object({
  type: z.literal("done"),
  runId: streamRunId,
  result: CompanionChatResultSchema,
}).strict();

export const CompanionStoredStreamCancelledEventSchema = z.object({
  type: z.literal("cancelled"),
  runId: streamRunId,
  persistence: z.literal("stored"),
  code: z.literal("CANCELLED"),
  messageId: z.string().min(1),
  content: z.string(),
  storage: CompanionStorageStatusSchema,
}).strict();

export const CompanionIncognitoStreamCancelledEventSchema = z.object({
  type: z.literal("cancelled"),
  runId: streamRunId,
  persistence: z.literal("incognito"),
  code: z.literal("CANCELLED"),
  messageId: z.null(),
  content: z.string(),
  storage: CompanionStorageStatusSchema,
}).strict();

export const CompanionStreamCancelledEventSchema = z.union([
  CompanionStoredStreamCancelledEventSchema,
  CompanionIncognitoStreamCancelledEventSchema,
]);

export const CompanionStreamErrorEventSchema = z.object({
  type: z.literal("error"),
  runId: streamRunId,
  code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
  message: z.string().min(1).max(500),
  retryable: z.boolean(),
}).strict();

export const CompanionStreamEventSchema = z.union([
  CompanionStoredStreamStartEventSchema,
  CompanionIncognitoStreamStartEventSchema,
  CompanionDirectStreamTokenEventSchema,
  CompanionGuardedStreamTokenEventSchema,
  CompanionStreamReplaceEventSchema,
  CompanionStreamGuardEventSchema,
  CompanionStreamAgentProposalEventSchema,
  CompanionStreamDoneEventSchema,
  CompanionStoredStreamCancelledEventSchema,
  CompanionIncognitoStreamCancelledEventSchema,
  CompanionStreamErrorEventSchema,
]);
export type CompanionStreamEvent = z.infer<typeof CompanionStreamEventSchema>;

type StreamPersistence = "stored" | "incognito";

export class CompanionStreamProtocolError extends Error {
  readonly code = "COMPANION_STREAM_PROTOCOL_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "CompanionStreamProtocolError";
  }
}

/** Validates event shape and enforces one run_start followed by one terminal event. */
export class CompanionStreamEventSequence {
  private runId?: string;
  private persistence?: StreamPersistence;
  private outputMode?: z.infer<typeof CompanionOutputModeSchema>;
  private sessionId?: string;
  private userMessageId?: string;
  private assistantMessageId?: string;
  private storageIdentity?: string;
  private proposalId?: string;
  private terminal = false;

  constructor(private readonly sink: (event: CompanionStreamEvent) => void) {}

  get hasStarted(): boolean {
    return this.runId !== undefined;
  }

  get hasTerminated(): boolean {
    return this.terminal;
  }

  send(rawEvent: unknown): CompanionStreamEvent {
    const parsed = CompanionStreamEventSchema.safeParse(rawEvent);
    if (!parsed.success) {
      throw new CompanionStreamProtocolError("事件结构不符合 Companion SSE 契约");
    }
    const event = parsed.data;
    if (!this.runId) {
      if (event.type !== "run_start") {
        throw new CompanionStreamProtocolError(`${event.type} 早于 run_start`);
      }
      this.runId = event.runId;
      this.persistence = event.persistence;
      this.outputMode = event.outputMode;
      this.sessionId = event.persistence === "stored" ? event.session.id : undefined;
      this.userMessageId = event.persistence === "stored" ? event.userMessage.id : undefined;
      this.assistantMessageId = event.persistence === "stored"
        ? event.assistantMessage.id
        : undefined;
      this.storageIdentity = `${event.storage.storageRoot}\n${event.storage.dbPath}`;
      this.sink(event);
      return event;
    }
    if (this.terminal) {
      throw new CompanionStreamProtocolError(`终态后收到 ${event.type}`);
    }
    if (event.type === "run_start") {
      throw new CompanionStreamProtocolError("同一流重复收到 run_start");
    }
    if (event.runId !== this.runId) {
      throw new CompanionStreamProtocolError("同一流出现多个 runId");
    }
    this.assertOutputMode(event);
    if (event.type === "agent_proposal") {
      if (this.persistence !== "stored" || !this.sessionId || !this.userMessageId) {
        throw new CompanionStreamProtocolError("incognito 流不能创建 Agent 提案");
      }
      if (this.proposalId) {
        throw new CompanionStreamProtocolError("同一流重复创建 Agent 提案");
      }
      if (
        event.proposal.companionSessionId !== this.sessionId
        || event.proposal.sourceTurnId !== this.userMessageId
      ) {
        throw new CompanionStreamProtocolError("提案事件没有绑定 run_start 的真实会话和消息");
      }
      this.proposalId = event.proposal.id;
    }
    if (event.type === "done") {
      this.assertDoneIdentity(event.result);
    }
    if (event.type === "cancelled") {
      if (event.persistence !== this.persistence) {
        throw new CompanionStreamProtocolError("cancelled.persistence 与 run_start 不一致");
      }
      this.assertStorageIdentity(event.storage);
      if (event.persistence === "stored" && event.messageId !== this.assistantMessageId) {
        throw new CompanionStreamProtocolError("cancelled.messageId 与 run_start 不一致");
      }
    }
    if (event.type === "done" || event.type === "cancelled" || event.type === "error") {
      this.terminal = true;
    }
    this.sink(event);
    return event;
  }

  private assertDoneIdentity(
    result: z.infer<typeof CompanionStoredChatResultSchema>
      | z.infer<typeof CompanionIncognitoChatResultSchema>,
  ): void {
    if (result.persistence !== this.persistence) {
      throw new CompanionStreamProtocolError("done.result.persistence 与 run_start 不一致");
    }
    if (
      result.persistence === "stored"
      && this.sessionId !== undefined
      && result.session.id !== this.sessionId
    ) {
      throw new CompanionStreamProtocolError("done.result.session 与 run_start 不一致");
    }
    this.assertStorageIdentity(result.storage);
    if (
      result.persistence === "stored"
      && (
        result.userMessage.id !== this.userMessageId
        || result.assistantMessage.id !== this.assistantMessageId
      )
    ) {
      throw new CompanionStreamProtocolError("done.result 消息身份与 run_start 不一致");
    }
    const resultProposalId = result.response.type === "agent_proposal"
      ? result.response.proposal.id
      : undefined;
    if (resultProposalId !== this.proposalId) {
      throw new CompanionStreamProtocolError("done.result 提案与流式提案事件不一致");
    }
  }

  private assertOutputMode(event: CompanionStreamEvent): void {
    const eventMode = event.type === "token" || event.type === "replace" || event.type === "stream_guard"
      ? event.outputMode
      : event.type === "done"
        ? event.result.safety.outputMode
        : undefined;
    if (eventMode !== undefined && eventMode !== this.outputMode) {
      throw new CompanionStreamProtocolError(`${event.type}.outputMode 与 run_start 不一致`);
    }
  }

  private assertStorageIdentity(storage: z.infer<typeof CompanionStorageStatusSchema>): void {
    if (`${storage.storageRoot}\n${storage.dbPath}` !== this.storageIdentity) {
      throw new CompanionStreamProtocolError("终态 storage 与 run_start 不一致");
    }
  }
}
