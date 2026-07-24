import type { ToolPermission } from "../../core/permissions.js";
import type { AgentToolStep } from "../toolStep.js";
import { isSuccessfulToolStep } from "../toolStepOutcome.js";

export interface ToolLedgerEntry {
  toolCallId?: string;
  toolName: string;
  permission?: ToolPermission;
  permissionBucket?: "read" | "write" | "shell";
  attempted: boolean;
  executed: boolean;
  blocked: boolean;
  blockReasonKind?: AgentToolStep["blockedReasonKind"];
  outcomeKind?: string;
  successful: boolean;
  workspaceScopeId?: string;
  matchedRoot?: string;
  crossWorkspace?: boolean;
  grantId?: string;
  permissionSource?: string;
  pathRisk?: string;
  verification?: AgentToolStep["verification"];
}

export interface ToolLedger {
  attemptedShellCalls: number;
  blockedShellCalls: number;
  successfulShellCalls: number;
  failedShellCalls: number;
  attemptedWriteCalls: number;
  blockedWriteCalls: number;
  successfulWriteCalls: number;
  failedWriteCalls: number;
  attemptedReadCalls: number;
  blockedReadCalls: number;
  successfulReadCalls: number;
  crossWorkspaceCalls: number;
  successfulCrossWorkspaceCalls: number;
  blockedCrossWorkspaceCalls: number;
  rootsTouched: string[];
  sensitivePathCalls: number;
  entries: ToolLedgerEntry[];
}

function permissionOf(step: AgentToolStep): ToolPermission | undefined {
  if (step.permission) return step.permission;
  if (step.tool === "shell_run") return "shell";
  if (step.tool === "write_file" || step.tool === "apply_patch") return "write";
  return "read";
}

function ledgerBucket(permission: ToolPermission | undefined): "shell" | "write" | "read" | undefined {
  if (permission === "shell" || permission === "network") return "shell";
  if (permission === "write" || permission === "dangerous") return "write";
  if (permission === "read") return "read";
  return undefined;
}

export function buildToolLedger(steps: AgentToolStep[]): ToolLedger {
  const ledger: ToolLedger = {
    attemptedShellCalls: 0,
    blockedShellCalls: 0,
    successfulShellCalls: 0,
    failedShellCalls: 0,
    attemptedWriteCalls: 0,
    blockedWriteCalls: 0,
    successfulWriteCalls: 0,
    failedWriteCalls: 0,
    attemptedReadCalls: 0,
    blockedReadCalls: 0,
    successfulReadCalls: 0,
    crossWorkspaceCalls: 0,
    successfulCrossWorkspaceCalls: 0,
    blockedCrossWorkspaceCalls: 0,
    rootsTouched: [],
    sensitivePathCalls: 0,
    entries: [],
  };
  const rootsTouched = new Set<string>();

  for (const step of steps) {
    const permission = permissionOf(step);
    const bucket = ledgerBucket(permission);
    const successful = isSuccessfulToolStep(step);
    const blocked = step.blocked === true;
    const executed =
      step.executed === true ||
      (step.executed === undefined &&
        !blocked &&
        (successful || step.outcomeClass === "observation_failure"));
    const failed = !blocked && !successful;

    ledger.entries.push({
      toolCallId: step.toolCallId,
      toolName: step.tool,
      permission,
      permissionBucket: bucket,
      attempted: true,
      executed,
      blocked,
      blockReasonKind: step.blockedReasonKind,
      outcomeKind: step.outcomeKind,
      successful,
      workspaceScopeId: step.workspaceAccess?.workspaceScopeId,
      matchedRoot: step.workspaceAccess?.matchedRoot,
      crossWorkspace: step.workspaceAccess?.crossWorkspace,
      grantId: step.workspaceAccess?.grantId,
      permissionSource: step.workspaceAccess?.permissionSource,
      pathRisk: step.workspaceAccess?.pathRisk,
      verification: step.verification,
    });

    if (step.workspaceAccess?.crossWorkspace) {
      ledger.crossWorkspaceCalls += 1;
      if (successful) ledger.successfulCrossWorkspaceCalls += 1;
      if (blocked) ledger.blockedCrossWorkspaceCalls += 1;
    }
    if (step.workspaceAccess?.matchedRoot) rootsTouched.add(step.workspaceAccess.matchedRoot);
    if (step.workspaceAccess?.pathRisk && step.workspaceAccess.pathRisk !== "normal") {
      ledger.sensitivePathCalls += 1;
    }

    if (!bucket) continue;
    if (bucket === "shell") {
      ledger.attemptedShellCalls += 1;
      if (blocked) ledger.blockedShellCalls += 1;
      else if (successful) ledger.successfulShellCalls += 1;
      else if (failed) ledger.failedShellCalls += 1;
    } else if (bucket === "write") {
      ledger.attemptedWriteCalls += 1;
      if (blocked) ledger.blockedWriteCalls += 1;
      else if (successful) ledger.successfulWriteCalls += 1;
      else if (failed) ledger.failedWriteCalls += 1;
    } else {
      ledger.attemptedReadCalls += 1;
      if (blocked) ledger.blockedReadCalls += 1;
      else if (successful) ledger.successfulReadCalls += 1;
    }
  }
  ledger.rootsTouched = [...rootsTouched];

  return ledger;
}

/** executionMeta / API 用的精简 ToolLedger 摘要。 */
export function toolLedgerToSummary(ledger: ToolLedger): {
  attemptedReadCalls: number;
  blockedReadCalls: number;
  successfulReadCalls: number;
  attemptedShellCalls: number;
  blockedShellCalls: number;
  successfulShellCalls: number;
  attemptedWriteCalls: number;
  blockedWriteCalls: number;
  successfulWriteCalls: number;
  crossWorkspaceCalls: number;
  successfulCrossWorkspaceCalls: number;
  blockedCrossWorkspaceCalls: number;
  rootsTouched: string[];
  sensitivePathCalls: number;
} {
  return {
    attemptedReadCalls: ledger.attemptedReadCalls,
    blockedReadCalls: ledger.blockedReadCalls,
    successfulReadCalls: ledger.successfulReadCalls,
    attemptedShellCalls: ledger.attemptedShellCalls,
    blockedShellCalls: ledger.blockedShellCalls,
    successfulShellCalls: ledger.successfulShellCalls,
    attemptedWriteCalls: ledger.attemptedWriteCalls,
    blockedWriteCalls: ledger.blockedWriteCalls,
    successfulWriteCalls: ledger.successfulWriteCalls,
    crossWorkspaceCalls: ledger.crossWorkspaceCalls,
    successfulCrossWorkspaceCalls: ledger.successfulCrossWorkspaceCalls,
    blockedCrossWorkspaceCalls: ledger.blockedCrossWorkspaceCalls,
    rootsTouched: ledger.rootsTouched,
    sensitivePathCalls: ledger.sensitivePathCalls,
  };
}
