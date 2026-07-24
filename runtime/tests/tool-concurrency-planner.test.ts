import { z } from "zod";
import { describe, expect, it } from "vitest";

import { planToolExecutionBatches } from "../src/agent/ToolConcurrencyPlanner.js";
import { WORKSPACE_READ_CONTRACT, WORKSPACE_WRITE_CONTRACT } from "../src/tools/contractProfiles.js";
import { ToolRegistry } from "../src/tools/ToolRegistry.js";
import type { ToolContract } from "../src/tools/types.js";

const inputSchema = z.object({ path: z.string() }).strict();
const outputSchema = z.object({ ok: z.boolean() }).strict();

function tool(
  name: string,
  profile: typeof WORKSPACE_READ_CONTRACT | typeof WORKSPACE_WRITE_CONTRACT,
): ToolContract<typeof inputSchema, z.output<typeof outputSchema>> {
  return {
    ...profile,
    name,
    description: name,
    inputSchema,
    outputSchema,
    providerId: "test",
    execute: async () => ({ ok: true }),
  };
}

describe("tool concurrency planner", () => {
  it("runs independent safe reads in groups of at most four", () => {
    const registry = new ToolRegistry().register(tool("read", WORKSPACE_READ_CONTRACT));
    const actions = ["a", "b", "c", "d", "e"].map((path) => ({
      action: "tool" as const,
      tool: "read",
      input: { path },
    }));
    expect(planToolExecutionBatches(actions, registry)).toEqual([[0, 1, 2, 3], [4]]);
  });

  it("serializes resource conflicts and every write", () => {
    const registry = new ToolRegistry()
      .register(tool("read", WORKSPACE_READ_CONTRACT))
      .register(tool("write", WORKSPACE_WRITE_CONTRACT));
    expect(planToolExecutionBatches([
      { action: "tool", tool: "read", input: { path: "src" } },
      { action: "tool", tool: "read", input: { path: "src/index.ts" } },
      { action: "tool", tool: "write", input: { path: "out.ts" } },
      { action: "tool", tool: "read", input: { path: "tests/a.ts" } },
    ], registry)).toEqual([[0], [1], [2], [3]]);
  });
});
