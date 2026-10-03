import type {
  CompanionMessageReasoning,
  ConversationMessageReferenceV3,
  ImageAttachmentRefV3
} from '@ariadne/protocol/public';

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

export function conversationTextForDisplay(
  node: Pick<ConversationNode, 'kind' | 'content' | 'summary'>
): string {
  if (node.kind === 'user') return node.content ?? node.summary;
  return node.content ?? '';
}
