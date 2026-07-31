import { createHash } from "node:crypto";

import type {
  JsonValue,
  RunActivityDetail,
  RunFileChange,
} from "@ariadne/protocol/public";

import type { ToolPathPreparation } from "../policy/PathPolicy.js";
import type { FileChangeRecord } from "../tools/storage/ToolStorage.js";
import type { AgentTimelineService } from "./timeline/AgentTimelineService.js";
import { sanitizeActivityValue } from "./timeline/sanitizeToolArgs.js";
import { mapToolToActivityStep } from "./timeline/toolStepMapper.js";

export interface AgentToolActivityExtra {
  durationMs?: number;
  outcomeKind?: string;
  exitCode?: number;
  command?: string;
  cwd?: string;
  changedFiles?: string[];
  fileChangeRecords?: FileChangeRecord[];
  output?: unknown;
  stdout?: string;
  stderr?: string;
  error?: string;
  workspaceAccess?: ToolPathPreparation["audit"];
  permissionAudit?: unknown;
}

/** Owns the one-to-one lifecycle between a tool call and its persisted activity node. */
export class AgentToolActivityTracker {
  private activityStepId?: string;
  private toolName?: string;
  private toolCallId?: string;
  private toolInput?: Record<string, unknown>;

  constructor(
    private readonly timeline: AgentTimelineService | undefined,
    private readonly activityRunId: string,
  ) {}

  get activityId(): string | undefined {
    return this.activityStepId;
  }

  startTool(input: {
    tool: string;
    toolInput: Record<string, unknown>;
    iteration: number;
    toolCallId: string;
    batchId?: string;
    laneId?: string;
    parentActivityId?: string;
    dependsOnToolCallIds?: string[];
    verifiesToolCallId?: string;
  }): void {
    const timeline = this.timeline;
    if (!timeline || !this.activityRunId) return;
    const mapped = mapToolToActivityStep(input.tool, input.toolInput);
    const dependsOnActivityIds = (input.dependsOnToolCallIds ?? [])
      .map((toolCallId) => timeline.activityIdForToolCall(toolCallId))
      .filter((activityId): activityId is string => Boolean(activityId));
    this.toolName = input.tool;
    this.toolCallId = input.toolCallId;
    this.toolInput = input.toolInput;
    this.activityStepId = timeline.startStep({
      runId: this.activityRunId,
      ...mapped,
      metadata: {
        ...mapped.metadata,
        toolCallId: input.toolCallId,
        iteration: input.iteration,
        batchId: input.batchId ?? `iteration-${input.iteration}`,
        laneId: input.laneId ?? "main",
        parentActivityId: input.parentActivityId,
        dependsOnActivityIds,
        verifiesToolCallId: input.verifiesToolCallId,
        cwd: typeof input.toolInput.cwd === "string" ? input.toolInput.cwd : undefined,
      },
    }).id;
    timeline.recordRawToolCall({
      tool: input.tool,
      input: input.toolInput,
      iteration: input.iteration,
      toolCallId: input.toolCallId,
      at: new Date().toISOString(),
    });
    this.persistDetail(mapped.content ?? mapped.title);
  }

