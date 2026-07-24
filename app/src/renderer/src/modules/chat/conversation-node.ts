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
  deliveryState?: 'pending' | 'failed';
  status?: 'streaming' | 'completed' | 'interrupted' | 'failed';
  error?: {
    code: string;
    message: string;
    retryable?: boolean | undefined;
  };
}
