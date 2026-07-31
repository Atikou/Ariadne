import type { CompanionMessageReasoning, RunSummary } from '@ariadne/protocol/public';

export type ConversationNodeKind =
  | 'assistant'
  | 'cancelled'
  | 'complete'
  | 'error'
  | 'execution'
  | 'offline'
  | 'permission'
  | 'proposal'
  | 'streaming'
  | 'tool'
  | 'user';

export interface ConversationNode {
  id: string;
  kind: ConversationNodeKind;
  sender: string;
  time: string;
  summary: string;
  content?: string;
  runId?: string;
  processingDurationMs?: number;
  deliveryState?: 'pending' | 'failed';
  status?: 'streaming' | 'completed' | 'interrupted' | 'failed';
  reasoning?: CompanionMessageReasoning;
  error?: {
    code: string;
    message: string;
    retryable?: boolean | undefined;
  };
}

export function shouldShowFormalAnswer(
  node: Pick<ConversationNode, 'kind' | 'reasoning'>,
  run?: Pick<RunSummary, 'origin' | 'status'>,
): boolean {
  if (node.kind === 'user') return true;
  if (node.reasoning?.status === 'streaming') return false;
  if (run?.origin !== 'agent') return true;
  return ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status);
}
