import {
  AgentRunCommandService,
  AgentRunVersionConflictError,
  deriveStableAgentId,
  isTerminalAgentRun,
  sha256AgentControlData,
  type AgentRunUnitOfWork
} from '@ariadne/agent-core';

import type { AgentLiveWorkCompletionNotification } from '../ports/AgentLiveWork.js';

const MAX_VERSION_RETRIES = 16;

export interface AgentLiveWorkCompletionInboxCallbacks {
  readonly wakeWorkScheduler: () => void;
  readonly wakeProjectionDrain: () => void;
}

/** Commits one live-work completion as system-originated Agent inbox input before waking consumers. */
export class AgentLiveWorkCompletionInboxBridge {
  private readonly commands: AgentRunCommandService;

  public constructor(
    private readonly runs: AgentRunUnitOfWork,
    private readonly callbacks: AgentLiveWorkCompletionInboxCallbacks
  ) {
    this.commands = new AgentRunCommandService(runs);
  }

  public async notify(notification: AgentLiveWorkCompletionNotification): Promise<void> {
    const inputId = await deriveStableAgentId(
      'live-work-input',
      notification.runId,
      notification.jobId
    );
    const commandId = await deriveStableAgentId(
      'live-work-notice',
      notification.runId,
      notification.jobId
    );
    const content = renderCompletion(notification);
    const contentDigest = await sha256AgentControlData(content);
    for (let attempt = 0; attempt < MAX_VERSION_RETRIES; attempt += 1) {
      const run = await this.runs.transaction((transaction) => (
        transaction.loadRun(notification.runId)
      ));
      if (run === null || isTerminalAgentRun(run)) return;
      if (run.binding.workspace.workspaceId !== notification.workspaceId) {
        throw new Error('agent_live_work_completion_workspace_mismatch');
      }
      const existing = run.inbox.find((input) => input.inputId === inputId);
      if (existing !== undefined) {
        if (
          existing.source?.kind !== 'live_work'
          || existing.source.jobId !== notification.jobId
          || existing.contentDigest !== contentDigest
        ) throw new Error('agent_live_work_completion_identity_conflict');
        return;
      }
      try {
        await this.commands.execute({
          kind: 'run.enqueue_inbox_input',
          commandId,
          runId: notification.runId,
          expectedVersion: run.version,
          occurredAt: monotonicTime(run.updatedAt, notification.finishedAt),
          input: {
            inputId,
            messageId: inputId,
            delivery: 'next_step',
            content,
            contentDigest,
            source: {
              kind: 'live_work',
              jobId: notification.jobId,
              workKind: notification.workKind,
              status: notification.status
            }
          }
        }, { turnInputPayloads: [], effectPayloads: [] });
        this.callbacks.wakeWorkScheduler();
        this.callbacks.wakeProjectionDrain();
        return;
      } catch (error) {
        if (error instanceof AgentRunVersionConflictError) continue;
        throw error;
      }
    }
    throw new Error('agent_live_work_completion_version_retry_exhausted');
  }
}

function renderCompletion(notification: AgentLiveWorkCompletionNotification): string {
  if (notification.status === 'interrupted') {
    return [
      'A background live-work job was interrupted by a Runtime restart.',
      `Job ID: ${notification.jobId}.`,
      `Kind: ${notification.workKind}.`,
      `Last observed output cursor: ${String(notification.outputCursor)}.`,
      'Process-local output and control handles from the previous Runtime are no longer available.'
    ].join(' ');
  }
  const exit = notification.exitCode === undefined
    ? ''
    : ` Exit code: ${String(notification.exitCode)}.`;
  return [
    'A background live-work job reached a terminal state.',
    `Job ID: ${notification.jobId}.`,
    `Kind: ${notification.workKind}.`,
    `Status: ${notification.status}.${exit}`,
    `Output cursor: ${String(notification.outputCursor)}.`,
    'Use workspace.job_output with this Job ID to inspect retained output before continuing.'
  ].join(' ');
}

function monotonicTime(updatedAt: string, finishedAt: string): string {
  const value = Math.max(Date.parse(updatedAt), Date.parse(finishedAt));
  if (!Number.isFinite(value)) throw new Error('agent_live_work_completion_time_invalid');
  return new Date(value).toISOString();
}
