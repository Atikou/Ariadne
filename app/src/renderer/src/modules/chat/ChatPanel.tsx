import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowDown, Check, CircleStop, Copy, Hand, Send, Settings2, ShieldAlert, ShieldCheck, Sparkles } from 'lucide-react';
import type {
  ChatRoutingStrategy,
  ModelInferenceOptions,
  ModelSummary,
} from '@ariadne/protocol/public';
import {
  AGENT_PROVIDER_IDS,
  type AgentPermissionMode,
  type AgentSettingsUpdate,
  type AgentSettingsView
} from '@shared/contract';
import { useRuntimeSnapshot, type RuntimeMessage } from '@renderer/core/runtime/runtime-store';
import { formatRuntimeAvailability } from '@renderer/core/runtime/runtime-labels';
import type { FeaturePanelProps } from '@renderer/core/modules/module-contract';
import { SelectMenu, type SelectMenuOption } from '@renderer/shared/ui/SelectMenu';
import { StatusPill } from '@renderer/shared/ui/StatusPill';
import { getCenteredScrollDelta, isScrollNearBottom } from '@shared/scroll-geometry';
import { ConversationOverviewRuler } from './ConversationOverviewRuler';
import { ConversationSidebar } from './ConversationSidebar';
import type { ConversationNode } from './conversation-node';
import { MarkdownMessage } from './MarkdownMessage';

const AUTO_MODEL_ID = '__auto__';
const AUTO_ROUTING_PREFIX = `${AUTO_MODEL_ID}:`;
const routingOptions: readonly SelectMenuOption<ChatRoutingStrategy>[] = [
  { value: 'local-first', label: '本地模型优先' },
  { value: 'cloud-first', label: '远程模型优先' },
  { value: 'privacy-first', label: '隐私优先', description: '仅使用本地模型' },
  { value: 'quality-first', label: '质量优先' }
];
const permissionModeOptions: readonly SelectMenuOption<AgentPermissionMode>[] = [
  { value: 'request', label: '请求批准', description: 'AI 可开始处理，具体写入或运行操作由你批准', icon: <Hand size={16} /> },
  { value: 'risk-based', label: '替我审批', description: '普通文件编辑自动执行，命令和高风险操作再询问', icon: <ShieldCheck size={16} /> },
  { value: 'full-access', label: '完全访问权限', description: 'AI 请求的工具在设置范围内直接执行', icon: <ShieldAlert size={16} />, tone: 'warning' },
  { value: 'custom', label: '自定义 (settings.toml)', description: '使用 settings.toml 中定义的权限', icon: <Settings2 size={16} /> }
];

