import type { ContextManager } from "../context/ContextManager.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { AgentIntentType } from "./IntentTypes.js";
import type { ToolPermission } from "../core/permissions.js";
import type { ProcessSandbox } from "../sandbox/ProcessSandbox.js";
import type { UserPermissionPolicy, RunBudget } from "./RunPolicyTypes.js";
import type { AgentToolStep } from "./toolStep.js";
import { toolStepPayloadForContext } from "./toolStepOutcome.js";
import { ToolExecutionGateway } from "./ToolExecutionGateway.js";
import { defaultWorkflowRouter } from "./WorkflowRouter.js";
export interface RunVerifyWorkflowOptions {
  registry: ToolRegistry;
  workspaceRoot: string;
  processSandbox?: ProcessSandbox;
  allowedPermissions: ToolPermission[];
  runGrantedPermissions?: readonly ToolPermission[];
  permissionPolicy?: UserPermissionPolicy;
  budget: RunBudget;
  trace?: TraceLogger;
  contextManager?: ContextManager;
  sessionId?: string;
  taskId?: string;
  requestId?: string;
}

export interface RunVerifyWorkflowResult {
  steps: AgentToolStep[];
  modelContext: string;
  executed: boolean;
  fallbackReason?: string;
}

const SAFE_COMMANDS = [
  "node --version",
  "node -v",
  "npm --version",
  "npm -v",
  "npm run typecheck",
  "npm test",
  "npm run build",
] as const;

export class RunVerifyWorkflow {
  constructor(private readonly options: RunVerifyWorkflowOptions) {}

  async run(goal: string, intent: AgentIntentType): Promise<RunVerifyWorkflowResult | undefined> {
    if (intent !== "run" && intent !== "verify") return undefined;

    const command = extractSafeCommand(goal);
    if (!command) {
      return this.staticFallback("No safe command was recognized for automatic execution.");
    }
    if (!this.options.allowedPermissions.includes("shell")) {
      return this.staticFallback("The current permission policy does not allow shell execution.");
    }
    if (!this.options.runGrantedPermissions?.includes("shell")) {
      return this.staticFallback(
        "Shell execution requires user JIT confirmation; preflight will not auto-run shell_run.",
      );
    }
    if (this.options.budget.maxToolCalls <= 0 || this.options.budget.maxShellCalls <= 0) {
      return this.staticFallback("The current run budget does not allow shell execution.");
    }

    const tool = this.options.registry.get("shell_run");
    const step: AgentToolStep = {
      iteration: 0,
      tool: "shell_run",
      input: {
        command: toExecutableCommand(command),
        timeoutMs: 120_000,
        maxOutputBytes: 40_000,
      },
      permission: tool?.permission,
      thought: `run/verify workflow: execute safe command "${command}" and collect output.`,
      ok: false,
    };

    this.options.trace?.write({
      type: "agent_tool",
      tool: "shell_run",
      iteration: 0,
      runId: this.options.requestId,
      sessionId: this.options.sessionId,
      taskId: this.options.taskId,
      workflow: intent,
    });

    const gateway = new ToolExecutionGateway(this.options.registry);
    const workflowRoute = defaultWorkflowRouter.routeIntent(intent);
    const result = await gateway.run({
      toolName: "shell_run",
      input: step.input as Record<string, unknown>,
      source: "preflight",
      budgetBucket: "preflight",
      workspaceRoot: this.options.workspaceRoot,
      allowedPermissions: this.options.allowedPermissions,
      runGrantedPermissions: this.options.runGrantedPermissions,
      intent,
      permissionPolicy: this.options.permissionPolicy ?? "confirmBeforeRun",
      mode: "implement",
      workflowRoute,
      taskId: this.options.taskId,
      sessionId: this.options.sessionId,
      requestId: this.options.requestId,
      registryExtras: { processSandbox: this.options.processSandbox },
    });

    if (
      result.outcomeClass === "execution_error" &&
      (result.outcomeKind === "permission_denied" || result.code === "permission_denied")
    ) {
      return this.staticFallback(
        "Shell execution requires user JIT confirmation; preflight will not auto-run shell_run.",
      );
    }
    const finalStep: AgentToolStep =
      result.outcomeClass === "execution_error"
        ? {
            ...step,
            error: result.error ?? result.message,
            blocked: result.code === "permission_denied",
            durationMs: result.durationMs,
            outcomeClass: result.outcomeClass,
            outcomeKind: result.outcomeKind,
          }
        : {
            ...step,
            executed: result.executed,
            ok: result.outcomeClass === "observation_success",
            output: result.output,
            durationMs: result.durationMs,
            error: result.outcomeClass === "observation_failure" ? result.message : undefined,
            outcomeClass: result.outcomeClass,
            outcomeKind: result.outcomeKind,
            outcomeMessage: result.message,
          };

    this.saveToolMessage({
      tool: finalStep.tool,
      output: finalStep.output,
      error: finalStep.error,
      outcomeClass: finalStep.outcomeClass,
      outcomeKind: finalStep.outcomeKind,
      toolCallId: finalStep.toolCallId,
    });
    return {
      steps: [finalStep],
      modelContext: renderRunVerifyContext([finalStep], intent),
      executed: true,
    };
  }

