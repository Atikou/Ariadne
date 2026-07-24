import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CompanionConversationWorkflow } from "../src/companion/CompanionConversationWorkflow.js";
import { CompanionKnowledgeService } from "../src/companion/CompanionKnowledgeService.js";
import type { CompanionStreamEvent } from "../src/companion/CompanionStreamContracts.js";
import { CompanionStorageManager } from "../src/companion/CompanionStorageManager.js";
import type { ModelResponse } from "../src/model/types.js";

describe("Companion pre-start cancellation", () => {
  it("does not persist a new session or messages before run_start", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ariadne-prestart-cancel-"));
    const manager = new CompanionStorageManager(root);
    const searchStarted = deferred();
    const releaseSearch = deferred();
    class BlockingKnowledge extends CompanionKnowledgeService {
      override async searchMemoryVectors(
        storageRoot: Parameters<CompanionKnowledgeService["searchMemoryVectors"]>[0],
        input: Parameters<CompanionKnowledgeService["searchMemoryVectors"]>[1],
      ): ReturnType<CompanionKnowledgeService["searchMemoryVectors"]> {
        searchStarted.resolve();
        await releaseSearch.promise;
        return super.searchMemoryVectors(storageRoot, input);
      }
    }
    let modelCalls = 0;
    const workflow = new CompanionConversationWorkflow({
      storageManager: manager,
      knowledge: new BlockingKnowledge(manager),
      directChat: async (): Promise<ModelResponse> => {
        modelCalls += 1;
        return {
          content: "should not run",
          toolCalls: [],
          clientName: "test",
          modelName: "test",
          location: "local",
          latencyMs: 1,
        };
      },
    });
    const events: CompanionStreamEvent[] = [];
    const controller = new AbortController();

    try {
      const running = workflow.chatStream(
        { message: "cancel before persistence" },
        (event) => events.push(event),
        { signal: controller.signal },
      );
      await searchStarted.promise;
      controller.abort(new Error("startup cancelled"));
      releaseSearch.resolve();

      await expect(running).rejects.toThrow("startup cancelled");
      expect(events).toEqual([]);
      expect(modelCalls).toBe(0);
      expect(manager.get().listSessions()).toEqual([]);
    } finally {
      releaseSearch.resolve();
      workflow.close();
      manager.closeAll();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
