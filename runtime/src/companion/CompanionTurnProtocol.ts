import { z } from "zod";

import {
  AgentProposalDraftSchema,
  AgentProposalDraftStructuralSchema,
  type AgentProposalDraft,
} from "../assistant/AgentProposalDraftContracts.js";
import type {
  ModelToolCallCapability,
  ModelToolSpec,
  ToolCall,
} from "../model/types.js";

export const COMPANION_AGENT_PROTOCOL_VERSION = "1";
const COMPANION_AGENT_PROPOSAL_PREFIX = "<ariadne-agent-proposal";
export const COMPANION_AGENT_PROPOSAL_OPEN =
  `<ariadne-agent-proposal protocol="${COMPANION_AGENT_PROTOCOL_VERSION}">`;
export const COMPANION_AGENT_PROPOSAL_CLOSE = "</ariadne-agent-proposal>";
export const COMPANION_AGENT_PROPOSAL_TOOL_NAME = "request_agent_capabilities";

export type CompanionProposalTransport = "tool_call" | "text_envelope";
export type CompanionProposalLifecycleStage =
  | "transport_selection"
  | "protocol_parse"
  | "schema_validation"
  | "business_validation";
export type CompanionTurnProtocolIssue =
  | "proposal_disabled"
  | "transport_not_allowed"
  | "unsupported_version"
  | "unexpected_tool"
  | "multiple_tools"
  | "incomplete_envelope"
  | "invalid_json"
  | "invalid_schema"
  | "invalid_business_semantics";

export interface CompanionTurnProtocolDiagnostic {
  issue: CompanionTurnProtocolIssue;
  stage: CompanionProposalLifecycleStage;
  transport: CompanionProposalTransport;
  protocolVersion: string;
  retryable: boolean;
  schemaIssues?: Array<{
    path: string;
    code: string;
    message: string;
  }>;
  parserMessage?: string;
  toolNames?: string[];
}

export const CompanionModelMessageTurnSchema = z.object({
  kind: z.literal("message"),
  content: z.string(),
}).strict();

export const CompanionModelProposalTurnSchema = z.object({
  kind: z.literal("agent_proposal"),
  draft: AgentProposalDraftSchema,
  transport: z.enum(["tool_call", "text_envelope"]),
}).strict();

export const CompanionModelTurnSchema = z.discriminatedUnion("kind", [
  CompanionModelMessageTurnSchema,
  CompanionModelProposalTurnSchema,
]);
export type CompanionModelTurn = z.infer<typeof CompanionModelTurnSchema>;

export class CompanionTurnProtocolError extends Error {
  readonly code = "COMPANION_TURN_PROTOCOL_ERROR";

  constructor(
    message: string,
    readonly diagnostic: CompanionTurnProtocolDiagnostic,
  ) {
    super(message);
    this.name = "CompanionTurnProtocolError";
  }

  get retryable(): boolean {
    return this.diagnostic.retryable;
  }
}

export class CompanionEmptyResponseError extends Error {
  readonly code = "COMPANION_EMPTY_RESPONSE";

  constructor() {
    super("模型完成了请求，但没有返回可展示的最终内容");
    this.name = "CompanionEmptyResponseError";
  }
}

export function renderAgentProposalEnvelope(draft: AgentProposalDraft): string {
  const parsed = AgentProposalDraftSchema.parse(draft);
  return `${COMPANION_AGENT_PROPOSAL_OPEN}\n${JSON.stringify(parsed)}\n${COMPANION_AGENT_PROPOSAL_CLOSE}`;
}

export function createCompanionAgentProposalTool(
  browserAvailable: boolean,
): ModelToolSpec {
  const capabilities = browserAvailable
    ? ["file-read", "file-write", "browser", "shell"]
    : ["file-read", "file-write", "shell"];
  return {
    name: COMPANION_AGENT_PROPOSAL_TOOL_NAME,
    description:
      "Request the minimum temporary Agent capabilities needed for a real file, browser, or shell operation. This creates an authorization proposal; it does not execute the operation.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["reason", "interpretedTask", "requestedCapabilities", "risk"],
      properties: {
        reason: {
          type: "string",
          minLength: 1,
          maxLength: 2_000,
          description: "Why these concrete capabilities are required.",
        },
        interpretedTask: {
          type: "string",
          minLength: 1,
          maxLength: 8_000,
          description: "The real-world task the Agent should perform.",
        },
        requestedCapabilities: {
          type: "array",
          minItems: 1,
          maxItems: capabilities.length,
          uniqueItems: true,
          items: { type: "string", enum: capabilities },
        },
        risk: {
          type: "string",
          enum: ["read-only", "write", "destructive"],
        },
      },
    },
  };
}

export interface CompanionModelOutput {
  content: string;
  toolCalls: readonly ToolCall[];
  toolCallCapability?: ModelToolCallCapability;
}

