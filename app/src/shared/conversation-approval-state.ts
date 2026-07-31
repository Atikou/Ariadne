import type {
  AgentProposal,
  PermissionRequest,
  PlanHandoff,
  RunSummary
} from '@ariadne/protocol/public';

interface ApprovalSessionReference {
  sessionId?: string | undefined;
  runId?: string | undefined;
}

interface ConversationApprovalSnapshot {
  permissions: readonly PermissionRequest[];
  planHandoffs: readonly PlanHandoff[];
  proposals: readonly AgentProposal[];
  runs: readonly RunSummary[];
}

export function resolveApprovalSessionId(
  reference: ApprovalSessionReference,
  runs: readonly RunSummary[]
): string | null {
  if (reference.sessionId) return reference.sessionId;
  if (!reference.runId) return null;
  return runs.find((run) => run.runId === reference.runId)?.sessionId ?? null;
}

export function pendingApprovalSessionIds(
  snapshot: ConversationApprovalSnapshot
): ReadonlySet<string> {
  const sessionIds = new Set<string>();
  const addSession = (reference: ApprovalSessionReference): void => {
    const sessionId = resolveApprovalSessionId(reference, snapshot.runs);
    if (sessionId) sessionIds.add(sessionId);
  };

  snapshot.proposals
    .filter((proposal) => proposal.status === 'pending')
    .forEach(addSession);
  snapshot.permissions
    .filter((request) => request.status === 'pending')
    .forEach(addSession);
  snapshot.planHandoffs
    .filter((handoff) => handoff.status === 'pending')
    .forEach(addSession);

  return sessionIds;
}
