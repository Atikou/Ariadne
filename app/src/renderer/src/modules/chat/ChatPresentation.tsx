import { Sparkles } from 'lucide-react';
import type { ChatRoutingStrategy } from '@ariadne/protocol/public';
import { calculateComposerTextareaLayout } from '@shared/composer-textarea-layout';
import { type ChatModelState } from './chat-model-state';
import { AUTO_ROUTING_PREFIX } from './ChatComposerPolicy';

export function routingSelectionValue(strategy: ChatRoutingStrategy): string {
  return `${AUTO_ROUTING_PREFIX}${strategy}`;
}

export function syncComposerTextareaHeight(input: HTMLTextAreaElement): void {
  input.style.height = 'auto';
  const style = getComputedStyle(input);
  const layout = calculateComposerTextareaLayout(
    input.scrollHeight,
    Number.parseFloat(style.minHeight),
    Number.parseFloat(style.maxHeight)
  );
  input.style.height = `${layout.height}px`;
  input.style.overflowY = layout.overflowY;
}

export function EmptyConversation({ modelState }: { modelState: ChatModelState }): React.JSX.Element {
  return <div className="empty-conversation"><span><Sparkles size={21} /></span><h2>{modelState.emptyTitle}</h2><p>{modelState.emptyDescription}</p></div>;
}

export function agentInputDeliveryLabel(
  state: 'pending' | 'accepted' | 'reconcile' | 'failed'
): string {
  switch (state) {
    case 'pending':
      return '提交中';
    case 'accepted':
      return '已接收';
    case 'reconcile':
      return '等待确认';
    case 'failed':
      return '发送失败';
  }
}
