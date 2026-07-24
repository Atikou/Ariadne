import type { TraceLogger } from "../trace/TraceLogger.js";
import type { SubAgentCoordinator } from "./SubAgentCoordinator.js";
import {
  SubAgentWorkflowStateCenter,
  type SubAgentDispatchSnapshot,
  type SubAgentWorkflowResult,
} from "./SubAgentWorkflowStateCenter.js";
import type { SubAgentBatchOptions } from "./types.js";

export interface SubAgentWorkflowHandle {
  dispatchId: string;
  completion: Promise<SubAgentWorkflowResult>;
}

/**
 * One-way command consumer for dispatch_subagent.
 * Submission records state synchronously; child execution starts from a detached microtask.
 */
export class SubAgentWorkflow {
  readonly stateCenter: SubAgentWorkflowStateCenter;

  constructor(
    private readonly coordinator: SubAgentCoordinator,
    options: {
      stateCenter?: SubAgentWorkflowStateCenter;
      trace?: TraceLogger;
    } = {},
  ) {
    this.stateCenter = options.stateCenter ?? new SubAgentWorkflowStateCenter();
    this.trace = options.trace;
  }

  private readonly trace?: TraceLogger;

  submit(options: SubAgentBatchOptions): SubAgentWorkflowHandle {
    if (!options.tasks.length) throw new Error("tasks cannot be empty");
    const accepted = this.stateCenter.accept({
      parentTaskId: options.parentTaskId,
      mode: options.tasks.length === 1 ? "single" : "batch",
      taskCount: options.tasks.length,
    });
    this.writeTrace(accepted);

    const completion = this.stateCenter.waitForCompletion(accepted.dispatchId);
    queueMicrotask(() => void this.execute(accepted.dispatchId, options));
    return { dispatchId: accepted.dispatchId, completion };
  }

  private async execute(dispatchId: string, options: SubAgentBatchOptions): Promise<void> {
    this.writeTrace(this.stateCenter.markRunning(dispatchId));
    try {
      if (options.tasks.length === 1) {
        const result = await this.coordinator.runDelegated(options.tasks[0]!, {
          workspaceRoot: options.workspaceRoot,
          parentTaskId: options.parentTaskId,
          grantedPermissions: options.grantedPermissions,
          timeoutMs: options.timeoutMs,
          sensitive: options.sensitive,
          parentIntent: options.parentIntent,
          parentWorkflowType: options.parentWorkflowType,
          dispatchDepth: options.dispatchDepth,
          signal: options.signal,
          maxCostUsd: options.maxCostUsd,
        });
        this.writeTrace(this.stateCenter.complete(dispatchId, { mode: "single", result }));
        return;
      }
      const result = await this.coordinator.runBatch(options);
      this.writeTrace(this.stateCenter.complete(dispatchId, { mode: "batch", result }));
    } catch (error) {
      this.writeTrace(this.stateCenter.fail(dispatchId, error));
    }
  }

  private writeTrace(snapshot: SubAgentDispatchSnapshot): void {
    try {
      this.trace?.write({
        type: "subagent_dispatch_state",
        dispatchId: snapshot.dispatchId,
        parentTaskId: snapshot.parentTaskId,
        mode: snapshot.mode,
        taskCount: snapshot.taskCount,
        status: snapshot.status,
        error: snapshot.error,
      });
    } catch {
      // Audit transport failures must not become workflow transition failures.
    }
  }
}
