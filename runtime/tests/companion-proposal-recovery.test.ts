import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  COMPANION_AGENT_PROPOSAL_TOOL_NAME,
  COMPANION_AGENT_PROTOCOL_VERSION,
} from "../src/companion/CompanionTurnProtocol.js";
import { CompanionService } from "../src/companion/CompanionService.js";
import type { CompanionStreamEvent } from "../src/companion/CompanionStreamContracts.js";
import type { ChatRequest, ModelResponse } from "../src/model/types.js";
import type { TraceEvent, TraceLogger } from "../src/trace/TraceLogger.js";

const validDraft = {
  reason: "需要读取现有项目并写入网页文件。",
  interpretedTask: "在当前工作区创建可交互的 3D 地球网页。",
  requestedCapabilities: ["file-read", "file-write", "shell"] as const,
  risk: "write" as const,
};

describe("Companion proposal recovery", () => {
  it("normalizes native tool calls with accompanying text without retrying", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ariadne-proposal-normalization-"));
    const requests: ChatRequest[] = [];
    const traces: TraceEvent[] = [];
    const events: CompanionStreamEvent[] = [];
    const service = new CompanionService({
      projectRoot: root,
      defaultStorageRoot: path.join(root, "companion"),
      trace: {
        write: (event: TraceEvent) => traces.push(event),
      } as TraceLogger,
      directChat: async (request): Promise<ModelResponse> => {
        requests.push(request);
        request.onToken?.("我先申请写入权限，然后开始创建文件。");
        return {
          ...modelResponse(validDraft),
          content: "我先申请写入权限，然后开始创建文件。",
        };
      },
      proposeAgentHandoff: (submission) => {
        const now = new Date().toISOString();
        return {
          proposal: {
            schemaVersion: 1,
            id: "proposal-normalized-1",
            sourceTurnId: submission.sourceTurnId,
            companionSessionId: submission.companionSessionId,
            reason: submission.draft.reason,
            originalRequest: submission.originalRequest,
            interpretedTask: submission.draft.interpretedTask,
            requestedCapabilities: submission.draft.requestedCapabilities,
            requestedScope: ["workspace"],
            risk: submission.draft.risk,
            workspaceKey: submission.workspaceKey ?? "primary",
            status: "pending",
            createdAt: now,
            updatedAt: now,
          },
        };
      },
    });

    try {
      service.start();
      await service.chatStream({
        message: "在当前目录创建一个 3D 地球网页项目",
        workspaceKey: "primary",
      }, (event) => events.push(event));

      expect(requests).toHaveLength(1);
      expect(events).toContainEqual(expect.objectContaining({
        type: "token",
        delta: "我已开始处理；需要额外权限时，系统会向你确认具体操作。",
        final: true,
      }));
      expect(events.some((event) =>
        (event.type === "token" && event.delta.includes("我先申请写入权限"))
        || (event.type === "replace" && event.content.includes("我先申请写入权限"))
      )).toBe(false);
      expect(events).toContainEqual(expect.objectContaining({
        type: "agent_proposal",
        proposal: expect.objectContaining({ id: "proposal-normalized-1" }),
      }));
      expect(traces).toContainEqual(expect.objectContaining({
        type: "companion.proposal.protocol.normalized",
        level: "warning",
        metadata: expect.objectContaining({
          normalization: "discarded_text_with_tool_call",
          lifecycleStage: "protocol_parse",
          responseHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          toolCallCount: 1,
        }),
      }));
      expect(traces).not.toContainEqual(expect.objectContaining({
        type: "companion.proposal.protocol.error",
      }));
    } finally {
      service.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retries one idempotent schema failure and records actionable diagnostics", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ariadne-proposal-recovery-"));
    const requests: ChatRequest[] = [];
    const traces: TraceEvent[] = [];
    const events: CompanionStreamEvent[] = [];
    const trace = {
      write: (event: TraceEvent) => traces.push(event),
    } as TraceLogger;
    const service = new CompanionService({
      projectRoot: root,
      defaultStorageRoot: path.join(root, "companion"),
      trace,
      browserAvailable: () => false,
      directChat: async (request): Promise<ModelResponse> => {
        requests.push(request);
        return requests.length === 1
          ? modelResponse({
              reason: validDraft.reason,
              interpretedTask: validDraft.interpretedTask,
              requestedCapabilities: validDraft.requestedCapabilities,
            })
          : modelResponse(validDraft);
      },
      proposeAgentHandoff: (submission) => {
        const now = new Date().toISOString();
        return {
          proposal: {
            schemaVersion: 1,
            id: "proposal-recovery-1",
            sourceTurnId: submission.sourceTurnId,
            companionSessionId: submission.companionSessionId,
            reason: submission.draft.reason,
            originalRequest: submission.originalRequest,
            interpretedTask: submission.draft.interpretedTask,
            requestedCapabilities: submission.draft.requestedCapabilities,
            requestedScope: ["workspace"],
            risk: submission.draft.risk,
            workspaceKey: submission.workspaceKey ?? "primary",
            status: "pending",
            createdAt: now,
            updatedAt: now,
          },
        };
      },
    });

    try {
      service.start();
      await service.chatStream({
        message: "在当前目录创建一个 3D 地球网页项目",
        workspaceKey: "primary",
      }, (event) => events.push(event));

      expect(requests).toHaveLength(2);
      expect(requests[0]?.tools).toEqual([
        expect.objectContaining({ name: COMPANION_AGENT_PROPOSAL_TOOL_NAME }),
      ]);
      expect(requests[1]).toMatchObject({
        temperature: 0,
        tools: [
          expect.objectContaining({ name: COMPANION_AGENT_PROPOSAL_TOOL_NAME }),
        ],
      });
      expect(events).toContainEqual(expect.objectContaining({
        type: "agent_proposal",
        proposal: expect.objectContaining({
          id: "proposal-recovery-1",
          status: "pending",
        }),
      }));

      const warning = traces.find((event) =>
        event.type === "companion.proposal.protocol.warning");
      expect(warning).toMatchObject({
        level: "warning",
        category: "companion.proposal.protocol",
        metadata: {
          attempt: "initial",
          idempotencyProtected: true,
          protocolVersion: COMPANION_AGENT_PROTOCOL_VERSION,
          lifecycleStage: "schema_validation",
          fieldPaths: ["risk"],
          responseHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          responsePreview: "",
          toolCallCount: 1,
        },
      });
      expect(traces).not.toContainEqual(expect.objectContaining({
        type: "companion.proposal.protocol.error",
      }));
    } finally {
      service.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not retry business validation failures", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ariadne-proposal-business-"));
    const requests: ChatRequest[] = [];
    const traces: TraceEvent[] = [];
    const events: CompanionStreamEvent[] = [];
    const service = new CompanionService({
      projectRoot: root,
      defaultStorageRoot: path.join(root, "companion"),
      trace: {
        write: (event: TraceEvent) => traces.push(event),
      } as TraceLogger,
      directChat: async (request) => {
        requests.push(request);
        return modelResponse({ ...validDraft, risk: "read-only" });
      },
      proposeAgentHandoff: () => {
        throw new Error("proposal delivery must not run");
      },
    });

    try {
      service.start();
      await service.chatStream({
        message: "写入项目文件",
        workspaceKey: "primary",
      }, (event) => events.push(event));

      expect(requests).toHaveLength(1);
      expect(events).toContainEqual(expect.objectContaining({
        type: "error",
        code: "COMPANION_TURN_PROTOCOL_ERROR",
      }));
      expect(traces).toContainEqual(expect.objectContaining({
        type: "companion.turn.error",
        metadata: expect.objectContaining({
          retryable: false,
          protocol: expect.objectContaining({
            stage: "business_validation",
            retryable: false,
          }),
        }),
      }));
      expect(traces).toContainEqual(expect.objectContaining({
        type: "companion.proposal.protocol.error",
        metadata: expect.objectContaining({
          attempt: "initial",
          lifecycleStage: "business_validation",
          modelVersion: "test-model-v1",
          protocolVersion: COMPANION_AGENT_PROTOCOL_VERSION,
          responseHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
      }));
    } finally {
      service.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function modelResponse(argumentsValue: unknown): ModelResponse {
  return {
    content: "",
    toolCalls: [{
      id: "proposal-call",
      name: COMPANION_AGENT_PROPOSAL_TOOL_NAME,
      arguments: argumentsValue,
    }],
    toolCallCapability: "native",
    clientName: "cloud-test",
    modelName: "test-model-v1",
    location: "remote",
    latencyMs: 5,
  };
}
