import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  ArrowDown, Bot, Check, CircleStop, Copy, Ellipsis, Image, Mic, Paperclip, Pencil, Send,
  ShieldCheck, Sparkles, TriangleAlert, User, Wrench, X
} from 'lucide-react';
import { useMockScenario } from '@renderer/core/mock/mock-scenario';
import type { FeaturePanelProps } from '@renderer/core/modules/module-contract';
import { SelectMenu, type SelectMenuOption } from '@renderer/shared/ui/SelectMenu';
import { StatusPill } from '@renderer/shared/ui/StatusPill';
import { getCenteredScrollDelta, isScrollNearBottom } from '@shared/scroll-geometry';
import { AgentExecutionCard } from './AgentExecutionCard';
import { ConversationOverviewRuler } from './ConversationOverviewRuler';
import { getConversationNodes, type ConversationNode } from './mock-chat-data';
import { PermissionRequestCard } from './PermissionRequestCard';

type ModelId = 'gpt-5' | 'gpt-5-mini';

interface LocalMessage {
  id: string;
  text: string;
  time: string;
}

function formatMessageTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

const modelOptions: readonly SelectMenuOption<ModelId>[] = [
  { value: 'gpt-5', label: 'GPT-5', description: '高质量推理' },
  { value: 'gpt-5-mini', label: 'GPT-5 mini', description: '快速响应' }
];

