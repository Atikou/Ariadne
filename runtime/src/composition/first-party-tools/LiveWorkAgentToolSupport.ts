import type { AgentToolJsonValue } from '@ariadne/agent-core';
import type { LiveWorkSnapshot } from '@ariadne/live-work';

import type { AgentToolExecutionContext } from '../../control/ports/AgentToolExecution.js';
import type { AgentLiveWorkOwner } from '../../control/resources/AgentLiveWorkService.js';

export function liveWorkJobSnapshot(work: LiveWorkSnapshot): AgentToolJsonValue {
  return {
    jobId: work.id,
    kind: work.kind,
    label: work.label,
    status: work.status,
    capabilities: { ...work.capabilities },
    metadata: { ...work.metadata },
    startedAt: work.startedAt,
    ...(work.finishedAt === undefined ? {} : { finishedAt: work.finishedAt }),
    ...(work.exitCode === undefined ? {} : { exitCode: work.exitCode }),
    ...(work.detail === undefined ? {} : { detail: work.detail }),
    outputCursor: work.outputCursor,
    retainedFromCursor: work.retainedFromCursor
  };
}

export function liveWorkOwner(context: AgentToolExecutionContext): AgentLiveWorkOwner {
  if (context.scope.length !== 1) throw new Error('workspace_scope_required');
  return { runId: context.runId, workspaceId: context.scope[0]! };
}

export function acceptedLiveWorkInput(input: AgentToolJsonValue) {
  return { status: 'accepted' as const, input };
}

export function rejectedLiveWorkInput() {
  return { status: 'rejected' as const };
}

export function liveWorkJsonValue(value: unknown): AgentToolJsonValue {
  return structuredClone(value) as AgentToolJsonValue;
}
