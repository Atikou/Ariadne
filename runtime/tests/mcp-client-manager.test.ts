import { describe, expect, it, vi } from "vitest";

import { AppConfigSchema, type McpServerConfig } from "../src/config/types.js";
import {
  McpClientManager,
  type McpClientConnection,
  type McpToolDefinition,
} from "../src/mcp/McpClientManager.js";
import { ToolRegistry } from "../src/tools/ToolRegistry.js";

const dangerousServer: McpServerConfig = {
  id: "fixture",
  enabled: true,
  trustAnnotations: false,
  transport: "stdio",
  command: "fixture",
  args: [],
  environmentAllowlist: [],
  workspaceAccess: "read",
  networkAccess: "offline",
};

describe("MCP client manager", () => {
  it("fails closed instead of launching an unsandboxed STDIO process", async () => {
    const manager = new McpClientManager(
      new ToolRegistry(),
      [dangerousServer],
      process.cwd(),
    );

    await expect(manager.start()).rejects.toThrow(
      "mcp_stdio_sandbox_broker_required:fixture",
    );
  });

  it("maps untrusted tools to dangerous, serial, non-resumable ToolContracts", async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "external result" }] }));
    const connection = fakeConnection([fixtureTool()], callTool);
    const registry = new ToolRegistry();
    const manager = new McpClientManager(
      registry,
      [dangerousServer],
      process.cwd(),
      async () => connection,
    );
    await manager.start();

    const contract = registry.get("mcp_fixture_lookup");
    expect(contract).toMatchObject({
      permissions: ["dangerous"],
      effects: ["unknown"],
      risk: "critical",
      parallelism: "serial",
      idempotency: "non_idempotent",
      supportsResume: false,
      providerId: "mcp:fixture",
    });

    const invalid = await registry.run("mcp_fixture_lookup", {}, {
      workspaceRoot: process.cwd(),
      allowedPermissions: ["dangerous"],
    });
    expect(invalid.code).toBe("invalid_input");
    expect(callTool).not.toHaveBeenCalled();

    const valid = await registry.run("mcp_fixture_lookup", { query: "Ariadne" }, {
      workspaceRoot: process.cwd(),
      allowedPermissions: ["dangerous"],
    });
    expect(valid.ok).toBe(true);
    expect(valid.output).toMatchObject({
      envelope: {
        origin: "mcp",
        instructionAuthority: "data",
        externalContent: true,
      },
    });
    await manager.stop();
  });

  it("uses explicitly trusted complete read-only annotations without making MCP parallel", async () => {
    const server: McpServerConfig = { ...dangerousServer, trustAnnotations: true };
    const connection = fakeConnection([fixtureTool({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    })]);
    const registry = new ToolRegistry();
    const manager = new McpClientManager(registry, [server], process.cwd(), async () => connection);
    await manager.start();

    expect(registry.get("mcp_fixture_lookup")).toMatchObject({
      permissions: ["read"],
      effects: ["none"],
      risk: "medium",
      parallelism: "serial",
      idempotency: "idempotent",
    });
    await manager.stop();
  });

  it("replaces the provider as one unit after a tools/list_changed notification", async () => {
    let notify: ((error: Error | undefined, tools?: McpToolDefinition[]) => void) | undefined;
    const connection = fakeConnection([fixtureTool()]);
    const registry = new ToolRegistry();
    const manager = new McpClientManager(
      registry,
      [dangerousServer],
      process.cwd(),
      async (_config, _root, onChanged) => {
        notify = onChanged;
        return connection;
      },
    );
    await manager.start();

    notify?.(undefined, [{
      ...fixtureTool(),
      name: "search",
    }]);
    expect(registry.get("mcp_fixture_lookup")).toBeUndefined();
    expect(registry.get("mcp_fixture_search")).toBeDefined();
    await manager.stop();
  });

  it("rejects insecure remote endpoints and legacy SSE configuration", () => {
    const base = {
      workspaceRoot: ".",
      models: {
        default: "auto",
        directory: "../Models",
        autoDiscover: false,
        watch: false,
        loadPolicy: "lazy" as const,
        maxLoadedModels: 1,
        idleUnloadMs: 10_000,
        clients: [],
      },
      routing: { strategy: "privacy-first" as const, fallback: false },
    };
    expect(AppConfigSchema.safeParse({
      ...base,
      mcp: {
        legacySseFallback: false,
        servers: [{
          id: "remote",
          transport: "streamable-http",
          endpoint: "http://localhost:3000/mcp",
        }],
      },
    }).success).toBe(false);
    expect(AppConfigSchema.safeParse({
      ...base,
      mcp: { legacySseFallback: true, servers: [] },
    }).success).toBe(false);
  });
});

function fixtureTool(
  annotations?: McpToolDefinition["annotations"],
): McpToolDefinition {
  return {
    name: "lookup",
    description: "lookup",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    annotations,
  };
}

function fakeConnection(
  tools: McpToolDefinition[],
  callTool: McpClientConnection["callTool"] = async () => ({ content: [] }),
): McpClientConnection {
  return {
    async listTools() { return { tools }; },
    callTool,
    async close() {},
  };
}
