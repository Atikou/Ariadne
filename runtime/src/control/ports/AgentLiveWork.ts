export interface AgentLiveWorkCompletionNotification {
  readonly runId: string;
  readonly workspaceId: string;
  readonly jobId: string;
  readonly workKind: string;
  readonly status: 'completed' | 'killed' | 'failed' | 'interrupted';
  readonly finishedAt: string;
  readonly outputCursor: number;
  readonly exitCode?: number;
  readonly detail?: string;
}

export interface AgentLiveWorkCompletionBinding {
  assertHealthy(): void;
  drain(timeoutMs: number): Promise<void>;
  unbind(): void;
}

export interface AgentControlLiveWorkService {
  closeOwner(runId: string): void | Promise<void>;
  close(timeoutMs?: number): Promise<void>;
  bindCompletionSink(
    sink: (notification: AgentLiveWorkCompletionNotification) => Promise<void>
  ): AgentLiveWorkCompletionBinding;
}
