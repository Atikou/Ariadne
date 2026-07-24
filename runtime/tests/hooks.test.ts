import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { DatabaseManager } from "../src/context/DatabaseManager.js";
import { HookManager } from "../src/hooks/HookManager.js";
import { HookedModelClient } from "../src/model/HookedModelClient.js";
import { createConservativeTokenCounter } from "../src/model/TokenCounter.js";
import { ToolRegistry } from "../src/tools/ToolRegistry.js";
import type { ToolContract } from "../src/tools/types.js";
import type { ModelClient } from "../src/model/types.js";

const roots: string[] = [];
const databases: DatabaseManager[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable lifecycle hooks", () => {
  it("deduplicates pre/post delivery IDs and never executes the same hook twice", async () => {
    const { hooks, registry } = await fixture();
    const handler = vi.fn(async () => ({ decision: "allow" as const }));
    hooks.register({
      id: "audit",
      version: "1",
      events: ["tool.pre", "tool.post"],
      timeoutMs: 100,
      failurePolicy: "fail-closed",
      handler,
    });

    for (let index = 0; index < 2; index += 1) {
      const result = await registry.run("fixture_read", {}, {
        workspaceRoot: process.cwd(),
        allowedPermissions: ["read"],
        toolCallId: "stable-call",
      });
      expect(result.ok).toBe(true);
    }
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("applies fail-closed timeout and fail-open timeout exactly as declared", async () => {
    const closed = await fixture();
    closed.hooks.register({
      id: "closed",
      version: "1",
      events: ["tool.pre"],
      timeoutMs: 5,
      failurePolicy: "fail-closed",
      handler: () => new Promise(() => undefined),
    });
    const denied = await closed.registry.run("fixture_read", {}, {
      workspaceRoot: process.cwd(),
      allowedPermissions: ["read"],
    });
    expect(denied.code).toBe("permission_denied");
    expect(denied.message).toContain("hook_failed_closed");

    const open = await fixture();
    open.hooks.register({
      id: "open",
      version: "1",
      events: ["tool.pre"],
      timeoutMs: 5,
      failurePolicy: "fail-open",
      handler: () => new Promise(() => undefined),
    });
    const allowed = await open.registry.run("fixture_read", {}, {
      workspaceRoot: process.cwd(),
      allowedPermissions: ["read"],
    });
    expect(allowed.ok).toBe(true);
  });

  it("allows authority narrowing but rejects permission or timeout expansion", async () => {
    const narrowed = await fixture(25);
    narrowed.hooks.register({
      id: "narrow",
      version: "1",
      events: ["tool.pre"],
      timeoutMs: 100,
      failurePolicy: "fail-closed",
      async handler() {
        return { decision: "allow", constraints: { timeoutMs: 5, permissions: ["read"] } };
      },
    });
    const timedOut = await narrowed.registry.run("fixture_read", {}, {
      workspaceRoot: process.cwd(),
      allowedPermissions: ["read", "network"],
    });
    expect(timedOut.code).toBe("timeout");

    const expanded = await fixture();
    expanded.hooks.register({
      id: "expand",
      version: "1",
      events: ["tool.pre"],
      timeoutMs: 100,
      failurePolicy: "fail-closed",
      async handler() {
        return { decision: "allow", constraints: { permissions: ["read", "dangerous"] } };
      },
    });
    const denied = await expanded.registry.run("fixture_read", {}, {
      workspaceRoot: process.cwd(),
      allowedPermissions: ["read"],
    });
    expect(denied.code).toBe("permission_denied");
    expect(denied.message).toContain("hook_authority_expansion_denied");
  });

  it("applies configured model hooks to a real ModelClient boundary", async () => {
    const { hooks } = await fixture();
    hooks.registerConfigured({
      definitions: [{
        id: "deny_remote_model",
        version: "1",
        events: ["model.pre"],
        timeoutMs: 100,
        failurePolicy: "fail-closed",
        decision: "reject",
        reason: "model_policy_denied",
      }],
    });
    const innerChat = vi.fn<ModelClient["chat"]>();
    const client = new HookedModelClient(fakeModel(innerChat), hooks);

    await expect(client.chat({
      messages: [{ role: "user", content: "hello" }],
    })).rejects.toThrow("model_policy_denied");
    expect(innerChat).not.toHaveBeenCalled();
  });

  it("delivers model pre/post once per actual call", async () => {
    const { hooks } = await fixture();
    const handler = vi.fn(async () => ({ decision: "allow" as const }));
    hooks.register({
      id: "model_audit",
      version: "1",
      events: ["model.pre", "model.post"],
      timeoutMs: 100,
      failurePolicy: "fail-closed",
      handler,
    });
    const client = new HookedModelClient(
      fakeModel(async () => ({
        content: "ok",
        toolCalls: [],
        clientName: "fixture",
        modelName: "fixture-model",
        location: "local",
        latencyMs: 1,
      })),
      hooks,
    );

    await expect(client.chat({
      messages: [{ role: "user", content: "hello" }],
    })).resolves.toMatchObject({ content: "ok" });
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

function fakeModel(chat: ModelClient["chat"]): ModelClient {
  return {
    name: "fixture",
    location: "local",
    model: "fixture-model",
    tokenCounter: createConservativeTokenCounter("fixture"),
    async isAvailable() { return true; },
    chat,
  };
}

async function fixture(executionDelayMs = 0): Promise<{
  hooks: HookManager;
  registry: ToolRegistry;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ariadne-hooks-"));
  roots.push(root);
  const database = new DatabaseManager(root);
  databases.push(database);
  const hooks = new HookManager(database.connection);
  const registry = new ToolRegistry().setHookManager(hooks);
  const tool: ToolContract = {
    name: "fixture_read",
    version: "1",
    description: "fixture",
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ ok: z.literal(true) }).strict(),
    permissions: ["read"],
    resourceScopes: ["workspace"],
    effects: ["workspace_read"],
    risk: "low",
    parallelism: "parallel_safe",
    idempotency: "idempotent",
    dataSensitivity: "workspace",
    egress: ["model"],
    timeoutMs: 100,
    supportsResume: true,
    providerId: "builtin",
    async execute() {
      if (executionDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, executionDelayMs));
      }
      return { ok: true };
    },
  };
  registry.register(tool);
  return { hooks, registry };
}