  fail(message: string, extra?: AgentToolActivityExtra): void {
    if (!this.activityStepId || !this.timeline) return;
    this.persistDetail(message, { ...extra, error: extra?.error ?? message });
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
    this.persistDetail(message, extra);
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
    this.persistDetail(message, extra);
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

  private persistDetail(message: string, extra?: AgentToolActivityExtra): void {
    if (
      !this.activityStepId
      || !this.timeline
      || !this.toolName
      || !this.toolCallId
      || !this.toolInput
    ) {
      return;
    }
    const args = sanitizeActivityValue(this.toolInput, 8 * 1024);
    const output = sanitizeActivityValue(extra?.output);
    const record = asRecord(output.value);
    const outputPreview = sanitizePreview(serializePreview(output.value));
    const stdout = sanitizePreview(extra?.stdout ?? stringField(record, "stdout"));
    const stderr = sanitizePreview(extra?.stderr ?? stringField(record, "stderr"));
    const command = sanitizePreview(
      extra?.command
        ?? stringField(record, "command")
        ?? (typeof this.toolInput.command === "string" ? this.toolInput.command : undefined),
    );
    const cwd = sanitizePreview(
      extra?.cwd
        ?? stringField(record, "cwd")
        ?? (typeof this.toolInput.cwd === "string" ? this.toolInput.cwd : undefined),
      32_768,
    );
    const permissionAudit = sanitizeActivityValue(
      extra?.permissionAudit ?? extra?.workspaceAccess,
      16 * 1024,
    );
    const fileChanges = collectFileChanges(
      this.toolName,
      this.toolInput,
      record,
      extra?.changedFiles,
      extra?.fileChangeRecords,
    );
    const exitCode = numberField(record, "exitCode") ?? extra?.exitCode;
    const resultSummary = sanitizePreview(message);
    const errorMessage = sanitizePreview(extra?.error);
    const detail: RunActivityDetail = {
      activityId: this.activityStepId,
      runId: this.activityRunId,
      toolCallId: this.toolCallId,
      toolName: this.toolName,
      args: args.value as Record<string, JsonValue>,
      ...(command.value ? { command: command.value } : {}),
      ...(cwd.value ? { cwd: cwd.value } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(stdout.value ? { stdoutPreview: stdout.value } : {}),
      ...(stderr.value ? { stderrPreview: stderr.value } : {}),
      ...(outputPreview.value ? { outputPreview: outputPreview.value } : {}),
      ...(resultSummary.value ? { resultSummary: resultSummary.value } : {}),
      ...(errorMessage.value ? { errorMessage: errorMessage.value } : {}),
      ...(permissionAudit.value && typeof permissionAudit.value === "object"
        && !Array.isArray(permissionAudit.value)
        ? { permissionAudit: permissionAudit.value as Record<string, JsonValue> }
        : {}),
      outputTruncated:
        args.truncated
        || output.truncated
        || outputPreview.truncated
        || stdout.truncated
        || stderr.truncated
        || command.truncated,
      redacted:
        args.redacted
        || output.redacted
        || stdout.redacted
        || stderr.redacted
        || command.redacted
        || permissionAudit.redacted,
      fileChanges,
    };
    this.timeline.saveActivityDetail(detail);
  }
}

const PREVIEW_LIMIT = 64 * 1024;
const DIFF_LIMIT = 2 * 1024 * 1024;

function asRecord(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}

function stringField(record: Record<string, JsonValue>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}

function numberField(record: Record<string, JsonValue>, key: string): number | undefined {
  return typeof record[key] === "number" ? record[key] : undefined;
}

function sanitizePreview(
  value: string | undefined,
  maxChars = PREVIEW_LIMIT,
): { value?: string; redacted: boolean; truncated: boolean } {
  if (!value) return { redacted: false, truncated: false };
  const sanitized = sanitizeActivityValue(value, maxChars);
  return {
    value: typeof sanitized.value === "string" ? sanitized.value : String(sanitized.value),
    redacted: sanitized.redacted,
    truncated: sanitized.truncated,
  };
}

function collectFileChanges(
  toolName: string,
  input: Record<string, unknown>,
  output: Record<string, JsonValue>,
  changedFiles: string[] | undefined,
  records: FileChangeRecord[] | undefined,
): RunFileChange[] {
  if (!isMutationTool(toolName) && !records?.length) return [];
  const outputPaths = Array.isArray(output.changedFiles)
    ? output.changedFiles.filter((value): value is string => typeof value === "string")
    : [];
  const restoredPaths = Array.isArray(output.restoredFiles)
    ? output.restoredFiles.filter((value): value is string => typeof value === "string")
    : [];
  const deletedPaths = Array.isArray(output.deletedFiles)
    ? output.deletedFiles.filter((value): value is string => typeof value === "string")
    : [];
  const inputPath = typeof input.path === "string" ? input.path : undefined;
  const outputPath = stringField(output, "path");
  const paths = [...new Set([
    ...(records ?? []).map((record) => record.path),
    ...(changedFiles ?? []),
    ...outputPaths,
    ...restoredPaths,
    ...deletedPaths,
    ...(outputPath ? [outputPath] : []),
    ...(inputPath ? [inputPath] : []),
  ])].slice(0, 2_000);
  return paths.map((filePath) => {
    const authoritative = records?.find((record) => record.path === filePath);
    const rawDiff = authoritative?.diff
      ?? stringField(output, "diff")
      ?? stringField(output, "unifiedDiff");
    const sanitizedDiff = sanitizePreview(rawDiff, DIFF_LIMIT);
    const counts = countDiffLines(sanitizedDiff.value);
    const diffHash = rawDiff
      ? createHash("sha256").update(rawDiff, "utf8").digest("hex")
      : undefined;
    const checkpointId = authoritative?.id
      ?? stringField(output, "changeId")
      ?? stringField(output, "checkpointId");
    const beforeHash = validSha256(authoritative?.beforeHash ?? stringField(output, "beforeHash"));
    const afterHash = validSha256(authoritative?.afterHash ?? stringField(output, "afterHash"));
    const changedStartLine = positiveIntegerField(output, "changedStartLine");
    const changedEndLine = positiveIntegerField(output, "changedEndLine");
    return {
      path: filePath,
      changeKind: inferChangeKind(toolName, output, deletedPaths.includes(filePath)),
      additions: counts.additions,
      deletions: counts.deletions,
      ...(checkpointId ? { checkpointId } : {}),
      ...(beforeHash ? { beforeHash } : {}),
      ...(afterHash ? { afterHash } : {}),
      ...(diffHash ? { diffHash } : {}),
      ...(sanitizedDiff.value ? { diff: sanitizedDiff.value } : {}),
      diffTruncated:
        sanitizedDiff.truncated
        || output.diffTruncated === true
        || Boolean(rawDiff && rawDiff.length > DIFF_LIMIT),
      ...(changedStartLine ? { changedStartLine } : {}),
      ...(changedEndLine ? { changedEndLine } : {}),
      evidence: checkpointId || rawDiff ? "authoritative" : "observed",
    };
  });
}

function countDiffLines(diff: string | undefined): { additions: number; deletions: number } {
  if (!diff) return { additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split(/\r?\n/u)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

function inferChangeKind(
  toolName: string,
  output: Record<string, JsonValue>,
  deleted: boolean,
): RunFileChange["changeKind"] {
  const kind = stringField(output, "changeKind") ?? stringField(output, "operation");
  if (kind === "created" || kind === "modified" || kind === "deleted") return kind;
  if (deleted) return "deleted";
  if (toolName === "write_file" && output.isNew === true) return "created";
  return isMutationTool(toolName) ? "modified" : "observed";
}

function validSha256(value: string | undefined): string | undefined {
  return value && /^[a-f0-9]{64}$/u.test(value) ? value : undefined;
}

function positiveIntegerField(
  record: Record<string, JsonValue>,
  key: string,
): number | undefined {
  const value = numberField(record, key);
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isMutationTool(toolName: string): boolean {
  return toolName === "write_file"
    || toolName === "apply_patch"
    || toolName === "rollback_change";
}

function serializePreview(value: JsonValue): string | undefined {
  if (value === null || value === undefined) return undefined;
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
