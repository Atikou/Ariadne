import { EditVerificationWorkflow } from "./EditVerificationWorkflow.js";
import { WorkflowCorrectionWorkflow } from "./WorkflowCorrectionWorkflow.js";
import type { AgentIntentType } from "./IntentTypes.js";
import type {
  AgentWorkflowCorrectionRecord,
  AgentWorkflowDiffRecord,
  AgentWorkflowVerificationRecord,
  LocationExecutionMeta,
} from "./RunPolicyTypes.js";
import type { AgentToolStep } from "./toolStep.js";
import { isEffectiveWriteStep } from "./toolStepOutcome.js";

export function buildWorkflowDiffs(steps: AgentToolStep[]): AgentWorkflowDiffRecord[] {
  return steps
    .filter((step) => isEffectiveWriteStep(step))
    .map((step) => {
      const raw = asRecord(step.resultLayers?.raw) ?? asRecord(step.output) ?? {};
      const diff = typeof raw.diff === "string" ? truncateWorkflowDiff(raw.diff) : undefined;
      return {
        toolCallId: step.toolCallId,
        tool: step.tool as "write_file" | "apply_patch",
        path: readString(raw.path),
        changeId: readString(raw.changeId),
        beforeHash: readString(raw.beforeHash),
        afterHash: readString(raw.afterHash),
        diff: diff?.diff,
        diffTruncated: diff?.truncated ?? false,
      };
    });
}

export function buildWorkflowVerifications(
  intent: AgentIntentType,
  steps: AgentToolStep[],
): AgentWorkflowVerificationRecord[] {
  return new EditVerificationWorkflow().collect(intent, steps);
}

export function buildWorkflowCorrections(
  intent: AgentIntentType,
  steps: AgentToolStep[],
): AgentWorkflowCorrectionRecord[] {
  return new WorkflowCorrectionWorkflow().collect(intent, steps);
}

export function buildLocationMeta(steps: AgentToolStep[]): LocationExecutionMeta | undefined {
  const locationTools = new Set([
    "project_scan",
    "project_index_update",
    "symbol_search",
    "locate_relevant_files",
    "context_pack",
  ]);
  const locationSteps = steps.filter((s) => locationTools.has(s.tool));
  const directSearchCalls = steps.filter((s) => s.tool === "search_text").length;
  const directListCalls = steps.filter((s) => s.tool === "list_files").length;
  const directReadCalls = steps.filter((s) => s.tool === "read_file").length;
  if (!locationSteps.length && !directSearchCalls && !directListCalls && !directReadCalls) return undefined;

  const locatedFiles = new Set<string>();
  const candidateFiles = new Set<string>();
  let usedSearchCalls = directSearchCalls;
  let usedListCalls = directListCalls;
  let usedReadForLocationCalls = directReadCalls;
  let stopReason: string | undefined;
  let needsContinue = false;
  let confidence: number | undefined;
  let suggestedAction: "continue_locating" | undefined;
  let exploration: {
    duplicateCount: number;
    newInformationCount: number;
    informationGain: number;
    lowYieldLoop: boolean;
  } | undefined;

  for (const step of locationSteps) {
    const output = step.output as Record<string, unknown> | undefined;
    if (!output) continue;
    const stats = output.locateStats as Record<string, unknown> | undefined;
    usedSearchCalls += readNumber(stats?.usedSearchCalls);
    usedListCalls += readNumber(stats?.usedListCalls);
    usedReadForLocationCalls += readNumber(stats?.usedReadForLocationCalls);
    stopReason = typeof output.stopReason === "string" ? output.stopReason : stopReason;
    needsContinue = needsContinue || output.needsMoreSearch === true || output.needsContinue === true;
    if (output.suggestedAction === "continue_locating") {
      suggestedAction = "continue_locating";
    }
    confidence = Math.max(confidence ?? 0, readNumber(output.confidence));

    const progress = output.explorationProgress as Record<string, unknown> | undefined;
    if (progress) {
      exploration = {
        duplicateCount: readNumber(progress.duplicateCount),
        newInformationCount: readNumber(progress.newInformationCount),
        informationGain: readNumber(progress.informationGain),
        lowYieldLoop: progress.lowYieldLoop === true,
      };
    }

    for (const item of readPathItems(output.primaryFiles)) locatedFiles.add(item);
    for (const item of readPathItems(output.files)) locatedFiles.add(item);
    for (const item of readPathItems(output.candidateFiles)) candidateFiles.add(item);
    for (const item of readPathItems(output.importantFiles)) candidateFiles.add(item);
  }

  return {
    usedLocateSteps: locationSteps.length,
    usedSearchCalls,
    usedListCalls,
    usedReadForLocationCalls,
    locatedFiles: [...locatedFiles].slice(0, 30),
    candidateFiles: [...candidateFiles].filter((p) => !locatedFiles.has(p)).slice(0, 30),
    stopReason,
    needsContinue,
    confidence,
    exploration,
    suggestedAction: needsContinue ? (suggestedAction ?? "continue_locating") : undefined,
  };
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function truncateWorkflowDiff(diff: string, maxChars = 20_000): { diff: string; truncated: boolean } {
  if (diff.length <= maxChars) return { diff, truncated: false };
  return { diff: `${diff.slice(0, maxChars)}\n... (workflow diff truncated)`, truncated: true };
}

function readPathItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && typeof (item as { path?: unknown }).path === "string") {
        return (item as { path: string }).path;
      }
      return undefined;
    })
    .filter((item): item is string => Boolean(item));
}
