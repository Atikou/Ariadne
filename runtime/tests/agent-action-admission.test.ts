import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  AgentProtocolRepairBudget,
  admitAgentModelAction,
  buildAgentProtocolRepairMessage,
} from "../src/agent/AgentActionAdmission.js";
import { WORKSPACE_READ_CONTRACT } from "../src/tools/contractProfiles.js";
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

function setup() {
  const registry = new ToolRegistry().register(echoTool);
  return { registry, allowedToolNames: new Set(["echo"]) };
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
