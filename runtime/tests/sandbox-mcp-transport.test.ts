import { afterEach, describe, expect, it, vi } from "vitest";

import type { McpServerConfig } from "../src/config/types.js";
import { SandboxMcpTransport } from "../src/mcp/SandboxMcpTransport.js";
import type {
  InteractiveProcessSandbox,
  SandboxFileRequest,
  SandboxProcessLease,
  SandboxProcessObserver,
} from "../src/sandbox/ProcessSandbox.js";
import type { SandboxExecutionResult } from "../src/sandbox/SandboxContracts.js";

afterEach(() => vi.unstubAllEnvs());

describe("sandbox MCP stdio transport", () => {
  it("uses an interactive sandbox lease, bounded stdin frames, and NDJSON messages", async () => {
    vi.stubEnv("ARIADNE_MCP_FIXTURE", "allowed-value");
    vi.stubEnv("ARIADNE_MCP_BLOCKED", "blocked-value");
    const sandbox = new FakeInteractiveSandbox();
    const config: Extract<McpServerConfig, { transport: "stdio" }> = {
      id: "fixture",
      enabled: true,
      trustAnnotations: false,
      transport: "stdio",
      command: "fixture-mcp.exe",
      args: ["--stdio"],
      environmentAllowlist: ["ARIADNE_MCP_FIXTURE"],
      workspaceAccess: "read",
      networkAccess: "offline",
    };
    const transport = new SandboxMcpTransport(config, process.cwd(), sandbox);
    const onmessage = vi.fn();
    const onclose = vi.fn();
    transport.onmessage = onmessage;
    transport.onclose = onclose;

    await transport.start();
    expect(sandbox.request).toMatchObject({
      file: "fixture-mcp.exe",
      args: ["--stdio"],
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      mode: "read-only",
      networkMode: "offline",
      environment: { ARIADNE_MCP_FIXTURE: "allowed-value" },
    });
    expect(sandbox.request?.environment).not.toHaveProperty("ARIADNE_MCP_BLOCKED");

    await transport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "fixture",
      params: { value: "x".repeat(150_000) },
    });
    expect(sandbox.stdinChunks.every((chunk) => chunk.byteLength <= 64 * 1024)).toBe(true);
    expect(Buffer.concat(sandbox.stdinChunks).toString("utf8")).toContain("\"method\":\"fixture\"");

    sandbox.emitStdout(Buffer.from(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n`,
      "utf8",
    ));
    expect(onmessage).toHaveBeenCalledWith({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
    });

    await transport.close();
    expect(sandbox.cancelled).toBe(true);
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it("surfaces an unexpected MCP server exit and closes the lease", async () => {
    const sandbox = new FakeInteractiveSandbox();
    const transport = new SandboxMcpTransport({
      id: "crash",
      enabled: true,
      trustAnnotations: false,
      transport: "stdio",
      command: "crashing-mcp.exe",
      args: [],
      environmentAllowlist: [],
      workspaceAccess: "read",
      networkAccess: "offline",
    }, process.cwd(), sandbox);
    const onerror = vi.fn();
    const onclose = vi.fn();
    transport.onerror = onerror;
    transport.onclose = onclose;
    await transport.start();
    sandbox.finish(9);
    await vi.waitFor(() => expect(onclose).toHaveBeenCalledOnce());
    expect(onerror).toHaveBeenCalledWith(
      expect.objectContaining({ message: "mcp_stdio_server_exit:9" }),
    );
  });
});

class FakeInteractiveSandbox implements InteractiveProcessSandbox {
  readonly mode = "workspace-write" as const;
  request?: SandboxFileRequest;
  observer?: SandboxProcessObserver;
  stdinChunks: Buffer[] = [];
  cancelled = false;
  private finishLease?: (result: SandboxExecutionResult) => void;

  openFileLease(
    input: SandboxFileRequest,
    observer?: SandboxProcessObserver,
  ): SandboxProcessLease {
    this.request = structuredClone(input);
    this.observer = observer;
    const completion = new Promise<SandboxExecutionResult>((resolve) => {
      this.finishLease = resolve;
    });
    return {
      executionId: "fixture-lease",
      completion,
      cancel: () => {
        this.cancelled = true;
      },
      writeStdin: async (chunk) => {
        this.stdinChunks.push(Buffer.from(chunk));
      },
      endStdin: async () => undefined,
    };
  }

  emitStdout(chunk: Buffer): void {
    this.observer?.onStdout?.(chunk);
  }

  finish(exitCode: number): void {
    this.finishLease?.({
      executionId: "fixture-lease",
      exitCode,
      stdout: "",
      stderr: "",
      timedOut: false,
      truncated: false,
      spawnFailed: false,
      isolation: {
        backend: "windows-native",
        enforced: true,
        mode: "read-only",
        networkMode: "offline",
        account: "offline",
        restrictedToken: true,
        filesystemAcl: true,
        appContainer: true,
        filesystemReadRestricted: true,
        credentialIsolation: true,
        publicObjectWriteRestricted: true,
        firewall: true,
        jobObject: true,
        privateDesktop: true,
        environment: "allowlist",
        processTreeTermination: true,
      },
    });
  }

  startShell(): never {
    throw new Error("not used");
  }

  startFile(): never {
    throw new Error("not used");
  }

  runShell(): never {
    throw new Error("not used");
  }

  runFile(): never {
    throw new Error("not used");
  }
}
