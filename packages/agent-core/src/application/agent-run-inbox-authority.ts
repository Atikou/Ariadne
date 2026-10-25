import type { AgentRun } from '../domain/agent-run.js';
import { AgentRunTransitionError } from '../domain/errors.js';
import { canonicalizeAgentControlData } from './control-command-digest.js';

/** Only Inbox contents, version and update time may change before the same intended inference starts. */
export function assertAgentRunInboxOnlyMutation(baseline: AgentRun, current: AgentRun): void {
  const stable = ({ inbox: _inbox, version: _version, updatedAt: _updatedAt, ...authority }: AgentRun) => authority;
  if (
    current.version < baseline.version
    || (current.version === baseline.version
      && canonicalizeAgentControlData(current) !== canonicalizeAgentControlData(baseline))
    || Date.parse(current.updatedAt) < Date.parse(baseline.updatedAt)
    || canonicalizeAgentControlData(stable(current)) !== canonicalizeAgentControlData(stable(baseline))
  ) throw new AgentRunTransitionError('Agent Run authority changed outside the durable inbox boundary.');
}
