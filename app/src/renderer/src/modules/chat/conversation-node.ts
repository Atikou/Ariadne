import type {
  CompanionMessageReasoning,
  ConversationMessageReference,
  ImageAttachmentRef
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
  bodyState?: 'unloaded' | 'loaded';
  bodyReadToken?: string;
  sessionId?: string;
  reference?: ConversationMessageReference;
  attachments?: readonly ImageAttachmentRef[];
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
  node: Pick<ConversationNode, 'kind' | 'content' | 'summary' | 'bodyState'>
): string {
  if (node.bodyState === 'unloaded') return '';
  if (node.kind === 'user') return node.content ?? node.summary;
  return node.content ?? '';
}
