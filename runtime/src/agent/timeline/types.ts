/** Agent Activity Timeline 类型（公开执行摘要，非模型 CoT）。 */

export type ActivityRunStatus = "pending" | "running" | "success" | "partial" | "failed" | "cancelled";

export type ActivityStepStatus = "pending" | "running" | "success" | "warning" | "failed" | "skipped";

export type ActivityStepType =
  | "analysis"
  | "plan"
  | "todo"
  | "tool_call"
  | "file_search"
  | "file_read"
  | "file_write"
  | "file_patch"
  | "shell"
  | "web_search"
  | "validation"
  | "summary"
  | "error"
  | "retry"
  | "escalation";

export interface ActivityRunMetadata {
  userInput?: string;
  projectRoot?: string;
  model?: string;
  mode?: string;
  maxModelTurns?: number;
  tags?: string[];
}

export interface ActivityStepMetadata {
  toolName?: string;
  args?: Record<string, unknown>;
  resultSummary?: string;
  filePath?: string;
  changedFiles?: string[];
  command?: string;
  exitCode?: number;
  stdoutPreview?: string;
  stderrPreview?: string;
  errorMessage?: string;
  outcomeClass?: string;
  outcomeKind?: string;
  crossWorkspace?: boolean;
  matchedRoot?: string;
  grantId?: string;
  pathRisk?: string;
  retryCount?: number;
  collapsible?: boolean;
  durationMs?: number;
}

export interface ActivityAgentRun {
  id: string;
  title: string;
  goal: string;
  status: ActivityRunStatus;
  steps: ActivityAgentStep[];
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  endedAt?: number;
  metadata?: ActivityRunMetadata;
}

export interface ActivityAgentStep {
  id: string;
  runId: string;
  type: ActivityStepType;
  title: string;
  content?: string;
  status: ActivityStepStatus;
  startedAt?: number;
  endedAt?: number;
  metadata?: ActivityStepMetadata;
}

export type AgentActivityEvent =
  | { type: "run_started"; run: ActivityAgentRun }
  | { type: "step_started"; step: ActivityAgentStep }
  | { type: "step_delta"; runId: string; stepId: string; contentDelta: string }
  | {
      type: "step_completed";
      runId: string;
      stepId: string;
      result?: string;
      metadata?: Partial<ActivityStepMetadata>;
    }
  | {
      type: "step_failed";
      runId: string;
      stepId: string;
      error: string;
      metadata?: Partial<ActivityStepMetadata>;
    }
  | { type: "step_skipped"; runId: string; stepId: string; reason?: string }
  | { type: "run_completed"; runId: string; summary: string }
  | { type: "run_failed"; runId: string; error: string }
  | { type: "run_cancelled"; runId: string; reason?: string };

export interface CreateActivityRunInput {
  id: string;
  goal: string;
  title?: string;
  sessionId?: string;
  metadata?: ActivityRunMetadata;
}

/** Timeline 目录 manifest（生命周期 / 清理治理）。 */
export interface ActivityRunManifest {
  runId: string;
  sessionId?: string;
  projectPath: string;
  status: ActivityRunStatus;
  createdAt: number;
  completedAt?: number;
  summaryPath: string;
  eventsPath: string;
  artifactPaths: string[];
  pinned: boolean;
  retentionClass: "default" | "extended";
}

export interface StartActivityStepInput {
  runId: string;
  type: ActivityStepType;
  title: string;
  content?: string;
  metadata?: ActivityStepMetadata;
}
