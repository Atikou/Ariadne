import type { AgentRun } from '../domain/agent-run.js';
import { AgentRunTransitionError } from '../domain/errors.js';
import { canonicalizeAgentControlData } from './control-command-digest.js';

/** An owned Effect result may cross only Inbox writes and the additive stop intent. */
export function assertAgentEffectResultAuthority(baseline: AgentRun, current: AgentRun): void {
  const stable = ({ inbox: _inbox, version: _version, updatedAt: _updatedAt,
    cancellationRequest: _cancellation, ...authority }: AgentRun) => authority;
  if (current.version < baseline.version
    || Date.parse(current.updatedAt) < Date.parse(baseline.updatedAt)
    || canonicalizeAgentControlData(stable(current)) !== canonicalizeAgentControlData(stable(baseline))
    || (baseline.cancellationRequest !== undefined
      && canonicalizeAgentControlData(current.cancellationRequest ?? null)
        !== canonicalizeAgentControlData(baseline.cancellationRequest))
    || (current.version === baseline.version
      && canonicalizeAgentControlData(current) !== canonicalizeAgentControlData(baseline))) {
    throw new AgentRunTransitionError('Effect result authority changed outside Inbox and cancellation request boundaries.');
  }
}

export function isAgentRunCancellationRequestMutation(current: AgentRun | null, next: AgentRun): boolean {
  if (current === null || next.cancellationRequest === undefined || next.version !== current.version + 1) return false;
  const withoutRequest = ({ cancellationRequest: _request, version: _version, updatedAt: _updatedAt, ...authority }: AgentRun) => authority;
  return canonicalizeAgentControlData(withoutRequest(current)) === canonicalizeAgentControlData(withoutRequest(next))
    && (current.cancellationRequest === undefined
      || canonicalizeAgentControlData(current.cancellationRequest) === canonicalizeAgentControlData(next.cancellationRequest));
}
