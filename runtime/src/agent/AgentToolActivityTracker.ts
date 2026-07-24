import type { ToolPathPreparation } from "../policy/PathPolicy.js";
import type { AgentTimelineService } from "./timeline/AgentTimelineService.js";
import { mapToolToActivityStep } from "./timeline/toolStepMapper.js";

export interface AgentToolActivityExtra {
  durationMs?: number;
  outcomeKind?: string;
  exitCode?: number;
  command?: string;
  changedFiles?: string[];
  workspaceAccess?: ToolPathPreparation["audit"];
}

/** 单次工具调用的 Activity Timeline 步骤生命周期。 */
export class AgentToolActivityTracker {
  private activityStepId?: string;

  constructor(
    private readonly timeline: AgentTimelineService | undefined,
    private readonly activityRunId: string,
  ) {}

  startTool(input: {
    tool: string;
    toolInput: Record<string, unknown>;
    iteration: number;
    toolCallId: string;
  }): void {
    const tl = this.timeline;
    if (!tl || !this.activityRunId) return;
    const mapped = mapToolToActivityStep(input.tool, input.toolInput);
    this.activityStepId = tl.startStep({ runId: this.activityRunId, ...mapped }).id;
    tl.recordRawToolCall({
      tool: input.tool,
      input: input.toolInput,
      iteration: input.iteration,
      toolCallId: input.toolCallId,
      at: new Date().toISOString(),
    });
  }

  fail(message: string, extra?: AgentToolActivityExtra): void {
    if (!this.activityStepId || !this.timeline) return;
    this.timeline.failStep(this.activityStepId, message, {
      durationMs: extra?.durationMs,
      outcomeClass: "execution_error",
      outcomeKind: extra?.outcomeKind,
      crossWorkspace: extra?.workspaceAccess?.crossWorkspace,
      matchedRoot: extra?.workspaceAccess?.matchedRoot,
      grantId: extra?.workspaceAccess?.grantId,
      pathRisk: extra?.workspaceAccess?.pathRisk,
    });
  }

  ok(message: string, extra?: AgentToolActivityExtra): void {
    if (!this.activityStepId || !this.timeline) return;
    this.timeline.completeStep(this.activityStepId, message, {
      durationMs: extra?.durationMs,
      resultSummary: message,
      changedFiles: extra?.changedFiles,
      outcomeClass: "observation_success",
      crossWorkspace: extra?.workspaceAccess?.crossWorkspace,
      matchedRoot: extra?.workspaceAccess?.matchedRoot,
      grantId: extra?.workspaceAccess?.grantId,
      pathRisk: extra?.workspaceAccess?.pathRisk,
    });
  }

  observe(message: string, extra?: AgentToolActivityExtra): void {
    if (!this.activityStepId || !this.timeline) return;
    this.timeline.completeStep(this.activityStepId, message, {
      durationMs: extra?.durationMs,
      resultSummary: message,
      outcomeClass: "observation_failure",
      outcomeKind: extra?.outcomeKind,
      exitCode: extra?.exitCode,
      command: extra?.command,
      crossWorkspace: extra?.workspaceAccess?.crossWorkspace,
      matchedRoot: extra?.workspaceAccess?.matchedRoot,
      grantId: extra?.workspaceAccess?.grantId,
      pathRisk: extra?.workspaceAccess?.pathRisk,
    });
  }
}
