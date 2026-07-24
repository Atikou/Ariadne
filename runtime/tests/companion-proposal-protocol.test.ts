import { describe, expect, it } from "vitest";

import {
  COMPANION_AGENT_PROPOSAL_TOOL_NAME,
  COMPANION_AGENT_PROTOCOL_VERSION,
  CompanionTurnProtocolError,
  parseCompanionModelResponse,
  renderAgentProposalEnvelope,
} from "../src/companion/CompanionTurnProtocol.js";

const validDraft = {
  reason: "需要读取现有项目并写入网页文件。",
  interpretedTask: "在当前工作区创建可交互的 3D 地球网页。",
  requestedCapabilities: ["file-read", "file-write", "shell"] as const,
  risk: "write" as const,
};

describe("Companion Agent proposal protocol", () => {
  it("uses native structured tool calls for capable models", () => {
    expect(parseCompanionModelResponse({
      content: "",
      toolCallCapability: "native",
      toolCalls: [{
        id: "proposal-call-1",
        name: COMPANION_AGENT_PROPOSAL_TOOL_NAME,
        arguments: validDraft,
      }],
    }, {
      agentProposalEnabled: true,
    })).toEqual({
      kind: "agent_proposal",
      draft: validDraft,
      transport: "tool_call",
    });
  });

  it("uses the native tool payload as authoritative when the model also emits text", () => {
    expect(parseCompanionModelResponse({
      content: "我先申请写入权限，然后开始创建文件。",
      toolCallCapability: "native",
      toolCalls: [{
        id: "proposal-call-with-text",
        name: COMPANION_AGENT_PROPOSAL_TOOL_NAME,
        arguments: validDraft,
      }],
    }, {
      agentProposalEnabled: true,
    })).toEqual({
      kind: "agent_proposal",
      draft: validDraft,
      transport: "tool_call",
    });
  });

  it("accepts only the versioned text envelope for explicitly unsupported models", () => {
    const envelope = renderAgentProposalEnvelope(validDraft);
    expect(envelope).toContain(`protocol="${COMPANION_AGENT_PROTOCOL_VERSION}"`);
    expect(parseCompanionModelResponse({
      content: envelope,
      toolCallCapability: "unsupported",
      toolCalls: [],
    }, {
      agentProposalEnabled: true,
    })).toEqual({
      kind: "agent_proposal",
      draft: validDraft,
      transport: "text_envelope",
    });
  });

  it("does not allow a native-capable model to silently downgrade to text", () => {
    expect(() => parseCompanionModelResponse({
      content: renderAgentProposalEnvelope(validDraft),
      toolCallCapability: "native",
      toolCalls: [],
    }, {
      agentProposalEnabled: true,
    })).toThrowError(expect.objectContaining({
      diagnostic: expect.objectContaining({
        stage: "transport_selection",
        issue: "transport_not_allowed",
        retryable: true,
        protocolVersion: COMPANION_AGENT_PROTOCOL_VERSION,
      }),
    }));
  });

  it("marks schema failures retryable and reports normalized field paths", () => {
    try {
      parseCompanionModelResponse({
        content: "",
        toolCallCapability: "native",
        toolCalls: [{
          id: "proposal-call-invalid",
          name: COMPANION_AGENT_PROPOSAL_TOOL_NAME,
          arguments: {
            reason: validDraft.reason,
            interpretedTask: validDraft.interpretedTask,
            requestedCapabilities: validDraft.requestedCapabilities,
          },
        }],
      }, {
        agentProposalEnabled: true,
      });
      throw new Error("expected protocol error");
    } catch (error) {
      expect(error).toBeInstanceOf(CompanionTurnProtocolError);
      const protocol = error as CompanionTurnProtocolError;
      expect(protocol.diagnostic).toMatchObject({
        stage: "schema_validation",
        issue: "invalid_schema",
        retryable: true,
        schemaIssues: expect.arrayContaining([
          expect.objectContaining({ path: "risk" }),
        ]),
      });
    }
  });

  it("does not retry business semantic validation failures", () => {
    try {
      parseCompanionModelResponse({
        content: "",
        toolCallCapability: "native",
        toolCalls: [{
          id: "proposal-call-semantic",
          name: COMPANION_AGENT_PROPOSAL_TOOL_NAME,
          arguments: {
            ...validDraft,
            risk: "read-only",
          },
        }],
      }, {
        agentProposalEnabled: true,
      });
      throw new Error("expected protocol error");
    } catch (error) {
      expect(error).toBeInstanceOf(CompanionTurnProtocolError);
      const protocol = error as CompanionTurnProtocolError;
      expect(protocol.diagnostic).toMatchObject({
        stage: "business_validation",
        issue: "invalid_business_semantics",
        retryable: false,
        schemaIssues: expect.arrayContaining([
          expect.objectContaining({ path: "risk" }),
        ]),
      });
    }
  });
});
