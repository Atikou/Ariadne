import { z } from "zod";
import { describe, expect, it } from "vitest";

import { ToolRegistry } from "../src/tools/ToolRegistry.js";
import type { ToolContract } from "../src/tools/types.js";

const inputSchema = z
  .object({
    mode: z.enum(["fast", "safe"]),
    target: z
      .object({
        path: z.string().min(1),
        line: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

const outputSchema = z
  .object({
    ok: z.literal(true),
    result: z
      .object({
        changed: z.boolean(),
      })
      .strict(),
  })
  .strict();

function contract(
  execute: ToolContract<typeof inputSchema, z.output<typeof outputSchema>>["execute"],
): ToolContract<typeof inputSchema, z.output<typeof outputSchema>> {
  return {
    name: "contract_test",
    version: "1.0.0",
    description: "Validate the complete tool contract.",
    inputSchema,
    outputSchema,
    permissions: ["read"],
    resourceScopes: ["workspace"],
    effects: ["workspace_read"],
    risk: "low",
    parallelism: "parallel_safe",
    idempotency: "idempotent",
    dataSensitivity: "workspace",
    egress: ["model"],
    timeoutMs: 1_000,
    supportsResume: true,
    providerId: "test",
    execute,
  };
}

describe("ToolContract", () => {
  it("derives nested Provider JSON Schema from the input Zod schema", () => {
    const registry = new ToolRegistry();
    registry.register(contract(async () => ({ ok: true, result: { changed: false } })));

    expect(registry.list()).toEqual([
      expect.objectContaining({
        name: "contract_test",
        version: "1.0.0",
        providerId: "test",
        inputJsonSchema: expect.objectContaining({
          type: "object",
          additionalProperties: false,
          required: ["mode", "target"],
          properties: expect.objectContaining({
            mode: expect.objectContaining({ enum: ["fast", "safe"] }),
            target: expect.objectContaining({
              type: "object",
              additionalProperties: false,
              required: ["path", "line"],
            }),
          }),
        }),
      }),
    ]);
  });

  it("rejects unknown, missing, and invalid enum input before execution", async () => {
    const registry = new ToolRegistry();
    registry.register(contract(async () => ({ ok: true, result: { changed: false } })));

    for (const input of [
      { mode: "unsafe", target: { path: "file.ts", line: 1 } },
      { mode: "safe", target: { path: "file.ts" } },
      { mode: "safe", target: { path: "file.ts", line: 1 }, unknown: true },
    ]) {
      await expect(
        registry.run("contract_test", input, {
          workspaceRoot: process.cwd(),
          allowedPermissions: ["read"],
        }),
      ).resolves.toMatchObject({ ok: false, code: "invalid_input", executed: false });
    }
  });

  it("validates tool output and fails closed when implementation output violates the contract", async () => {
    const registry = new ToolRegistry();
    registry.register(
      contract(async () => ({ ok: true, result: { changed: "yes" } } as never)),
    );

    await expect(
      registry.run(
        "contract_test",
        { mode: "safe", target: { path: "file.ts", line: 1 } },
        { workspaceRoot: process.cwd(), allowedPermissions: ["read"] },
      ),
    ).resolves.toMatchObject({
      ok: false,
      code: "invalid_output",
      executed: true,
    });
  });

  it("rejects registrations that omit mandatory safety metadata", () => {
    const registry = new ToolRegistry();
    expect(() =>
      registry.register({
        name: "incomplete",
        description: "Missing contract metadata",
        inputSchema: z.object({}).strict(),
        execute: async () => ({}),
      } as never),
    ).toThrow("tool_contract_invalid");
  });
});