export function ChatPanel({ moduleId, services }: FeaturePanelProps): React.JSX.Element {
  const runtime = useRuntimeSnapshot(services.runtime);
  const [draft, setDraft] = useState('');
  const [selectedModelId, setSelectedModelId] = useState(AUTO_MODEL_ID);
  const [routingStrategy, setRoutingStrategy] = useState<ChatRoutingStrategy>('local-first');
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode>('request');
  const [settingsSnapshot, setSettingsSnapshot] = useState<AgentSettingsView | null>(null);
  const [savingPermissionMode, setSavingPermissionMode] = useState(false);
  const [inferenceByModel, setInferenceByModel] = useState<Record<string, ModelInferenceOptions>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isAtLatest, setIsAtLatest] = useState(true);
  const viewportRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  const defaultsLoadedRef = useRef(false);
  const selectedSession = runtime.sessions.find((session) => session.sessionId === runtime.selectedSessionId);
  const availableModels = runtime.models.filter((model) => model.availability === 'ready');
  const eligibleModels = routingStrategy === 'privacy-first'
    ? availableModels.filter((model) => model.location === 'local')
    : availableModels;
  const selectedModel = eligibleModels.find((model) => model.id === selectedModelId);
  const selectedInference = selectedModel
    ? inferenceByModel[selectedModel.id] ?? defaultInference(selectedModel)
    : undefined;
  const reasoning = selectedModel?.inference?.reasoning;
  const canChat = runtime.status.availability === 'ready' && eligibleModels.length > 0;
  const modelOptions = useMemo<readonly SelectMenuOption<string>[]>(() => [
    {
      value: AUTO_MODEL_ID,
      label: '自动选择模型',
      description: '按路由策略选择',
      children: routingOptions.map((option) => ({
        ...option,
        value: routingSelectionValue(option.value)
      }))
    },
    ...eligibleModels.map((model) => ({
      value: model.id,
      label: model.label,
      description: model.location === 'local' ? '本地模型' : '远程模型'
    }))
  ], [eligibleModels]);
  const modelSelectionValue = selectedModelId === AUTO_MODEL_ID
    ? routingSelectionValue(routingStrategy)
    : selectedModelId;
  const nodes = useMemo(() => runtime.messages.map(toConversationNode), [runtime.messages]);
  const activeRun = runtime.runs.find((run) => run.sessionId === runtime.selectedSessionId && [
    'queued', 'running', 'waiting_permission', 'waiting_plan_handoff'
  ].includes(run.status));
  const running = Boolean(activeRun);
  const sending = runtime.messages.some((message) => message.deliveryState === 'pending');

  useEffect(() => {
    if (defaultsLoadedRef.current) return;
    defaultsLoadedRef.current = true;
    void services.agentSettings.load().then((settings) => {
      setRoutingStrategy(settings.routingStrategy);
      setPermissionMode(settings.permissionMode);
      setSettingsSnapshot(settings);
    }).catch(() => undefined);
  }, [services.agentSettings]);

  const changePermissionMode = async (nextPermissionMode: AgentPermissionMode): Promise<void> => {
    if (savingPermissionMode || nextPermissionMode === permissionMode) return;
    const previous = permissionMode;
    setPermissionMode(nextPermissionMode);
    setSavingPermissionMode(true);
    try {
      const settings = settingsSnapshot ?? await services.agentSettings.load();
      const providers = Object.fromEntries(AGENT_PROVIDER_IDS.map((id) => {
        const provider = settings.providers[id];
        return [id, {
          enabled: provider.enabled,
          baseUrl: provider.baseUrl,
          model: provider.model,
          inference: provider.inference,
          clearApiKey: false
        }];
      })) as AgentSettingsUpdate['providers'];
      const saved = await services.agentSettings.update({
        routingStrategy: settings.routingStrategy,
        permissionMode: nextPermissionMode,
        customPermissions: settings.customPermissions,
        workspaceRoot: settings.workspaceRoot,
        workspaceAccess: settings.workspaceAccess,
        localModelRoots: settings.localModelRoots,
        providers
      });
      setSettingsSnapshot(saved);
      setPermissionMode(saved.permissionMode);
      services.events.emit('chat:workspace-access-changed', saved.workspaceAccess);
    } catch (error) {
      setPermissionMode(previous);
      console.error('Unable to save the Agent permission mode.', error);
    } finally {
      setSavingPermissionMode(false);
    }
  };

  useEffect(() => {
    if (selectedModelId !== AUTO_MODEL_ID && !eligibleModels.some((model) => model.id === selectedModelId)) {
      setSelectedModelId(AUTO_MODEL_ID);
    }
  }, [eligibleModels, selectedModelId]);

  useEffect(() => {
    setInferenceByModel((current) => {
      const next = { ...current };
      let changed = false;
      for (const model of availableModels) {
        const existing = next[model.id];
        if (existing && inferenceSupported(model, existing)) continue;
        const defaults = defaultInference(model);
        if (!existing && Object.keys(defaults).length === 0) continue;
        if (Object.keys(defaults).length > 0) next[model.id] = defaults;
        else delete next[model.id];
        changed = true;
      }
      return changed ? next : current;
    });
  }, [runtime.models]);

  useEffect(() => {
    setActiveId((current) => current && nodes.some((node) => node.id === current)
      ? current
      : nodes[0]?.id ?? null);
  }, [nodes]);

  const setFollowingLatest = useCallback((value: boolean): void => {
    followLatestRef.current = value;
    setIsAtLatest((current) => current === value ? current : value);
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !followLatestRef.current) return;
    viewport.scrollTop = viewport.scrollHeight;
    setFollowingLatest(true);
  }, [nodes.length, setFollowingLatest]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (!followLatestRef.current || frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        viewport.scrollTop = viewport.scrollHeight;
        setFollowingLatest(true);
      });
    });
    observer.observe(viewport);
    if (messageListRef.current) observer.observe(messageListRef.current);
    return () => {
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [setFollowingLatest]);

  const send = async (): Promise<void> => {
    const message = draft;
    if (!message.trim() || running || sending || !canChat) return;
    setDraft('');
    setFollowingLatest(true);
    try {
      const workspaceId = selectedSession?.workspaceId
        ?? services.conversationNavigation.getSelectedWorkspaceId()
        ?? undefined;
      await services.runtime.sendMessage(message, {
        ...(selectedModelId !== AUTO_MODEL_ID ? { modelId: selectedModelId } : {}),
        ...(selectedInference ? { inference: selectedInference } : {}),
        routingStrategy,
        ...(workspaceId ? { workspaceId } : {})
      });
    } catch {
      setDraft(message);
    }
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const handleViewportScroll = (): void => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    setFollowingLatest(isScrollNearBottom(viewport.scrollTop, viewport.clientHeight, viewport.scrollHeight));
    const readingLine = viewport.getBoundingClientRect().top + viewport.clientHeight * 0.32;
    let nearest: { id: string; distance: number } | null = null;
    for (const node of nodes) {
      const element = document.getElementById(`chat-node-${node.id}`);
      if (!element) continue;
      const distance = Math.abs(element.getBoundingClientRect().top - readingLine);
      if (!nearest || distance < nearest.distance) nearest = { id: node.id, distance };
    }
    if (nearest) setActiveId(nearest.id);
  };

  const jumpToNode = (id: string): void => {
    const viewport = viewportRef.current;
    const target = document.getElementById(`chat-node-${id}`);
    if (viewport && target && viewport.contains(target)) {
      const viewportBounds = viewport.getBoundingClientRect();
      const targetBounds = target.getBoundingClientRect();
      viewport.scrollTo({
        top: Math.max(0, viewport.scrollTop + getCenteredScrollDelta(
          viewportBounds.top,
          viewport.clientHeight,
          targetBounds.top,
          targetBounds.height
        )),
        behavior: 'smooth'
      });
    }
    setSelectedId(id);
    setActiveId(id);
  };

  return (
    <section className="chat-panel" aria-labelledby={`${moduleId}-title`}>
      <ConversationSidebar services={services} />
      <div className="chat-conversation">
        <header className="chat-header">
          <div>
            <h1 id={`${moduleId}-title`}>{selectedSession?.title ?? 'Ariadne 助手'}</h1>
            <span className="chat-subtitle"><span className="presence-dot" /> Runtime {formatRuntimeAvailability(runtime.status.availability)}</span>
          </div>
          <div className="chat-header-meta">
            <StatusPill tone={running
              ? 'running'
              : runtime.status.availability !== 'ready'
                ? 'danger'
                : availableModels.length > 0
                  ? 'success'
                  : 'warning'}>
              {activeRun?.userFacingLabel
                ?? (runtime.status.availability === 'ready' && availableModels.length === 0
                  ? '未配置模型'
                  : formatRuntimeAvailability(runtime.status.availability))}
            </StatusPill>
          </div>
        </header>

        <div className="message-stage">
          <div className="message-viewport" ref={viewportRef} onScroll={handleViewportScroll}>
            {nodes.length === 0 ? <EmptyConversation hasModel={availableModels.length > 0} /> : (
              <div className="message-list" ref={messageListRef}>
                {nodes.map((node) => (
                  <div id={`chat-node-${node.id}`} data-conversation-node key={node.id} className={`conversation-node conversation-node--${node.kind}`}>
                    <ConversationMessage
                      node={node}
                      onCopy={(text) => services.clipboard.writeText({ text })}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
          <ConversationOverviewRuler nodes={nodes} activeId={activeId} selectedId={selectedId} onSelect={jumpToNode} />
          {!isAtLatest && nodes.length > 0 && (
            <button type="button" className="jump-to-latest-button" aria-label="跳转到最新消息" onClick={() => {
              viewportRef.current?.scrollTo({ top: viewportRef.current.scrollHeight, behavior: 'smooth' });
            }}><ArrowDown size={18} strokeWidth={1.8} /></button>
          )}
        </div>

        <div className="composer-wrap">
          <div className="composer">
            <textarea
              value={draft}
              rows={1}
              placeholder={runtime.status.availability !== 'ready'
                ? 'Runtime 当前不可用'
                : availableModels.length === 0
                  ? '请先在设置中配置 API Key 或本地模型目录'
                  : '向 Ariadne 发送消息；按 Shift + Enter 换行'}
              aria-label="消息输入框"
              disabled={!canChat}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onComposerKeyDown}
            />
            <div className="composer-toolbar">
              <div className="composer-model-controls">
                <SelectMenu<string>
                  className="composer-model-menu"
                  ariaLabel="选择模型"
                  placement="top"
                  value={modelSelectionValue}
                  options={modelOptions}
                  onChange={(nextValue) => {
                    const nextStrategy = parseRoutingSelectionValue(nextValue);
                    if (nextStrategy) {
                      setRoutingStrategy(nextStrategy);
                      setSelectedModelId(AUTO_MODEL_ID);
                    } else {
                      setSelectedModelId(nextValue);
                    }
                  }}
                />
                {reasoning && reasoning.modes.length > 1 && selectedInference?.reasoningMode && (
                  <SelectMenu
                    className="composer-inference-menu"
                    ariaLabel="选择推理模式"
                    placement="top"
                    value={selectedInference.reasoningMode}
                    options={reasoning.modes.map((value) => ({ value, label: reasoningModeLabel(value) }))}
                    onChange={(reasoningMode) => setInferenceByModel((current) => ({
                      ...current,
                      [selectedModelId]: { ...selectedInference, reasoningMode }
                    }))}
                  />
                )}
                {reasoning && reasoning.efforts.length > 1 && selectedInference?.reasoningEffort && (
                  <SelectMenu
                    className="composer-inference-menu"
                    ariaLabel="选择推理强度"
                    placement="top"
                    value={selectedInference.reasoningEffort}
                    options={reasoning.efforts.map((value) => ({ value, label: `推理 ${reasoningEffortLabel(value)}` }))}
                    onChange={(reasoningEffort) => setInferenceByModel((current) => ({
                      ...current,
                      [selectedModelId]: { ...selectedInference, reasoningEffort }
                    }))}
                  />
                )}
                {reasoning && reasoning.modes.length === 1 && reasoning.efforts.length === 0 && (
                  <span className="composer-inference-fixed">{reasoningModeLabel(reasoning.defaultMode)}</span>
                )}
              </div>
              <div className="composer-action-controls">
                <SelectMenu<AgentPermissionMode>
                  className="composer-permission-mode-menu"
                  ariaLabel="选择 Agent 权限模式"
                  placement="top"
                  value={permissionMode}
                  options={permissionModeOptions}
                  disabled={savingPermissionMode}
                  onChange={(nextPermissionMode) => void changePermissionMode(nextPermissionMode)}
                />
                <button
                  type="button"
                  className={`send-button${running ? ' send-button--stop' : ''}`}
                  disabled={sending || (!running && (!draft.trim() || !canChat))}
                  onClick={() => running && activeRun
                    ? void services.runtime.cancelRun(activeRun)
                    : void send()}
                  aria-label={running ? activeRun?.origin === 'agent' ? '取消 Agent 任务' : '停止生成' : '发送消息'}
                >
                  {running ? <CircleStop size={17} /> : <Send size={16} />}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function routingSelectionValue(strategy: ChatRoutingStrategy): string {
  return `${AUTO_ROUTING_PREFIX}${strategy}`;
}

function parseRoutingSelectionValue(value: string): ChatRoutingStrategy | null {
  if (!value.startsWith(AUTO_ROUTING_PREFIX)) return null;
  const strategy = value.slice(AUTO_ROUTING_PREFIX.length);
  return routingOptions.some((option) => option.value === strategy)
    ? strategy as ChatRoutingStrategy
    : null;
}

function defaultInference(model: ModelSummary): ModelInferenceOptions {
  const reasoning = model.inference?.reasoning;
  if (!reasoning) return {};
  return {
    reasoningMode: reasoning.defaultMode,
    ...(reasoning.defaultEffort ? { reasoningEffort: reasoning.defaultEffort } : {})
  };
}

function inferenceSupported(model: ModelSummary, inference: ModelInferenceOptions): boolean {
  const reasoning = model.inference?.reasoning;
  if (!reasoning) return !inference.reasoningMode && !inference.reasoningEffort;
  return Boolean(inference.reasoningMode && reasoning.modes.includes(inference.reasoningMode))
    && (!inference.reasoningEffort || reasoning.efforts.includes(inference.reasoningEffort));
}

function reasoningModeLabel(value: 'off' | 'on' | 'auto' | 'pro'): string {
  return { off: '推理关闭', on: '推理开启', auto: '推理自动', pro: '推理 Pro' }[value];
}

function reasoningEffortLabel(value: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'): string {
  return { none: '无', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高' }[value];
}

function EmptyConversation({ hasModel }: { hasModel: boolean }): React.JSX.Element {
  return <div className="empty-conversation"><span><Sparkles size={21} /></span><h2>{hasModel ? '开始新会话' : '先配置可用模型'}</h2><p>{hasModel
    ? '描述你的目标，AI 会直接开始处理；只有实际工具权限不足时，Ariadne 才会向你确认具体操作。'
    : '打开设置，填写 OpenAI、DeepSeek、Kimi 或 Anthropic API Key，也可以添加本地模型目录。'}</p></div>;
}

function toConversationNode(message: RuntimeMessage): ConversationNode {
  const content = message.content || (message.status === 'streaming' ? '正在思考…' : '');
  const kind = message.role === 'user'
    ? 'user'
    : message.status === 'streaming'
      ? 'streaming'
      : message.status === 'interrupted' || message.status === 'failed'
        ? 'error'
        : 'assistant';
  return {
    id: message.messageId,
    kind,
    sender: message.role === 'user' ? '你' : 'Ariadne',
    time: new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    summary: content.slice(0, 160),
    content,
    status: message.status,
    ...(message.deliveryState ? { deliveryState: message.deliveryState } : {}),
    ...(message.error ? { error: message.error } : {})
  };
}

function ConversationMessage({ node, onCopy }: { node: ConversationNode; onCopy(text: string): Promise<void> }): React.JSX.Element {
  const text = node.content ?? node.summary;
  const isUser = node.kind === 'user';
  return <div className={isUser ? 'user-message-block' : 'assistant-message-block'}>
    <div className={isUser ? 'user-message' : 'assistant-message'}>
      {isUser ? <p className="message-content">{text}</p> : <MarkdownMessage markdown={text} />}
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
      <MessageCopyButton text={text} subject={isUser ? '消息' : '回答'} onCopy={onCopy} />
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
