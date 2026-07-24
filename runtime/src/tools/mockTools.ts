import { z } from "zod";

import type { TraceLogger } from "../trace/TraceLogger.js";
import { ToolRegistry } from "./ToolRegistry.js";
import type { Tool, ToolContext, ToolPermission } from "./types.js";

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
  permission?: ToolPermission;
  hasSideEffect?: boolean;
  timeoutMs?: number;
  output?: TOutput | MockToolOutputFactory<z.infer<TInputSchema>, TOutput>;
  failWith?: string | Error | MockToolFailureFactory<z.infer<TInputSchema>>;
}

export interface MockTool<TInputSchema extends z.ZodTypeAny = z.ZodTypeAny, TOutput = unknown>
  extends Tool<TInputSchema, TOutput> {
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
    description: options.description ?? `Mock tool: ${options.name}`,
    inputSchema,
    permission: options.permission ?? "read",
    hasSideEffect: options.hasSideEffect ?? false,
    timeoutMs: options.timeoutMs,
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
  tools: readonly Tool[] = [],
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
