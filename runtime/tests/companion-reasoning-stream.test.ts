import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CompanionConversationWorkflow } from "../src/companion/CompanionConversationWorkflow.js";
import { CompanionKnowledgeService } from "../src/companion/CompanionKnowledgeService.js";
import type { CompanionStreamEvent } from "../src/companion/CompanionStreamContracts.js";
import { CompanionStorageManager } from "../src/companion/CompanionStorageManager.js";
import type { ChatRequest, ModelResponse } from "../src/model/types.js";

describe("Companion reasoning stream", () => {
  it("streams and persists reasoning separately, then excludes it from the next turn context", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ariadne-reasoning-stream-"));
    let manager = new CompanionStorageManager(root);
    let workflow = createWorkflow(manager, async (request) => {
      request.onReasoningToken?.("先检查");
      request.onReasoningToken?.("约束。");
      request.onToken?.("最终回答");
      return response("最终回答", "先检查约束。");
    });
    const events: CompanionStreamEvent[] = [];

    try {
      await workflow.chatStream(
        {
          message: "请分析",
          inference: { reasoningMode: "on", reasoningEffort: "high" },
        },
        (event) => events.push(event),
      );

      const eventTypes = events.map((event) => event.type);
      expect(eventTypes.indexOf("reasoning")).toBeGreaterThan(
        eventTypes.indexOf("run_start"),
      );
      expect(eventTypes.indexOf("reasoning_end")).toBeGreaterThan(
        eventTypes.indexOf("reasoning"),
      );
      expect(eventTypes.indexOf("token")).toBeGreaterThan(
        eventTypes.indexOf("reasoning_end"),
      );
      expect(eventTypes.at(-1)).toBe("done");

      const done = events.find(
        (event): event is Extract<CompanionStreamEvent, { type: "done" }> =>
          event.type === "done",
      );
      expect(done?.result.persistence).toBe("stored");
      if (!done || done.result.persistence !== "stored") {
        throw new Error("stored done event missing");
      }
      const sessionId = done.result.session.id;
      expect(done.result.assistantMessage).toMatchObject({
        content: "最终回答",
        reasoning: {
          content: "先检查约束。",
          status: "completed",
          source: "provider",
        },
      });

      workflow.close();
      manager.closeAll();
      manager = new CompanionStorageManager(root);
      const persisted = manager.get().listMessages(sessionId);
      expect(persisted.at(-1)).toMatchObject({
        content: "最终回答",
        reasoning: {
          content: "先检查约束。",
          status: "completed",
          source: "provider",
        },
      });

      let followUpRequest: ChatRequest | undefined;
      workflow = createWorkflow(manager, async (request) => {
        followUpRequest = request;
        request.onToken?.("后续回答");
        return response("后续回答");
      });
      await workflow.chatStream(
        { sessionId, message: "继续" },
        () => undefined,
      );

      expect(followUpRequest).toBeDefined();
      expect(JSON.stringify(followUpRequest?.messages)).not.toContain("先检查约束");
      expect(followUpRequest?.messages).toContainEqual(
        expect.objectContaining({ role: "assistant", content: "最终回答" }),
      );
    } finally {
      workflow.close();
      manager.closeAll();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function createWorkflow(
  manager: CompanionStorageManager,
  directChat: (request: ChatRequest) => Promise<ModelResponse>,
): CompanionConversationWorkflow {
  return new CompanionConversationWorkflow({
    storageManager: manager,
    knowledge: new CompanionKnowledgeService(manager),
    directChat,
  });
}

function response(content: string, reasoningContent?: string): ModelResponse {
  return {
    content,
    ...(reasoningContent ? { reasoningContent } : {}),
    toolCalls: [],
    clientName: "deepseek-test",
    modelName: "deepseek-reasoner",
    location: "remote",
    latencyMs: 25,
  };
}
