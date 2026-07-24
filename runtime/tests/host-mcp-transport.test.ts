import { describe, expect, it, vi } from "vitest";

import type { McpServerConfig } from "../src/config/types.js";
import type { HostCapabilityBroker } from "../src/host/HostCapabilityBroker.js";
import { HostMcpTransport } from "../src/mcp/HostMcpTransport.js";

const connectionId = "861ff28e-9b93-4eb7-8451-76dbb0bb3002";
const config: Extract<McpServerConfig, { transport: "streamable-http" }> = {
  id: "remote",
  enabled: true,
  trustAnnotations: false,
  transport: "streamable-http",
  endpoint: "https://mcp.example.test/messages",
  credentialRef: "mcp.remote",
};

describe("Host MCP transport", () => {
  it("moves JSON-RPC over opaque Main capability calls without receiving credentials", async () => {
    const operations: unknown[] = [];
    let receives = 0;
    const request = vi.fn(async (operation: { kind: string }) => {
      operations.push(operation);
      if (operation.kind === "mcp.remote.connect") return { connectionId };
      if (operation.kind === "mcp.remote.receive") {
        receives += 1;
        return receives === 1
          ? { messages: [{ jsonrpc: "2.0", id: 1, result: { ok: true } }], closed: false }
          : { messages: [], closed: true };
      }
      return {};
    });
    const broker: HostCapabilityBroker = { request };
    const transport = new HostMcpTransport(config, broker);
    const messages: unknown[] = [];
    transport.onmessage = (message) => messages.push(message);
    await transport.start();
    await transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    await vi.waitFor(() => expect(
      operations.some((operation) =>
        (operation as { kind?: string }).kind === "mcp.remote.close"),
    ).toBe(true));

    expect(operations[0]).toEqual({
      kind: "mcp.remote.connect",
      serverId: "remote",
      endpoint: "https://mcp.example.test/messages",
      credentialRef: "mcp.remote",
    });
    expect(JSON.stringify(operations)).not.toContain("access_token");
    expect(JSON.stringify(operations)).not.toContain("refresh_token");
  });
});
