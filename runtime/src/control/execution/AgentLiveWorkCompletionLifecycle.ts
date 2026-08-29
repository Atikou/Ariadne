import type {
  AgentRunRecoveryPayloadReader,
  AgentRunRecoveryQuery,
  AgentRunUnitOfWork
} from '@ariadne/agent-core';

import type {
  AgentControlLiveWorkService,
  AgentLiveWorkCompletionBinding
} from '../ports/AgentLiveWork.js';
import {
  AgentLiveWorkCompletionInboxBridge,
  type AgentLiveWorkCompletionInboxCallbacks
} from './AgentLiveWorkCompletionInboxBridge.js';
import { AgentLiveWorkStartupRecovery } from './AgentLiveWorkStartupRecovery.js';

type AgentLiveWorkCompletionStore = AgentRunUnitOfWork
  & AgentRunRecoveryQuery
  & Pick<AgentRunRecoveryPayloadReader, 'loadEffectResult'>;

/** Owns completion binding health and the live-work-before-Store shutdown barrier. */
export class AgentLiveWorkCompletionLifecycle {
  private readonly binding: AgentLiveWorkCompletionBinding;
  private readonly startupRecovery: AgentLiveWorkStartupRecovery;
  private prepared = false;

  public constructor(
    private readonly liveWork: AgentControlLiveWorkService,
    runs: AgentLiveWorkCompletionStore,
    callbacks: AgentLiveWorkCompletionInboxCallbacks
  ) {
    const bridge = new AgentLiveWorkCompletionInboxBridge(runs, callbacks);
    this.startupRecovery = new AgentLiveWorkStartupRecovery(runs, bridge);
    this.binding = liveWork.bindCompletionSink((notification) => bridge.notify(notification));
  }

  public reconcileStartup(): Promise<void> {
    return this.startupRecovery.reconcile();
  }

  public assertHealthy(): void {
    this.binding.assertHealthy();
  }

  public async prepareShutdown(timeoutMs: number): Promise<void> {
    if (this.prepared) {
      this.binding.assertHealthy();
      return;
    }
    await this.liveWork.close(timeoutMs);
    await this.binding.drain(timeoutMs);
    this.binding.unbind();
    this.prepared = true;
  }
}
