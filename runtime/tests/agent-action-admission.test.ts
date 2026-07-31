import path from "node:path";

import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  AgentProtocolRepairBudget,
  admitAgentModelAction,
  buildAgentProtocolRepairMessage,
} from "../src/agent/AgentActionAdmission.js";
import {
  WORKSPACE_READ_CONTRACT,
  WORKSPACE_WRITE_CONTRACT,
} from "../src/tools/contractProfiles.js";
import { ToolRegistry } from "../src/tools/ToolRegistry.js";
import type { ToolContract } from "../src/tools/types.js";

const echoInput = z.object({ value: z.string().min(1) }).strict();
const echoOutput = z.object({ value: z.string() }).strict();
const echoTool: ToolContract<typeof echoInput, z.output<typeof echoOutput>> = {
  ...WORKSPACE_READ_CONTRACT,
  name: "echo",
  description: "Echo a value.",
  inputSchema: echoInput,
  outputSchema: echoOutput,
  providerId: "test",
  execute: async (input) => input,
};
const writeTool: ToolContract<typeof echoInput, z.output<typeof echoOutput>> = {
  ...WORKSPACE_WRITE_CONTRACT,
  name: "write_echo",
  description: "Write a value.",
  inputSchema: echoInput,
  outputSchema: echoOutput,
  providerId: "test",
  execute: async (input) => input,
};
const readPathInput = z.object({ path: z.string().min(1) }).strict();
const readPathTool: ToolContract<typeof readPathInput, z.output<typeof echoOutput>> = {
  ...WORKSPACE_READ_CONTRACT,
  name: "read_path",
  description: "Read a path.",
  inputSchema: readPathInput,
  outputSchema: echoOutput,
  providerId: "test",
  execute: async (input) => ({ value: input.path }),
};

function setup() {
  const registry = new ToolRegistry().register(echoTool).register(writeTool);
  return { registry, allowedToolNames: new Set(["echo", "write_echo"]) };
}

describe("AgentAction admission", () => {
  it("normalizes native tool calling and text JSON fallback to the same AgentAction", () => {
    const common = setup();
    const fallback = admitAgentModelAction({
      ...common,
      content: JSON.stringify({ action: "tool", tool: "echo", input: { value: "ok" } }),
    });
    const native = admitAgentModelAction({
      ...common,
      content: "",
      nativeToolCalls: [{ id: "call-1", name: "echo", arguments: '{"value":"ok"}' }],
    });

    expect(fallback).toMatchObject({
      ok: true,
      action: { action: "tool", tool: "echo", input: { value: "ok" } },
    });
    expect(native).toMatchObject({
      ok: true,
      action: { action: "tool", tool: "echo", input: { value: "ok" } },
    });
  });

  it("classifies unknown tools and invalid arguments before execution", () => {
    const common = setup();
    expect(admitAgentModelAction({
      ...common,
      content: JSON.stringify({ action: "tool", tool: "missing", input: {} }),
    })).toMatchObject({ ok: false, category: "unknown_tool" });
    expect(admitAgentModelAction({
      ...common,
      content: JSON.stringify({ action: "tool", tool: "echo", input: { value: 1 } }),
    })).toMatchObject({ ok: false, category: "argument_error" });
  });

  it("admits batched pure observations but rejects side effects before any tool executes", () => {
    const common = setup();
    expect(admitAgentModelAction({
      ...common,
      content: "",
      nativeToolCalls: [
        { id: "read-1", name: "echo", arguments: '{"value":"a"}' },
        { id: "read-2", name: "echo", arguments: '{"value":"b"}' },
      ],
    })).toMatchObject({ ok: true, action: { action: "tools" } });

    expect(admitAgentModelAction({
      ...common,
      content: "",
      nativeToolCalls: [
        { id: "write-1", name: "write_echo", arguments: '{"value":"a"}' },
        { id: "read-1", name: "echo", arguments: '{"value":"b"}' },
      ],
    })).toMatchObject({
      ok: false,
      category: "unsafe_tool_batch",
    });
  });

  it("rejects a parallel read batch that could pause for cross-workspace permission", () => {
    const registry = new ToolRegistry().register(readPathTool);
    const workspaceRoot = path.resolve("E:\\workspace");
    expect(admitAgentModelAction({
      content: "",
      nativeToolCalls: [
        { id: "inside", name: "read_path", arguments: '{"path":"src/index.ts"}' },
        { id: "outside", name: "read_path", arguments: '{"path":"E:\\\\outside\\\\secret.ts"}' },
      ],
      registry,
      allowedToolNames: new Set(["read_path"]),
      workspaceRoot,
    })).toMatchObject({
      ok: false,
      category: "unsafe_tool_batch",
    });
  });

  it("allows at most two side-effect-free repair turns and never echoes raw model content", () => {
    const budget = new AgentProtocolRepairBudget();
    expect([budget.consume(), budget.consume(), budget.consume()]).toEqual([true, true, false]);

    const message = buildAgentProtocolRepairMessage({
      failure: { ok: false, category: "format_error", issues: ["invalid JSON"] },
      allowedToolNames: ["echo"],
    });
    expect(message).toContain("允许动作: final, tool, tools");
    expect(message).toContain("允许工具: echo");
    expect(message).not.toContain("ignore previous instructions");
  });
});
