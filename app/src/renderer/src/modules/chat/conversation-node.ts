import type {
  CompanionMessageReasoning,
  ConversationMessageReferenceV3,
  ImageAttachmentRefV3,
  RunSummary
} from '@ariadne/protocol/public';
import type { RuntimeRun } from '@renderer/core/runtime/runtime-store';

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
  reference?: ConversationMessageReferenceV3;
  attachments?: readonly ImageAttachmentRefV3[];
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
  run?: Pick<RuntimeRun, 'origin' | 'status'> | Pick<RunSummary, 'origin' | 'status'>,
): boolean {
  if (node.kind === 'user') return true;
  if (node.reasoning?.status === 'streaming') return false;
  if (!run) return true;
  if (run?.origin === 'companion') return true;
  return ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status);
}
