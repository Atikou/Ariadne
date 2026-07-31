/** Agent Activity Timeline 类型（公开执行摘要，非模型 CoT）。 */

export type ActivityRunStatus =
  | "pending"
  | "running"
  | "waiting"
  | "success"
  | "partial"
  | "failed"
  | "cancelled";

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
  sessionId?: string;
  sourceMessageId?: string;
  origin?: "agent" | "companion";
  projectRoot?: string;
  model?: string;
  mode?: string;
  maxModelTurns?: number;
  tags?: string[];
}

export interface ActivityStepMetadata {
  toolName?: string;
  toolCallId?: string;
  iteration?: number;
  batchId?: string;
  laneId?: string;
  parentActivityId?: string;
  dependsOnActivityIds?: string[];
  verifiesToolCallId?: string;
  args?: Record<string, unknown>;
  resultSummary?: string;
  filePath?: string;
  changedFiles?: string[];
  command?: string;
  cwd?: string;
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
  schemaVersion?: 1 | 2;
  id: string;
  title: string;
  goal: string;
  status: ActivityRunStatus;
  steps: ActivityAgentStep[];
  systemActivities?: ActivitySystemEvent[];
  activeDurationMs?: number;
  activeSince?: number;
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

export interface ActivitySystemEvent {
  id: string;
  runId: string;
  kind: "context_compaction" | "working_context_compaction";
  status: ActivityStepStatus;
  title: string;
  summary?: string;
  startedAt: number;
  endedAt?: number;
  processedMessages?: number;
  beforeChars?: number;
  afterChars?: number;
  summaryType?: string;
}

export type AgentActivityEvent =
  | { type: "run_started"; run: ActivityAgentRun }
  | { type: "run_resumed"; runId: string; resumedAt: number }
  | { type: "run_paused"; runId: string; reason: string }
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
  | { type: "system_activity_changed"; activity: ActivitySystemEvent }
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
