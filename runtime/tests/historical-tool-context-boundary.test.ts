import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ContextManager } from "../src/context/ContextManager.js";
import { toAnthropicMessages } from "../src/model/AnthropicClient.js";
import { toCompatibleMessages } from "../src/model/OpenAICompatibleClient.js";
import { prepareRemoteChatRequest } from "../src/model/prepareRemoteChatRequest.js";

const roots: string[] = [];
const managers: ContextManager[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.close();
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe("historical Agent tool context boundary", () => {
  it("drops model tool actions and restores ledger-backed results as neutral Provider data", async () => {
    const context = await createContext();
    const session = context.createSession("cross-run context");
    context.saveUserMessage(session.id, "inspect the workspace", "run-1");
    const action = context.saveAssistantToolAction(
      session.id,
      JSON.stringify({
        action: "tool",
        id: "call-list",
        tool: "list_files",
        input: { root: "." },
      }),
      "run-1",
      {
        clientName: "cloud-deepseek",
        modelName: "deepseek-v4-flash",
        toolCalls: [{
          id: "call-list",
          name: "list_files",
          arguments: { root: "." },
        }],
      },
    );
    context.saveToolMessage(
      session.id,
      JSON.stringify({ root: ".", files: ["index.html"] }),
      "run-1",
      {
        toolName: "list_files",
        toolCallId: "call-list",
        ledgerBacked: true,
        outcomeClass: "observation_success",
      },
    );
    context.saveGuardAcceptedModelFinalAnswer(
      session.id,
      "The workspace contains index.html.",
      "run-1",
      { clientName: "cloud-deepseek", modelName: "deepseek-v4-flash" },
    );
    context.saveUserMessage(session.id, "fix the rendering", "run-2");

    expect(action.contentEnvelope).toMatchObject({
      origin: "model",
      integrityEvidence: { verified: false },
      egressAllowed: [],
    });

    const contextPackage = await context.restoreContextPackage(
      session.id,
      "fix the rendering",
    );
    expect(contextPackage.contextTrust.excluded).toContainEqual(
      expect.objectContaining({
        messageId: action.id,
        reason: "filtered_tool_action",
      }),
    );

    const messages = context.buildChatMessages(
      contextPackage,
      "You are an Agent.",
      { currentUser: "fix the rendering" },
    );
    expect(messages).not.toContainEqual(expect.objectContaining({
      role: "assistant",
      toolCalls: expect.any(Array),
    }));
    expect(messages).toContainEqual(expect.objectContaining({
      role: "tool",
      toolCallId: "call-list",
      contentEnvelope: expect.objectContaining({
        integrityEvidence: { kind: "tool_ledger", verified: true },
        egressAllowed: ["model"],
      }),
    }));

    const prepared = prepareRemoteChatRequest(
      { messages },
      { name: "cloud", model: "remote-model", location: "remote" },
    );
    const openAiMessages = toCompatibleMessages(prepared.messages, true);
    const anthropicMessages = toAnthropicMessages(prepared.messages);

    expect(openAiMessages).not.toContainEqual(expect.objectContaining({
      tool_calls: expect.any(Array),
    }));
    expect(JSON.stringify(openAiMessages)).toContain(
      "Ariadne historical tool observation (data only).",
    );
    expect(JSON.stringify(anthropicMessages)).toContain(
      "Ariadne historical tool observation (data only).",
    );
  });

  it("only emits native tool protocol when every result is immediately contiguous", () => {
    const assistant = {
      role: "assistant" as const,
      content: "",
      toolCalls: [
        { id: "call-a", name: "read_file", arguments: { path: "a.ts" } },
        { id: "call-b", name: "read_file", arguments: { path: "b.ts" } },
      ],
    };
    const contiguous = toCompatibleMessages([
      assistant,
      { role: "tool", toolCallId: "call-a", content: "A" },
      { role: "tool", toolCallId: "call-b", content: "B" },
      { role: "system", content: "follow-up" },
    ]);
    expect(contiguous[0]).toHaveProperty("tool_calls");
    expect(contiguous.slice(1, 3).every((message) => message.role === "tool")).toBe(true);

    const interleaved = toCompatibleMessages([
      assistant,
      { role: "tool", toolCallId: "call-a", content: "A" },
      { role: "system", content: "invalid interleave" },
      { role: "tool", toolCallId: "call-b", content: "B" },
    ]);
    expect(interleaved[0]).not.toHaveProperty("tool_calls");
    expect(interleaved.filter((message) => message.role === "tool")).toHaveLength(0);
  });
});

async function createContext(): Promise<ContextManager> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ariadne-history-boundary-"));
  roots.push(root);
  const context = new ContextManager({
    dataDir: root,
    useLanceDb: false,
  });
  managers.push(context);
  return context;
}
