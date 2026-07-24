import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgentHandoffRuntime } from "../src/app/createAgentHandoffRuntime.js";
import { CompanionService } from "../src/companion/CompanionService.js";
import {
  COMPANION_AGENT_PROPOSAL_TOOL_NAME,
  COMPANION_AGENT_PROTOCOL_VERSION,
} from "../src/companion/CompanionTurnProtocol.js";
import { ContextManager } from "../src/context/ContextManager.js";
import { createDirectChatFn } from "../src/model/directChat.js";
import { createConservativeTokenCounter } from "../src/model/TokenCounter.js";
import type {
  ChatRequest,
  ModelClient,
  ModelResponse,
} from "../src/model/types.js";
import type { Orchestrator } from "../src/orchestrator/Orchestrator.js";
import type { TraceEvent, TraceLogger } from "../src/trace/TraceLogger.js";

const temporaryRoots: string[] = [];
const contextManagers: ContextManager[] = [];
const companionServices: CompanionService[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const service of companionServices.splice(0)) service.close();
  for (const context of contextManagers.splice(0)) context.db.close();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("manual model routing binding", () => {
  it("records an explicit Chat model choice in the durable proposal source", async () => {
    const root = temporaryRoot("ariadne-chat-model-binding-");
    const companionRoot = path.join(root, "companion");
    let routedOptions: unknown;
    let submittedSource: unknown;
    const service = new CompanionService({
      projectRoot: root,
      defaultStorageRoot: companionRoot,
      directChat: async (_request, options): Promise<ModelResponse> => {
        routedOptions = options;
        return {
          ...modelResponse(""),
          toolCalls: [{
            id: "proposal-call-1",
            name: COMPANION_AGENT_PROPOSAL_TOOL_NAME,
            arguments: {
              reason: "需要读取项目",
              interpretedTask: "读取项目并给出结果",
              requestedCapabilities: ["file-read"],
              risk: "read-only",
            },
          }],
        };
      },
      proposeAgentHandoff: (submission) => {
        submittedSource = submission.source;
        const now = new Date().toISOString();
        return {
          proposal: {
            schemaVersion: 1,
            id: "proposal-chat-binding-1",
            sourceTurnId: submission.sourceTurnId,
            companionSessionId: submission.companionSessionId,
            reason: submission.draft.reason,
            originalRequest: submission.originalRequest,
            interpretedTask: submission.draft.interpretedTask,
            requestedCapabilities: submission.draft.requestedCapabilities,
            requestedScope: [root],
            risk: submission.draft.risk,
            workspaceKey: submission.workspaceKey ?? "primary",
            status: "pending",
            createdAt: now,
            updatedAt: now,
          },
        };
      },
    });
    companionServices.push(service);

    await service.chat({
      message: "检查项目",
      workspaceKey: "primary",
      clientName: "cloud-deepseek",
    });

    expect(routedOptions).toMatchObject({
      forceClient: "cloud-deepseek",
    });
    expect(submittedSource).toMatchObject({
      protocolVersion: COMPANION_AGENT_PROTOCOL_VERSION,
      selectionMode: "manual",
      requestedClientName: "cloud-deepseek",
      clientName: "cloud-deepseek",
      modelName: "deepseek-v4-flash",
      responseHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it("persists the Chat selection and applies it to the initial Agent execution", async () => {
    const root = temporaryRoot("ariadne-agent-model-binding-");
    const contextManager = new ContextManager({
      dataDir: path.join(root, "runtime"),
      useLanceDb: false,
    });
    contextManagers.push(contextManager);
    const traces: TraceEvent[] = [];
    const boundChat = vi.fn();
    const makeChatFn = vi.fn(() => boundChat);
    const runAgentFromHandoff = vi.fn(async (
      _body: unknown,
      _execution: unknown,
      chat: unknown,
    ) => {
      expect(chat).toBe(boundChat);
      return {
        status: 200,
        body: {
          runId: "run-deepseek-1",
          answer: "done",
          steps: [],
          executionMeta: { stopReason: "completed" },
        },
      };
    });
    const workspace = {
      id: "primary",
      label: "Primary",
      root,
      resolvedRoot: root,
    };
    const coordinator = createAgentHandoffRuntime({
      contextManager,
      workspaceCatalog: {
        defaultKey: workspace.id,
        defaultRoot: root,
        entries: [workspace],
        byId: new Map([[workspace.id, workspace]]),
      },
      orchestrator: { runAgentFromHandoff } as unknown as Orchestrator,
      trace: {
        write: (event: TraceEvent) => traces.push(event),
      } as TraceLogger,
      makeChatFn: makeChatFn as never,
    });

    const proposal = coordinator.submitFromCompanion({
      sourceTurnId: "turn-deepseek-1",
      companionSessionId: "companion-deepseek-1",
      companionStorageRoot: path.join(root, "companion"),
      originalRequest: "检查项目",
      workspaceKey: workspace.id,
      draft: {
        reason: "需要读取项目",
        interpretedTask: "读取项目并给出结果",
        requestedCapabilities: ["file-read"],
        risk: "read-only",
      },
      source: {
        protocolVersion: "ariadne.agent-proposal.v1",
        transport: "tool_call",
        selectionMode: "manual",
        requestedClientName: "cloud-deepseek",
        clientName: "cloud-deepseek",
        modelName: "deepseek-v4-flash",
        responseHash: "0".repeat(64),
      },
    });

    expect(proposal.modelBinding).toEqual({
      selectionMode: "manual",
      clientName: "cloud-deepseek",
      modelName: "deepseek-v4-flash",
      protocolVersion: "ariadne.agent-proposal.v1",
    });
    expect(coordinator.get(proposal.id)?.modelBinding).toEqual(proposal.modelBinding);

    const response = await coordinator.respond(proposal.id, {
      decision: "approve_once",
      allowedCapabilities: ["file-read"],
    });

    expect(response?.proposal.status).toBe("completed");
    expect(makeChatFn).toHaveBeenCalledWith("cloud-deepseek");
    expect(runAgentFromHandoff).toHaveBeenCalledTimes(1);
    expect(coordinator.getByRunId("run-deepseek-1")?.modelBinding)
      .toEqual(proposal.modelBinding);
    expect(traces).toContainEqual(expect.objectContaining({
      type: "assistant_agent_grant_consumed",
      modelSelectionMode: "manual",
      requestedClientName: "cloud-deepseek",
      requestedModelName: "deepseek-v4-flash",
    }));
  });

  it("uses the same binding when the Agent result is presented to Chat", async () => {
    const root = temporaryRoot("ariadne-result-model-binding-");
    const companionRoot = path.join(root, "companion");
    const routeOptions: unknown[] = [];
    const service = new CompanionService({
      projectRoot: root,
      defaultStorageRoot: companionRoot,
      directChat: async (_request, options): Promise<ModelResponse> => {
        routeOptions.push(options);
        return modelResponse("Agent 已完成项目检查。");
      },
    });
    companionServices.push(service);
    const created = service.createSession({ title: "Routing binding" });
    const storage = service.storageManager.get(companionRoot);
    const sourceTurn = storage.createMessage({
      sessionId: created.session.id,
      role: "user",
      content: "检查项目",
    });
    const now = new Date().toISOString();

    const result = await service.presentAgentResult({
      companionStorageRoot: companionRoot,
      proposal: {
        schemaVersion: 1,
        id: "proposal-result-1",
        sourceTurnId: sourceTurn.id,
        companionSessionId: created.session.id,
        agentSessionId: "agent-session-result-1",
        reason: "需要读取项目",
        originalRequest: "检查项目",
        interpretedTask: "读取项目并给出结果",
        requestedCapabilities: ["file-read"],
        requestedScope: [root],
        risk: "read-only",
        workspaceKey: "primary",
        modelBinding: {
          selectionMode: "manual",
          clientName: "cloud-deepseek",
          modelName: "deepseek-v4-flash",
          protocolVersion: "ariadne.agent-proposal.v1",
        },
        status: "completed",
        createdAt: now,
        updatedAt: now,
        respondedAt: now,
        grantId: "grant-result-1",
        runId: "run-result-1",
        outcome: {
          status: "completed",
          answer: "项目检查完成",
        },
      },
    });

    expect(result.source).toBe("model");
    expect(routeOptions).toEqual([{
      taskType: "simple",
      forceClient: "cloud-deepseek",
    }]);
  });

  it("logs the requested and resolved client and never falls back from a manual binding", async () => {
    const traces: TraceEvent[] = [];
    const localChat = vi.fn(async (): Promise<ModelResponse> => modelResponse("local", {
      clientName: "qwen-local",
      modelName: "qwen3-4b-q4-k-m",
      location: "local",
    }));
    const remoteChat = vi.fn(async (): Promise<ModelResponse> => modelResponse("remote"));
    const directChat = createDirectChatFn([
      modelClient("qwen-local", "qwen3-4b-q4-k-m", "local", localChat),
      modelClient("cloud-deepseek", "deepseek-v4-flash", "remote", remoteChat),
    ], {
      strategy: "local-first",
      fallback: true,
      trace: {
        write: (event: TraceEvent) => traces.push(event),
      } as TraceLogger,
    });

    await expect(directChat({
      messages: [{ role: "user", content: "test" }],
    }, {
      forceClient: "cloud-deepseek",
      taskType: "simple",
    })).resolves.toMatchObject({ clientName: "cloud-deepseek" });

    expect(localChat).not.toHaveBeenCalled();
    expect(remoteChat).toHaveBeenCalledTimes(1);
    expect(traces).toContainEqual(expect.objectContaining({
      type: "model.request.started",
      metadata: expect.objectContaining({
        modelSelectionMode: "manual",
        requestedClientName: "cloud-deepseek",
        resolvedClientName: "cloud-deepseek",
        bindingMatched: true,
      }),
    }));

    await expect(directChat({
      messages: [{ role: "user", content: "missing" }],
    }, {
      forceClient: "missing-client",
    })).rejects.toThrow("未找到指定模型：missing-client");
    expect(localChat).not.toHaveBeenCalled();
    expect(traces).toContainEqual(expect.objectContaining({
      type: "model.routing.error",
      metadata: expect.objectContaining({
        lifecycleStage: "candidate_resolution",
        modelSelectionMode: "manual",
        requestedClientName: "missing-client",
        resolvedClientName: null,
        retryable: false,
      }),
    }));
  });
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function modelClient(
  name: string,
  model: string,
  location: "local" | "remote",
  chat: (request: ChatRequest) => Promise<ModelResponse>,
): ModelClient {
  return {
    name,
    model,
    location,
    toolCallCapability: "native",
    tokenCounter: createConservativeTokenCounter(name),
    isAvailable: async () => true,
    chat,
  };
}

function modelResponse(
  content: string,
  overrides: Partial<ModelResponse> = {},
): ModelResponse {
  return {
    content,
    toolCalls: [],
    clientName: "cloud-deepseek",
    modelName: "deepseek-v4-flash",
    location: "remote",
    latencyMs: 5,
    ...overrides,
  };
}
