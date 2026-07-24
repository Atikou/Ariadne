import { z } from "zod";

import type { TraceLogger } from "../trace/TraceLogger.js";
import { ToolRegistry } from "./ToolRegistry.js";
import type { ToolContext, ToolContract, ToolPermission } from "./types.js";

export interface MockToolCall<TInput = unknown> {
  input: TInput;
  context: Pick<ToolContext, "workspaceRoot" | "taskId" | "sessionId" | "requestId" | "toolCallId">;
  at: string;
}

type MockToolOutputFactory<TInput, TOutput> = (
  input: TInput,
  context: ToolContext,
  calls: readonly MockToolCall<TInput>[],
) => TOutput | Promise<TOutput>;

type MockToolFailureFactory<TInput> = (
  input: TInput,
  context: ToolContext,
  calls: readonly MockToolCall<TInput>[],
) => string | Error | Promise<string | Error>;

export interface MockToolOptions<TInputSchema extends z.ZodTypeAny = z.ZodTypeAny, TOutput = unknown> {
  name: string;
  description?: string;
  inputSchema?: TInputSchema;
  outputSchema?: z.ZodTypeAny;
  permission?: ToolPermission;
  timeoutMs?: number;
  output?: TOutput | MockToolOutputFactory<z.infer<TInputSchema>, TOutput>;
  failWith?: string | Error | MockToolFailureFactory<z.infer<TInputSchema>>;
}

export interface MockTool<TInputSchema extends z.ZodTypeAny = z.ZodTypeAny, TOutput = unknown>
  extends ToolContract<TInputSchema, TOutput> {
  calls: MockToolCall<z.infer<TInputSchema>>[];
  reset(): void;
}

export interface CreateMockRegistryOptions {
  trace?: TraceLogger;
  defaultContext?: Partial<ToolContext>;
}

export function createMockTool<TInputSchema extends z.ZodTypeAny = z.ZodTypeAny, TOutput = unknown>(
  options: MockToolOptions<TInputSchema, TOutput>,
): MockTool<TInputSchema, TOutput> {
  const calls: MockToolCall<z.infer<TInputSchema>>[] = [];
  const inputSchema = (options.inputSchema ?? z.object({}).passthrough()) as TInputSchema;

  const tool: MockTool<TInputSchema, TOutput> = {
    name: options.name,
    version: "1.0.0",
    description: options.description ?? `Mock tool: ${options.name}`,
    inputSchema,
    outputSchema: options.outputSchema ?? z.unknown(),
    permissions: [options.permission ?? "read"],
    resourceScopes: ["workspace"],
    effects: options.permission === "read" || options.permission == null ? ["workspace_read"] : ["unknown"],
    risk: options.permission === "read" || options.permission == null ? "low" : "high",
    parallelism: options.permission === "read" || options.permission == null ? "parallel_safe" : "serial",
    idempotency: options.permission === "read" || options.permission == null ? "idempotent" : "non_idempotent",
    dataSensitivity: "workspace",
    egress: ["model"],
    timeoutMs: options.timeoutMs ?? 30_000,
    supportsResume: options.permission === "read" || options.permission == null,
    providerId: "mock",
    calls,
    reset() {
      calls.length = 0;
    },
    async execute(input, context) {
      calls.push({
        input,
        context: captureContext(context),
        at: new Date().toISOString(),
      });

      if (options.failWith !== undefined) {
        const failure =
          typeof options.failWith === "function"
            ? await options.failWith(input, context, calls)
            : options.failWith;
        throw typeof failure === "string" ? new Error(failure) : failure;
      }

      if (typeof options.output === "function") {
        const factory = options.output as MockToolOutputFactory<z.infer<TInputSchema>, TOutput>;
        return await factory(input, context, calls);
      }

      return (options.output ?? {}) as TOutput;
    },
  };

  return tool;
}

export function createMockRegistry(
  tools: readonly ToolContract[] = [],
  options: CreateMockRegistryOptions = {},
): ToolRegistry {
  const registry = new ToolRegistry(options.trace);
  if (options.defaultContext) registry.setDefaultContext(options.defaultContext);
  for (const tool of tools) registry.register(tool);
  return registry;
}

function captureContext(
  context: ToolContext,
): Pick<ToolContext, "workspaceRoot" | "taskId" | "sessionId" | "requestId" | "toolCallId"> {
  return {
    workspaceRoot: context.workspaceRoot,
    taskId: context.taskId,
    sessionId: context.sessionId,
    requestId: context.requestId,
    toolCallId: context.toolCallId,
  };
}
