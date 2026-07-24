import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { projectMessage } from "../src/application/publicProjection.js";
import { CompanionConversationWorkflow } from "../src/companion/CompanionConversationWorkflow.js";
import { CompanionKnowledgeService } from "../src/companion/CompanionKnowledgeService.js";
import type { CompanionStreamEvent } from "../src/companion/CompanionStreamContracts.js";
import { CompanionStorageManager } from "../src/companion/CompanionStorageManager.js";
import type { ChatRequest, ModelResponse } from "../src/model/types.js";

function response(content: string): ModelResponse {
  return {
    content,
    toolCalls: [],
    clientName: "cloud-deepseek",
    modelName: "deepseek-v4-flash",
    location: "remote",
    latencyMs: 1,
  };
}

describe("Companion empty response recovery", () => {
  it("projects a historical completed-empty assistant row as a retryable error", () => {
    const projected = projectMessage({
      id: "assistant-empty",
      sessionId: "session-1",
      role: "assistant",
      content: "",
      status: "completed",
      trusted: true,
      memoryEligible: false,
      storageRoot: "C:\\runtime\\companion",
      createdAt: "2026-07-24T07:52:50.098Z",
      updatedAt: "2026-07-24T07:53:03.344Z",
    });

    expect(projected).toMatchObject({
      status: "interrupted",
      error: {
        code: "COMPANION_EMPTY_RESPONSE",
        retryable: true,
      },
    });
  });

  it("continues from reasoning-only output and never completes an empty assistant message", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ariadne-empty-response-"));
    const manager = new CompanionStorageManager(root);
    const requests: ChatRequest[] = [];
    const events: CompanionStreamEvent[] = [];
    const workflow = new CompanionConversationWorkflow({
      storageManager: manager,
      knowledge: new CompanionKnowledgeService(manager),
      directChat: async (request) => {
        requests.push(request);
        if (requests.length === 1) {
          return {
            ...response(""),
            reasoningContent: "private reasoning that exhausted the first response budget",
            usage: { inputTokens: 1_279, outputTokens: 4_096 },
          };
        }
        return response("我已开始准备本地项目。");
      },
    });

    try {
      await workflow.chatStream(
        {
          message: "创建一个项目来实现，我需要在本地运行",
          inference: { reasoningMode: "on", reasoningEffort: "high" },
        },
        (event) => events.push(event),
      );

      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({
        maxTokens: 4_096,
        inference: { reasoningMode: "on", reasoningEffort: "high" },
      });
      expect(requests[1]).toMatchObject({
        maxTokens: 4_096,
        inference: { reasoningMode: "on", reasoningEffort: "high" },
      });
      expect(requests[1]?.messages).toContainEqual({
        role: "assistant",
        content: "",
        reasoningContent: "private reasoning that exhausted the first response budget",
      });
      expect(requests[1]?.messages.at(-1)?.content).toContain(
        "只产生了内部推理，没有生成可展示的最终内容",
      );

      const done = events.find((event) => event.type === "done");
      expect(done?.type).toBe("done");
      if (!done || done.type !== "done") throw new Error("missing done event");
      expect(done.result.content).toBe("我已开始准备本地项目。");
      expect(done.result.persistence).toBe("stored");
      if (done.result.persistence === "stored") {
        expect(done.result.assistantMessage).toMatchObject({
          status: "completed",
          content: "我已开始准备本地项目。",
        });
      }
    } finally {
      workflow.close();
      manager.closeAll();
      await rm(root, { recursive: true, force: true });
    }
  });
});