export function ChatPanel({ moduleId, services }: FeaturePanelProps): React.JSX.Element {
  const scenario = useMockScenario(services.mock);
  const nodes = useMemo(() => getConversationNodes(scenario), [scenario]);
  const [activeId, setActiveId] = useState<string | null>(nodes[0]?.id ?? null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [localMessages, setLocalMessages] = useState<LocalMessage[]>([]);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [listening, setListening] = useState(false);
  const [model, setModel] = useState<ModelId>('gpt-5');
  const [isAtLatest, setIsAtLatest] = useState(true);
  const viewportRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const localNodes = useMemo<ConversationNode[]>(() => localMessages.map((message) => ({
    id: message.id,
    kind: 'user',
    sender: '你',
    time: message.time,
    summary: message.text,
    content: message.text
  })), [localMessages]);
  const conversationNodes = useMemo(() => [...nodes, ...localNodes], [localNodes, nodes]);
  const hasMessages = conversationNodes.length > 0;

  const setFollowingLatest = useCallback((value: boolean): void => {
    followLatestRef.current = value;
    setIsAtLatest((current) => current === value ? current : value);
  }, []);

  useEffect(() => {
    setActiveId((current) => (
      current && conversationNodes.some((node) => node.id === current)
        ? current
        : conversationNodes[0]?.id ?? null
    ));
  }, [conversationNodes]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (!hasMessages) {
      setFollowingLatest(true);
      return;
    }
    if (!followLatestRef.current) return;
    viewport.scrollTop = viewport.scrollHeight;
    setFollowingLatest(true);
  }, [conversationNodes.length, hasMessages, setFollowingLatest]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const observer = new ResizeObserver(() => {
      if (followLatestRef.current) {
        viewport.scrollTop = viewport.scrollHeight;
        setFollowingLatest(true);
      } else if (isScrollNearBottom(viewport.scrollTop, viewport.clientHeight, viewport.scrollHeight)) {
        setFollowingLatest(true);
      }
    });

    observer.observe(viewport);
    if (messageListRef.current) observer.observe(messageListRef.current);
    return () => observer.disconnect();
  }, [hasMessages, setFollowingLatest]);

  const jumpToNode = (id: string): void => {
    const viewport = viewportRef.current;
    const target = document.getElementById(`chat-node-${id}`);
    if (viewport && target && viewport.contains(target)) {
      const viewportBounds = viewport.getBoundingClientRect();
      const targetBounds = target.getBoundingClientRect();
      const delta = getCenteredScrollDelta(
        viewportBounds.top,
        viewport.clientHeight,
        targetBounds.top,
        targetBounds.height
      );
      viewport.scrollTo({
        top: Math.max(0, viewport.scrollTop + delta),
        behavior: 'smooth'
      });
    }
    setSelectedId(id);
    setActiveId(id);
  };

  const updateActiveNode = (): void => {
    const viewport = viewportRef.current;
    if (!viewport || conversationNodes.length === 0) return;
    const readingLine = viewport.getBoundingClientRect().top + viewport.clientHeight * 0.32;
    let nearest: { id: string; distance: number } | null = null;
    for (const node of conversationNodes) {
      const element = document.getElementById(`chat-node-${node.id}`);
      if (!element) continue;
      const distance = Math.abs(element.getBoundingClientRect().top - readingLine);
      if (!nearest || distance < nearest.distance) nearest = { id: node.id, distance };
    }
    if (nearest) setActiveId(nearest.id);
  };

  const handleViewportScroll = (): void => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    setFollowingLatest(isScrollNearBottom(viewport.scrollTop, viewport.clientHeight, viewport.scrollHeight));
    updateActiveNode();
  };

  const scrollToLatest = (): void => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' });
  };

  const submitLocalMessage = (content: string): void => {
    const normalized = content.trim();
    if (!normalized) return;
    setFollowingLatest(true);
    setLocalMessages((messages) => [...messages, {
      id: `local-user-${crypto.randomUUID()}`,
      text: normalized,
      time: formatMessageTime(new Date())
    }]);
    services.events.emit('agent:activity-recorded', {
      id: crypto.randomUUID(), kind: 'agent-run', message: '已提交一条 Mock 消息', timestamp: new Date().toISOString()
    });
  };

  const send = (): void => {
    const content = draft.trim();
    if (!content) return;
    submitLocalMessage(content);
    setDraft('');
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  const running = scenario === 'running' || scenario === 'streaming';

  return (
    <section className="chat-panel" aria-labelledby={`${moduleId}-title`}>
      <header className="chat-header">
        <div>
          <h1 id={`${moduleId}-title`}>完善桌面端模块化架构</h1>
          <span className="chat-subtitle"><span className="presence-dot" /> 本地 Mock 会话</span>
        </div>
        <div className="chat-header-meta">
          <StatusPill tone={running ? 'running' : scenario === 'complete' ? 'success' : 'neutral'}>
            {running ? '执行中' : scenario === 'complete' ? '已完成' : '就绪'}
          </StatusPill>
          <span className="model-label">GPT-5</span>
          <button className="bare-icon-button" type="button" aria-label="更多会话操作"><Ellipsis size={17} /></button>
        </div>
      </header>

      <div className="message-stage">
        <div className="message-viewport" ref={viewportRef} onScroll={handleViewportScroll}>
          {conversationNodes.length === 0 ? <EmptyConversation /> : (
            <div className="message-list" ref={messageListRef}>
              {conversationNodes.map((node) => (
                <div
                  id={`chat-node-${node.id}`}
                  data-conversation-node
                  key={node.id}
                  className={`conversation-node conversation-node--${node.kind}${selectedId === node.id ? ' is-selected' : ''}`}
                  onClick={() => setSelectedId(node.id)}
                >
                  <ConversationNodeContent
                    node={node}
                    onCopy={(text) => services.clipboard.writeText({ text })}
                    onRewriteSubmit={submitLocalMessage}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
        <ConversationOverviewRuler nodes={conversationNodes} activeId={activeId} selectedId={selectedId} onSelect={jumpToNode} />
        {!isAtLatest && hasMessages && (
          <button
            type="button"
            className="jump-to-latest-button"
            aria-label="跳转到最新消息"
            onClick={scrollToLatest}
          >
            <ArrowDown size={18} strokeWidth={1.8} />
          </button>
        )}
      </div>

      <div className="composer-wrap">
        {attachments.length > 0 && <div className="attachment-row">{attachments.map((name) => <span key={name}>{name}<button onClick={() => setAttachments((items) => items.filter((item) => item !== name))}><X size={11} /></button></span>)}</div>}
        <div className="composer">
          <textarea
            value={draft}
            rows={1}
            placeholder="向 Ariadne 发送消息，Shift + Enter 换行"
            aria-label="消息输入"
            onChange={(event) => {
              setDraft(event.target.value);
              event.target.style.height = 'auto';
              event.target.style.height = `${Math.min(event.target.scrollHeight, 144)}px`;
            }}
            onKeyDown={onComposerKeyDown}
          />
          <div className="composer-toolbar">
            <div>
              <input ref={fileInputRef} hidden multiple type="file" onChange={(event) => setAttachments(Array.from(event.target.files ?? []).map((file) => file.name))} />
              <button type="button" className="composer-tool" title="添加文件" onClick={() => fileInputRef.current?.click()}><Paperclip size={16} /></button>
              <button type="button" className="composer-tool" title="添加图片" onClick={() => fileInputRef.current?.click()}><Image size={16} /></button>
              <button type="button" className={`composer-tool${listening ? ' is-active' : ''}`} title="语音输入" onClick={() => setListening((value) => !value)}><Mic size={16} /></button>
              <SelectMenu<ModelId> className="composer-model-menu" ariaLabel="选择模型" placement="top" value={model} options={modelOptions} onChange={setModel} />
              <span className="composer-permission"><ShieldCheck size={13} /> 工作区受控</span>
            </div>
            <button
              type="button"
              className={`send-button${running ? ' send-button--stop' : ''}`}
              disabled={!running && !draft.trim()}
              onClick={() => running ? services.mock.setScenario('cancelled') : send()}
              aria-label={running ? '停止生成' : '发送消息'}
            >
              {running ? <CircleStop size={17} /> : <Send size={16} />}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function EmptyConversation(): React.JSX.Element {
  return <div className="empty-conversation"><span><Sparkles size={21} /></span><h2>开始一个新的桌面任务</h2><p>描述目标，Ariadne 会先给出计划，并在需要系统权限时明确请求确认。</p></div>;
}

interface ConversationNodeContentProps {
  node: ConversationNode;
  onCopy(text: string): Promise<void>;
  onRewriteSubmit(text: string): void;
}

function ConversationNodeContent({ node, onCopy, onRewriteSubmit }: ConversationNodeContentProps): React.JSX.Element {
  switch (node.kind) {
    case 'user':
      return <UserConversationMessage node={node} onCopy={onCopy} onRewriteSubmit={onRewriteSubmit} />;
    case 'assistant':
      return <AssistantConversationMessage node={node} onCopy={onCopy} />;
    case 'streaming':
      return <div className="assistant-message"><span className="message-avatar"><Bot size={15} /></span><div><p>正在整理模块契约和 IPC 校验规则<span className="streaming-dots"><i /><i /><i /></span></p></div></div>;
    case 'proposal':
      return <AgentExecutionCard status="waiting" title="执行提案" summary="架构契约 → 桌面壳 → UI 验证" details="1. 定义跨进程 DTO\n2. 实现 Dockview 模块注册\n3. 构建并启动 Electron" />;
    case 'permission': return <PermissionRequestCard />;
    case 'execution':
      return <div className="execution-stack"><AgentExecutionCard status="success" title="已读取项目配置" duration="1.8s" summary="确认 Electron + Vite 构建入口" details="package.json\napp/package.json\napp/electron.vite.config.ts" /><AgentExecutionCard status="running" title="正在分析模块目录" summary="检查模块依赖方向与布局契约" details="Scanning app/src/renderer/src/modules ..." /><AgentExecutionCard status="warning" title="等待批准执行 PowerShell" summary="将运行类型检查和生产构建" details="npm run typecheck && npm run build" /></div>;
    case 'tool':
      return <AgentExecutionCard status="success" title="工具执行完成" duration="4.2s" summary="类型检查、测试和生产构建均通过" details="7 tests passed\nMain / Preload / Renderer compiled\nout/ generated" />;
    case 'error':
      return <AgentExecutionCard status="failed" title="命令执行失败" duration="0.2s" summary="PowerShell 执行策略阻止了 npm.ps1" details="PSSecurityException: running scripts is disabled\n建议改用 npm.cmd" />;
    case 'cancelled':
      return <div className="notice-row notice-row--muted"><X size={15} /><div><strong>任务已取消</strong><p>没有继续执行剩余工具调用。</p></div></div>;
    case 'complete':
      return <div className="completion-summary"><span><Check size={17} /></span><div><strong>任务完成</strong><p>桌面壳、模块运行时、布局持久化和安全边界均已验证。</p></div></div>;
    case 'offline':
      return <div className="notice-row notice-row--warning"><TriangleAlert size={16} /><div><strong>Runtime 尚未接入</strong><p>当前仍可浏览本地 Mock 会话和调整工作区布局。</p></div></div>;
  }
}

interface MessageCopyButtonProps {
  text: string;
  subject: '回答' | '消息';
  onCopy(text: string): Promise<void>;
}

function MessageCopyButton({ text, subject, onCopy }: MessageCopyButtonProps): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const copyResetTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (copyResetTimerRef.current !== null) window.clearTimeout(copyResetTimerRef.current);
  }, []);

  const copyMessage = async (): Promise<void> => {
    try {
      await onCopy(text);
      setCopied(true);
      if (copyResetTimerRef.current !== null) window.clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = window.setTimeout(() => setCopied(false), 1600);
    } catch (error: unknown) {
      console.error(`Unable to copy ${subject}`, error);
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      aria-label={copied ? `${subject}已复制` : `复制${subject}`}
      onClick={(event) => {
        event.stopPropagation();
        void copyMessage();
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

interface AssistantConversationMessageProps {
  node: ConversationNode;
  onCopy(text: string): Promise<void>;
}

function AssistantConversationMessage({ node, onCopy }: AssistantConversationMessageProps): React.JSX.Element {
  const text = node.content ?? node.summary;
  const paragraphs = text.split(/\n{2,}/);

  return (
    <div className="assistant-message-block">
      <div className="assistant-message">
        <span className="message-avatar"><Bot size={15} /></span>
        <div>{paragraphs.map((paragraph, index) => <p key={`${node.id}-${index}`}>{paragraph}</p>)}</div>
      </div>
      <div className="message-action-row message-action-row--assistant" aria-label="回答操作">
        <time>{node.time}</time>
        <MessageCopyButton text={text} subject="回答" onCopy={onCopy} />
      </div>
    </div>
  );
}

interface UserConversationMessageProps {
  node: ConversationNode;
  onCopy(text: string): Promise<void>;
  onRewriteSubmit(text: string): void;
}

function UserConversationMessage({ node, onCopy, onRewriteSubmit }: UserConversationMessageProps): React.JSX.Element {
  const text = node.content ?? node.summary;
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(text);

  const beginRewrite = (): void => {
    setEditDraft(text);
    setEditing(true);
  };

  const cancelRewrite = (): void => {
    setEditDraft(text);
    setEditing(false);
  };

  const submitRewrite = (): void => {
    const normalized = editDraft.trim();
    if (!normalized) return;
    onRewriteSubmit(normalized);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="user-message-edit-row">
        <div className="user-message-editor">
          <textarea
            autoFocus
            aria-label="改写消息"
            value={editDraft}
            onChange={(event) => setEditDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') cancelRewrite();
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) submitRewrite();
            }}
          />
          <div className="rewrite-action-row">
            <button type="button" className="rewrite-cancel-button" onClick={cancelRewrite}>取消</button>
            <button type="button" className="rewrite-send-button" disabled={!editDraft.trim()} onClick={submitRewrite}>发送</button>
          </div>
        </div>
        <span className="message-avatar"><User size={14} /></span>
      </div>
    );
  }

  return (
    <div className="user-message-block">
      <div className="user-message"><span className="message-avatar"><User size={14} /></span><p>{text}</p></div>
      <div className="message-action-row message-action-row--user" aria-label="消息操作">
        <time>{node.time}</time>
        <MessageCopyButton text={text} subject="消息" onCopy={onCopy} />
        <button type="button" aria-label="改写消息" onClick={beginRewrite}><Pencil size={14} /></button>
      </div>
    </div>
  );
}
