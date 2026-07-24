import path from "node:path";

import Ajv, { type ValidateFunction } from "ajv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";

import type { McpServerConfig } from "../config/types.js";
import type { ContentEnvelope } from "../core/ContentEnvelope.js";
import type { ToolProvider } from "../tools/ToolProvider.js";
import type { ToolContract } from "../tools/types.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ProcessSandbox } from "../sandbox/ProcessSandbox.js";
import type { HostCapabilityBroker } from "../host/HostCapabilityBroker.js";
import { HostMcpTransport } from "./HostMcpTransport.js";
import { SandboxMcpTransport } from "./SandboxMcpTransport.js";

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown> & { type: "object" };
  outputSchema?: Record<string, unknown> & { type: "object" };
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface McpClientConnection {
  listTools(): Promise<{ tools: McpToolDefinition[] }>;
  callTool(input: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<unknown>;
  close(): Promise<void>;
}

export type McpConnectionFactory = (
  config: McpServerConfig,
  _workspaceRoot: string,
  onToolsChanged: (error: Error | undefined, tools?: McpToolDefinition[]) => void,
  processSandbox?: ProcessSandbox,
  hostCapabilities?: HostCapabilityBroker,
) => Promise<McpClientConnection>;

interface ActiveServer {
  connection: McpClientConnection;
  providerId: string;
}

/**
 * Owns MCP connection lifecycles and converts every discovered tool into the
 * same ToolContract used by built-ins. Registry refresh is atomic at provider
 * granularity: an invalid replacement never leaves a partially registered set.
 */
export class McpClientManager {
  private readonly active = new Map<string, ActiveServer>();

  constructor(
    private readonly registry: ToolRegistry,
    private readonly servers: readonly McpServerConfig[],
    private readonly workspaceRoot: string,
    private readonly connectionFactory: McpConnectionFactory = createOfficialMcpConnection,
    private readonly processSandbox?: ProcessSandbox,
    private readonly hostCapabilities?: HostCapabilityBroker,
  ) {}

  async start(): Promise<void> {
    for (const server of this.servers) {
      if (!server.enabled) continue;
      await this.connect(server);
    }
  }

  async stop(): Promise<void> {
    for (const [serverId, active] of this.active) {
      this.registry.unregisterProvider(active.providerId);
      await active.connection.close();
      this.active.delete(serverId);
    }
  }

  private async connect(config: McpServerConfig): Promise<void> {
    const providerId = `mcp:${config.id}`;
    const connection = await this.connectionFactory(
      config,
      this.workspaceRoot,
      (error, tools) => {
        if (error || !tools) return;
        this.replaceProvider(config, connection, tools);
      },
      this.processSandbox,
      this.hostCapabilities,
    );
    const { tools } = await connection.listTools();
    this.replaceProvider(config, connection, tools);
    this.active.set(config.id, { connection, providerId });
  }

  private replaceProvider(
    config: McpServerConfig,
    connection: McpClientConnection,
    definitions: McpToolDefinition[],
  ): void {
    const provider = new McpToolProvider(config, connection, definitions);
    if (this.active.has(config.id)) this.registry.replaceProvider(provider);
    else this.registry.registerProvider(provider);
    const active = this.active.get(config.id);
    if (active) this.active.set(config.id, { ...active, providerId: provider.id });
  }
}

export class McpToolProvider implements ToolProvider {
  readonly id: string;
  private readonly tools: ToolContract[];

  constructor(
    config: McpServerConfig,
    connection: McpClientConnection,
    definitions: readonly McpToolDefinition[],
  ) {
    this.id = `mcp:${config.id}`;
    const names = new Set<string>();
    this.tools = definitions.map((definition) => {
      const publicName = mcpToolName(config.id, definition.name);
      if (names.has(publicName)) throw new Error(`mcp_tool_name_collision:${publicName}`);
      names.add(publicName);
      return mcpToolContract(config, connection, definition, publicName);
    });
  }

  listTools(): readonly ToolContract[] {
    return this.tools;
  }
}

async function createOfficialMcpConnection(
  config: McpServerConfig,
  workspaceRoot: string,
  onToolsChanged: (error: Error | undefined, tools?: McpToolDefinition[]) => void,
  processSandbox?: ProcessSandbox,
  hostCapabilities?: HostCapabilityBroker,
): Promise<McpClientConnection> {
  const client = new Client(
    { name: "Ariadne", version: "2.0" },
    {
      capabilities: {},
      listChanged: {
        tools: {
          onChanged: (error, tools) =>
            onToolsChanged(error ? asError(error) : undefined, tools as McpToolDefinition[] | undefined),
        },
      },
    },
  );

  if (config.transport === "stdio") {
    if (!processSandbox) throw new Error(`mcp_stdio_sandbox_broker_required:${config.id}`);
    await client.connect(new SandboxMcpTransport(config, workspaceRoot, processSandbox));
  } else {
    if (!hostCapabilities) throw new Error(`mcp_remote_host_broker_required:${config.id}`);
    await client.connect(new HostMcpTransport(config, hostCapabilities));
  }
  return client as McpClientConnection;
}

function mcpToolContract(
  config: McpServerConfig,
  connection: McpClientConnection,
  definition: McpToolDefinition,
  publicName: string,
): ToolContract {
  const annotations = config.trustAnnotations ? definition.annotations : undefined;
  const readOnly = annotations?.readOnlyHint === true
    && annotations.destructiveHint === false
    && annotations.openWorldHint === false;
  const inputSchema = jsonSchemaToZod(definition.inputSchema);
  const outputSchema = z.object({
    result: z.unknown(),
    envelope: contentEnvelopeSchema,
  }).strict();

  return {
    name: publicName,
    version: "1.0.0",
    description: definition.description ?? definition.annotations?.title ?? `MCP tool ${definition.name}`,
    inputSchema,
    outputSchema,
    permissions: readOnly ? ["read"] : ["dangerous"],
    resourceScopes: ["external"],
    effects: readOnly ? ["none"] : ["unknown"],
    risk: readOnly ? "medium" : "critical",
    parallelism: "serial",
    idempotency: annotations?.idempotentHint === true ? "idempotent" : "non_idempotent",
    dataSensitivity: "sensitive",
    egress: ["model", "network"],
    timeoutMs: 30_000,
    supportsResume: false,
    providerId: `mcp:${config.id}`,
    async execute(input) {
      const result = await connection.callTool({
        name: definition.name,
        arguments: input as Record<string, unknown>,
      });
      return {
        result,
        envelope: {
          origin: "mcp",
          provenance: { providerId: `mcp:${config.id}`, sourceId: definition.name },
          integrityEvidence: { kind: "unverified", verified: false },
          instructionAuthority: "data",
          dataSensitivity: "sensitive",
          externalContent: true,
          egressAllowed: ["model"],
        } satisfies ContentEnvelope,
      };
    },
  };
}

const contentEnvelopeSchema = z.object({
  origin: z.literal("mcp"),
  provenance: z.object({
    providerId: z.string(),
    sourceId: z.string(),
  }).strict(),
  integrityEvidence: z.object({
    kind: z.literal("unverified"),
    verified: z.literal(false),
  }).strict(),
  instructionAuthority: z.literal("data"),
  dataSensitivity: z.literal("sensitive"),
  externalContent: z.literal(true),
  egressAllowed: z.array(z.literal("model")),
}).strict();

function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodType<Record<string, unknown>> {
  const ajv = new Ajv({ allErrors: true, strict: false });
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(schema);
  } catch (error) {
    throw new Error(`mcp_invalid_json_schema:${asError(error).message}`);
  }
  return z.record(z.string(), z.unknown()).superRefine((value, context) => {
    if (validate(value)) return;
    context.addIssue({
      code: "custom",
      message: validate.errors?.map((error) =>
        `${error.instancePath || "(root)"} ${error.message ?? "invalid"}`).join("; ")
        ?? "MCP tool input does not match its JSON Schema",
    });
  });
}

function mcpToolName(serverId: string, name: string): string {
  const normalized = `${serverId}_${name}`
    .toLowerCase()
    .replace(/[^a-z0-9_]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return `mcp_${normalized || "tool"}`;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function resolveMcpWorkspaceRoot(workspaceRoot: string): string {
  return path.resolve(workspaceRoot);
}