  private staticFallback(reason: string): RunVerifyWorkflowResult {
    const result = {
      steps: [],
      modelContext: [
        "run/verify workflow static fallback:",
        `reason: ${reason}`,
        "No shell command was executed. Explain why execution was skipped and provide manual verification guidance.",
      ].join("\n"),
      executed: false,
      fallbackReason: reason,
    };
    this.saveToolMessage({ tool: "run_verify_static_fallback", output: { reason } });
    return result;
  }

  private saveToolMessage(input: {
    tool: string;
    output?: unknown;
    error?: string;
    outcomeClass?: string;
    outcomeKind?: string;
    toolCallId?: string;
  }): void {
    if (!this.options.contextManager || !this.options.sessionId) return;
    this.options.contextManager.saveToolMessage(
      this.options.sessionId,
      `run/verify workflow step "${input.tool}" result (JSON):\n${JSON.stringify(input.output ?? { error: input.error })}`,
      this.options.requestId,
      {
        outcomeClass: input.outcomeClass,
        outcomeKind: input.outcomeKind,
        toolName: input.tool,
        toolCallId: input.toolCallId,
        ledgerBacked:
          input.outcomeClass === "observation_success" &&
          input.outcomeKind !== "not_found" &&
          input.outcomeKind !== "no_results",
      },
    );
  }
}

export function extractSafeCommand(goal: string): string | undefined {
  const normalized = goal.toLowerCase().replace(/\s+/g, " ").trim();
  for (const command of SAFE_COMMANDS) {
    if (normalized.includes(command)) return command;
  }
  return undefined;
}

function toExecutableCommand(command: string): string {
  if (command === "node --version") return `${quoteCommand(process.execPath)} --version`;
  if (command === "node -v") return `${quoteCommand(process.execPath)} -v`;
  return command;
}

function quoteCommand(command: string): string {
  return `"${command.replace(/"/g, '\\"')}"`;
}

function renderRunVerifyContext(steps: AgentToolStep[], intent: AgentIntentType): string {
  const blocks = steps.map((step, index) => {
    const payload = toolStepPayloadForContext(step);
    return [
      `## ${index + 1}. ${step.tool}`,
      `thought: ${step.thought ?? ""}`,
      `input: ${JSON.stringify(step.input)}`,
      `output: ${JSON.stringify(payload)}`,
    ].join("\n");
  });
  return [
    `${intent}Workflow automatic verification result:`,
    "The workflow executed a recognized safe command and collected output below. Analyze pass/fail status, failure reason, and next steps. Do not call runWorkflow or verifyWorkflow as ToolRegistry tool names.",
    ...blocks,
  ].join("\n\n");
}