export function parseCompanionModelResponse(
  output: CompanionModelOutput,
  options: { protocolEnabled?: boolean; agentProposalEnabled: boolean },
): CompanionModelTurn {
  if (options.protocolEnabled === false) {
    return CompanionModelTurnSchema.parse({ kind: "message", content: output.content });
  }
  if (output.toolCalls.length > 0) {
    if (output.toolCallCapability === "unsupported") {
      throw protocolError(
        "当前本地模型已声明不支持原生工具调用",
        "transport_not_allowed",
        "transport_selection",
        "tool_call",
        false,
      );
    }
    return parseProposalToolCall(output, options);
  }
  return parseCompanionModelTurn(output.content, {
    ...options,
    expectedProposalTransport: output.toolCallCapability === "native"
      ? "tool_call"
      : output.toolCallCapability === "unsupported"
        ? "text_envelope"
        : undefined,
  });
}

export function parseCompanionModelTurn(
  raw: string,
  options: {
    protocolEnabled?: boolean;
    agentProposalEnabled: boolean;
    expectedProposalTransport?: CompanionProposalTransport;
  },
): CompanionModelTurn {
  if (options.protocolEnabled === false) {
    return CompanionModelTurnSchema.parse({ kind: "message", content: raw });
  }
  const trimmed = raw.trim();
  if (!trimmed) throw new CompanionEmptyResponseError();
  const mentionsProtocol = trimmed.includes(COMPANION_AGENT_PROPOSAL_PREFIX)
    || trimmed.includes(COMPANION_AGENT_PROPOSAL_CLOSE);
  if (!mentionsProtocol) {
    return CompanionModelTurnSchema.parse({ kind: "message", content: raw });
  }
  if (!options.agentProposalEnabled) {
    throw protocolError(
      "当前对话不能创建持久化 Agent 提案",
      "proposal_disabled",
      "transport_selection",
      "text_envelope",
      false,
    );
  }
  if (options.expectedProposalTransport === "tool_call") {
    throw protocolError(
      "当前模型支持原生工具调用，不能降级为文本提案信封",
      "transport_not_allowed",
      "transport_selection",
      "text_envelope",
      true,
    );
  }
  if (trimmed.includes("<ariadne-agent-proposal>")) {
    throw protocolError(
      "Agent 文本提案信封缺少受支持的协议版本",
      "unsupported_version",
      "protocol_parse",
      "text_envelope",
      true,
    );
  }
  if (
    !trimmed.startsWith(COMPANION_AGENT_PROPOSAL_OPEN)
    || !trimmed.endsWith(COMPANION_AGENT_PROPOSAL_CLOSE)
  ) {
    throw protocolError(
      "Agent 提案必须是模型响应中的唯一完整信封",
      "incomplete_envelope",
      "protocol_parse",
      "text_envelope",
      true,
    );
  }
  const json = trimmed.slice(
    COMPANION_AGENT_PROPOSAL_OPEN.length,
    trimmed.length - COMPANION_AGENT_PROPOSAL_CLOSE.length,
  ).trim();
  let decoded: unknown;
  try {
    decoded = JSON.parse(json) as unknown;
  } catch (error) {
    throw protocolError(
      "Agent 提案不是合法 JSON",
      "invalid_json",
      "protocol_parse",
      "text_envelope",
      true,
      {
        parserMessage: error instanceof Error
          ? error.message.slice(0, 512)
          : "JSON.parse failed",
      },
    );
  }
  return proposalTurn(decoded, "text_envelope");
}

/**
 * Holds only the suffix that could still become a reserved envelope marker.
 * Once a marker starts, all remaining protocol bytes stay private until parsing.
 */
export class CompanionTurnStreamDecoder {
  private raw = "";
  private forwardedLength = 0;
  private protocolStart: number | undefined;

  constructor(
    private readonly options: {
      protocolEnabled?: boolean;
      agentProposalEnabled: boolean;
      onMessageToken(delta: string): void;
    },
  ) {}

  get rawText(): string {
    return this.raw;
  }

  get publicPartial(): string {
    return this.raw.slice(0, this.forwardedLength);
  }

  push(delta: string): void {
    if (!delta) return;
    this.raw += delta;
    if (this.options.protocolEnabled === false) {
      this.flushTo(this.raw.length);
      return;
    }
    if (this.protocolStart !== undefined) return;

    const markerIndex = firstMarkerIndex(this.raw, this.forwardedLength);
    if (markerIndex !== -1) {
      this.flushTo(markerIndex);
      this.protocolStart = markerIndex;
      return;
    }
    const heldLength = longestMarkerPrefixSuffix(this.raw);
    this.flushTo(this.raw.length - heldLength);
  }

