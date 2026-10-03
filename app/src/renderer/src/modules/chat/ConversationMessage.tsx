import {
  useEffect,
  useRef,
  useState
} from 'react';
import {
  Check,
  Copy,
  GitFork,
  Image as ImageIcon,
  ShieldAlert
} from 'lucide-react';
import { type RuntimeRun } from '@renderer/core/runtime/runtime-store';
import type { ToolResultFeatureStore } from '@renderer/core/runtime/features/tool-result-feature-store';
import { conversationTextForDisplay, type ConversationNode } from './conversation-node';
import { MarkdownMessage } from './MarkdownMessage';
import { RunProcessingDisclosure } from './RunProcessingDisclosure';
import { formatBytes } from './ChatImageAttachments';

export function ConversationMessage({
  node,
  run,
  activities,
  workspaceId,
  toolResults,
  onOpenActivity,
  onCopy,
  onFork
}: {
  node: ConversationNode;
  run?: RuntimeRun | undefined;
  activities: import('@ariadne/protocol/public').RunActivity[];
  workspaceId?: string | undefined;
  toolResults?: ToolResultFeatureStore | undefined;
  onOpenActivity?: (() => void) | undefined;
  onCopy(text: string): Promise<void>;
  onFork?: (() => Promise<void>) | undefined;
}): React.JSX.Element {
  const isUser = node.kind === 'user';
  const visibleText = conversationTextForDisplay(node);
  return <div className={isUser ? 'user-message-block' : 'assistant-message-block'}>
    <div className={isUser ? 'user-message' : 'assistant-message'}>
      {isUser
        ? <>
            {node.attachments && node.attachments.length > 0 && (
              <div className="message-image-attachments" aria-label="图片附件">
                {node.attachments.map((attachment) => (
                  <div className="message-image-attachment" key={attachment.attachmentId}>
                    <ImageIcon size={18} aria-hidden="true" />
                    <span>{attachment.name ?? '图片'}</span>
                    <small>{attachment.width} × {attachment.height} · {formatBytes(attachment.bytes)}</small>
                  </div>
                ))}
              </div>
            )}
            {visibleText && <p className="message-content">{visibleText}</p>}
          </>
        : <div className="assistant-message-content">
            <RunProcessingDisclosure
              reasoning={node.reasoning}
              run={run}
              activities={activities}
              messageStatus={node.status}
              fallbackDurationMs={node.processingDurationMs}
              onOpenActivity={onOpenActivity}
              workspaceId={workspaceId}
              toolResults={toolResults}
            />
            {visibleText
              ? <MarkdownMessage markdown={visibleText} />
              : !node.reasoning && !run && node.status === 'streaming'
                ? <p className="assistant-processing-placeholder">正在处理…</p>
                : null}
          </div>}
    </div>
    {!isUser && (node.status === 'interrupted' || node.status === 'failed') && (
      <div className="message-status-notice" role="status">
        <ShieldAlert size={14} />
        <span>{node.error?.message ?? (node.status === 'failed'
          ? '回复生成失败，请重新发送。'
          : '回复生成中断，已保留成功接收的内容。')}</span>
      </div>
    )}
    <div className={`message-action-row message-action-row--${isUser ? 'user' : 'assistant'}`}>
      <time>{node.deliveryState === 'pending'
        ? '发送中…'
        : node.deliveryState === 'failed'
          ? '发送失败'
          : node.time}</time>
      {visibleText && <MessageCopyButton text={visibleText} subject={isUser ? '消息' : '回答'} onCopy={onCopy} />}
      {onFork && <MessageForkButton onFork={onFork} />}
    </div>
  </div>;
}

function MessageCopyButton({ text, subject, onCopy }: { text: string; subject: string; onCopy(text: string): Promise<void> }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const copyResetTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (copyResetTimerRef.current !== null) window.clearTimeout(copyResetTimerRef.current);
  }, []);
  return <button type="button" aria-label={copied ? `已复制${subject}` : `复制${subject}`} onClick={(event) => {
    event.stopPropagation();
    void onCopy(text).then(() => {
      setCopied(true);
      if (copyResetTimerRef.current !== null) window.clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = window.setTimeout(() => setCopied(false), 1_600);
    }).catch(() => setCopied(false));
  }}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>;
}

function MessageForkButton({ onFork }: { onFork(): Promise<void> }): React.JSX.Element {
  const [forking, setForking] = useState(false);
  return <button
    type="button"
    aria-label={forking ? '正在创建对话分支' : '从此消息创建对话分支'}
    title="从此消息创建分支"
    disabled={forking}
    onClick={(event) => {
      event.stopPropagation();
      setForking(true);
      void onFork().finally(() => setForking(false));
    }}
  ><GitFork size={14} /></button>;
}
