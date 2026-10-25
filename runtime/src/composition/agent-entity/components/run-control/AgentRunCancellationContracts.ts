import type { AgentRunExecutionIntentScheduler } from '../../../AgentRunExecutionIntentScheduler.js';
import type { AgentRunWorkScheduler } from '../../../AgentRunWorkScheduler.js';
import type { RuntimeCommandEnvelope } from '../../../../ingress/RuntimeIngress.js';
import type { ShutdownContext } from '../../../../ingress/ShutdownContext.js';
import type { AgentEffectDispatchService } from '@ariadne/agent-core';

export type AgentRunCancelCommand = Extract<RuntimeCommandEnvelope['command'], { readonly kind: 'agent.run.cancel' }>;
export interface AgentRunCancellationReceipt {
  readonly status: 'cancelled' | 'requested';
  readonly runId: string;
  readonly runVersion: number;
}
export interface AgentInferenceCancellationEngines {
  readonly executionScheduler: Pick<AgentRunExecutionIntentScheduler, 'cancelActiveRun'>;
  readonly runWorkScheduler: Pick<AgentRunWorkScheduler, 'interruptActiveTurn'>;
  readonly effects?: Pick<AgentEffectDispatchService, 'cancelActiveEffect'>;
}
export interface AgentRunCancellationOwner {
  start(wakeProjection: () => void): Promise<void>;
  wake(): void;
  assertHealthy(): void;
  prepareShutdown(context: ShutdownContext): Promise<void>;
  cancel(commandId: string, command: AgentRunCancelCommand): Promise<AgentRunCancellationReceipt>;
}