  finish(output: string | CompanionModelOutput): CompanionModelTurn {
    const modelOutput = typeof output === "string"
      ? { content: output, toolCalls: [] }
      : output;
    if (!this.raw && modelOutput.content) this.raw = modelOutput.content;
    const turn = parseCompanionModelResponse(
      {
        content: this.raw,
        toolCalls: modelOutput.toolCalls,
        ...("toolCallCapability" in modelOutput && modelOutput.toolCallCapability
          ? { toolCallCapability: modelOutput.toolCallCapability }
          : {}),
      },
      this.options,
    );
    if (turn.kind === "message") this.flushTo(this.raw.length);
    return turn;
  }

  private flushTo(end: number): void {
    if (end <= this.forwardedLength) return;
    const delta = this.raw.slice(this.forwardedLength, end);
    this.forwardedLength = end;
    if (delta) this.options.onMessageToken(delta);
  }
}

function firstMarkerIndex(value: string, from: number): number {
  const searchFrom = Math.max(0, from - Math.max(
    COMPANION_AGENT_PROPOSAL_PREFIX.length,
    COMPANION_AGENT_PROPOSAL_CLOSE.length,
  ));
  const open = value.indexOf(COMPANION_AGENT_PROPOSAL_PREFIX, searchFrom);
  const close = value.indexOf(COMPANION_AGENT_PROPOSAL_CLOSE, searchFrom);
  if (open === -1) return close;
  if (close === -1) return open;
  return Math.min(open, close);
}

function longestMarkerPrefixSuffix(value: string): number {
  const markers = [COMPANION_AGENT_PROPOSAL_PREFIX, COMPANION_AGENT_PROPOSAL_CLOSE];
  const max = Math.min(value.length, Math.max(...markers.map((marker) => marker.length - 1)));
  for (let length = max; length > 0; length -= 1) {
    const suffix = value.slice(-length);
    if (markers.some((marker) => marker.startsWith(suffix))) return length;
  }
  return 0;
}

function parseProposalToolCall(
  output: CompanionModelOutput,
  options: { agentProposalEnabled: boolean },
): CompanionModelTurn {
  const toolNames = output.toolCalls.map((call) => call.name).slice(0, 8);
  if (!options.agentProposalEnabled) {
    throw protocolError(
      "当前对话不能创建持久化 Agent 提案",
      "proposal_disabled",
      "transport_selection",
      "tool_call",
      false,
      { toolNames },
    );
  }
  if (output.toolCalls.length !== 1) {
    throw protocolError(
      "Agent 提案响应必须只包含一次能力请求",
      "multiple_tools",
      "protocol_parse",
      "tool_call",
      true,
      { toolNames },
    );
  }
  const call = output.toolCalls[0]!;
  if (call.name !== COMPANION_AGENT_PROPOSAL_TOOL_NAME) {
    throw protocolError(
      `Agent 提案响应包含未授权的工具调用：${call.name}`,
      "unexpected_tool",
      "protocol_parse",
      "tool_call",
      true,
      { toolNames },
    );
  }
  return proposalTurn(call.arguments, "tool_call");
}

function proposalTurn(
  candidate: unknown,
  transport: CompanionProposalTransport,
): CompanionModelTurn {
  const structural = AgentProposalDraftStructuralSchema.safeParse(candidate);
  if (!structural.success) {
    throw protocolError(
      "Agent 提案字段不符合严格契约",
      "invalid_schema",
      "schema_validation",
      transport,
      true,
      {
        schemaIssues: normalizedIssues(structural.error.issues),
      },
    );
  }
  const semantic = AgentProposalDraftSchema.safeParse(structural.data);
  if (!semantic.success) {
    throw protocolError(
      "Agent 提案未通过业务语义校验",
      "invalid_business_semantics",
      "business_validation",
      transport,
      false,
      {
        schemaIssues: normalizedIssues(semantic.error.issues),
      },
    );
  }
  return CompanionModelTurnSchema.parse({
    kind: "agent_proposal",
    draft: semantic.data,
    transport,
  });
}

function normalizedIssues(
  issues: readonly z.ZodIssue[],
): CompanionTurnProtocolDiagnostic["schemaIssues"] {
  return issues.slice(0, 12).map((issue) => ({
    path: issue.path.map(String).join(".") || "$",
    code: issue.code,
    message: issue.message.slice(0, 512),
  }));
}

function protocolError(
  message: string,
  issue: CompanionTurnProtocolIssue,
  stage: CompanionProposalLifecycleStage,
  transport: CompanionProposalTransport,
  retryable: boolean,
  extra: Omit<
    CompanionTurnProtocolDiagnostic,
    "issue" | "stage" | "transport" | "protocolVersion" | "retryable"
  > = {},
): CompanionTurnProtocolError {
  return new CompanionTurnProtocolError(message, {
    issue,
    stage,
    transport,
    protocolVersion: COMPANION_AGENT_PROTOCOL_VERSION,
    retryable,
    ...extra,
  });
}
