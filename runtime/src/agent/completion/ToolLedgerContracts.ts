import type { ToolPermission } from "../../core/permissions.js";
import type {
  ToolStepBlockedReasonKind,
  ToolVerificationBinding,
} from "../ToolStepContracts.js";

export interface ToolLedgerEntry {
  toolCallId?: string;
  toolName: string;
  permission?: ToolPermission;
  permissionBucket?: "read" | "write" | "shell";
  attempted: boolean;
  executed: boolean;
  blocked: boolean;
  blockReasonKind?: ToolStepBlockedReasonKind;
  outcomeKind?: string;
  successful: boolean;
  workspaceScopeId?: string;
  matchedRoot?: string;
  crossWorkspace?: boolean;
  grantId?: string;
  permissionSource?: string;
  pathRisk?: string;
  verification?: ToolVerificationBinding;
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

export type ToolLedgerSummary = Pick<
  ToolLedger,
  | "attemptedReadCalls"
  | "blockedReadCalls"
  | "successfulReadCalls"
  | "attemptedShellCalls"
  | "blockedShellCalls"
  | "successfulShellCalls"
  | "attemptedWriteCalls"
  | "blockedWriteCalls"
  | "successfulWriteCalls"
  | "crossWorkspaceCalls"
  | "successfulCrossWorkspaceCalls"
  | "blockedCrossWorkspaceCalls"
  | "rootsTouched"
  | "sensitivePathCalls"
>;
