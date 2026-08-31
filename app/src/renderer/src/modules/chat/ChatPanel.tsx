import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowDown, Check, Copy, Folder, GitFork, Hand, Image as ImageIcon, Mic, MicOff, Send, Settings2, ShieldAlert, ShieldCheck, Sparkles, X } from 'lucide-react';
import type {
  ChatRoutingStrategy,
  EncodedImageAttachmentV3,
  ModelInferenceOptions,
  ModelSummary,
} from '@ariadne/protocol/public';
import {
  IMAGE_ATTACHMENT_MEDIA_TYPES_V3,
  MAX_IMAGE_ATTACHMENTS_PER_MESSAGE_V3,
  MAX_IMAGE_ATTACHMENT_MESSAGE_BYTES_V3,
  MAX_IMAGE_ATTACHMENT_SOURCE_BYTES_V3,
  PERSONAL_ASSISTANT_WORKSPACE_ID
} from '@ariadne/protocol/public';
import type { AgentPermissionMode, AgentSettingsView } from '@shared/contract';
import {
  type RuntimeMessage,
  type RuntimeRun
} from '@renderer/core/runtime/runtime-store';
import { useFeatureSnapshot } from '@renderer/core/runtime/features/feature-snapshot-store';
import { formatRuntimeAvailability } from '@renderer/core/runtime/runtime-labels';
import { moduleId, type FeaturePanelProps } from '@renderer/core/modules/module-contract';
import { SelectMenu, type SelectMenuOption } from '@renderer/shared/ui/SelectMenu';
import { StatusPill } from '@renderer/shared/ui/StatusPill';
import { getCenteredScrollDelta, isScrollNearBottom } from '@shared/scroll-geometry';
import { calculateComposerTextareaLayout } from '@shared/composer-textarea-layout';
import { ConversationOverviewRuler } from './ConversationOverviewRuler';
import { ConversationSidebar } from './ConversationSidebar';
import { shouldShowFormalAnswer, type ConversationNode } from './conversation-node';
import { MarkdownMessage } from './MarkdownMessage';
import { RunProcessingDisclosure } from './RunProcessingDisclosure';
import { ConversationApprovalCards } from '@renderer/app/ApprovalCenter';
import { ComposerAddMenu } from './ComposerAddMenu';
import { deriveChatModelState, type ChatModelState } from './chat-model-state';
import type { ConversationWorkspace } from '@renderer/core/conversations/conversation-navigation-service';
import { useConversationPresentationRevision } from '@renderer/core/conversations/use-conversation-presentation';
import { useSpeechSnapshot } from '@renderer/core/speech/speech-coordinator';
import './ImageAttachments.css';
import './AgentInputDelivery.css';

const AUTO_MODEL_ID = '__auto__';
const AUTO_ROUTING_PREFIX = `${AUTO_MODEL_ID}:`;
const SESSION_ACTIVITY_MODULE_ID = moduleId('session.activity');
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

interface DraftImageAttachment extends EncodedImageAttachmentV3 {
  readonly clientId: string;
  readonly bytes: number;
}

export function ChatPanel({ moduleId, services }: FeaturePanelProps): React.JSX.Element {
  const diagnostics = useFeatureSnapshot(services.diagnostics.view);
  const messages = useFeatureSnapshot(services.messages.view);
  const models = useFeatureSnapshot(services.models.view);
  const runs = useFeatureSnapshot(services.runs.view);
  const sessions = useFeatureSnapshot(services.sessions.view);
  const runtime = { ...diagnostics, ...messages, ...models, ...runs, ...sessions };
  const speech = useSpeechSnapshot(services.speech);
  useConversationPresentationRevision(services.conversationNavigation);
  const [draft, setDraft] = useState('');
  const [draftImages, setDraftImages] = useState<readonly DraftImageAttachment[]>([]);
  const [draftImageError, setDraftImageError] = useState<string | null>(null);
  const [conversationActionError, setConversationActionError] = useState<string | null>(null);
  const [selectedModelId, setSelectedModelId] = useState(AUTO_MODEL_ID);
  const [routingStrategy, setRoutingStrategy] = useState<ChatRoutingStrategy>('local-first');
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode>('request');
  const [settingsSnapshot, setSettingsSnapshot] = useState<AgentSettingsView | null>(null);
  const [workspaces, setWorkspaces] = useState<readonly ConversationWorkspace[]>([]);
  const [draftWorkspaceId, setDraftWorkspaceId] = useState<string | null>(null);
  const [savingPermissionMode, setSavingPermissionMode] = useState(false);
  const [inferenceByModel, setInferenceByModel] = useState<Record<string, ModelInferenceOptions>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isAtLatest, setIsAtLatest] = useState(true);
  const [editingInbox, setEditingInbox] = useState<{
    inputId: string;
    version: number;
    content: string;
  } | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const followLatestRef = useRef(true);
  const defaultsLoadedRef = useRef(false);
  const speechDraftBasesRef = useRef(new Map<string, string>());
  const selectedSession = runtime.sessions.find((session) => session.sessionId === runtime.selectedSessionId);
  const composerWorkspaceId = selectedSession?.workspaceId
    ?? draftWorkspaceId
    ?? PERSONAL_ASSISTANT_WORKSPACE_ID;
  const assistantMode = composerWorkspaceId === PERSONAL_ASSISTANT_WORKSPACE_ID;
  const planModeAvailable = runtime.status.availability === 'ready'
    && runtime.status.capabilities.includes('companion.agent-plan')
    && !assistantMode;
  const planModeEnabled = !assistantMode
    && services.sessions.isPlanModeEnabled(runtime.selectedSessionId);
  const modelState = useMemo(() => deriveChatModelState({
    runtimeAvailability: runtime.status.availability,
    planModeAvailable,
    planModeEnabled,
    routingStrategy,
    models: runtime.models
  }), [
    runtime.status.availability,
    planModeAvailable,
    planModeEnabled,
    routingStrategy,
    runtime.models
  ]);
  const availableModels = modelState.readyModels;
  const eligibleModels = modelState.eligibleModels;
  const selectedModel = eligibleModels.find((model) => model.id === selectedModelId);
  const automaticVisionModel = eligibleModels.find((model) => model.supportsVision);
  const effectiveVisionModel = selectedModelId === AUTO_MODEL_ID
    ? automaticVisionModel
    : selectedModel?.supportsVision
      ? selectedModel
      : undefined;
  const selectedInference = selectedModel
    ? inferenceByModel[selectedModel.id] ?? defaultInference(selectedModel)
    : undefined;
  const reasoning = selectedModel?.inference?.reasoning;
  const canChat = modelState.canChat;
  const modelOptions = useMemo<readonly SelectMenuOption<string>[]>(() => [
    {
      value: AUTO_MODEL_ID,
      label: '自动选择模型',
      description: planModeEnabled ? '按 Agent 能力选择' : '按路由策略选择',
      ...(planModeEnabled
        ? {}
        : {
            children: routingOptions.map((option) => ({
              ...option,
              value: routingSelectionValue(option.value)
            }))
          })
    },
    ...eligibleModels.map((model) => ({
      value: model.id,
      label: model.label,
      description: model.location === 'local' ? '本地模型' : '远程模型'
    }))
  ], [eligibleModels, planModeEnabled]);
  const modelSelectionValue = selectedModelId === AUTO_MODEL_ID
    ? planModeEnabled
      ? AUTO_MODEL_ID
      : routingSelectionValue(routingStrategy)
    : selectedModelId;
  const workspaceOptions = useMemo<readonly SelectMenuOption<string>[]>(() => {
    return [
      {
        value: PERSONAL_ASSISTANT_WORKSPACE_ID,
        label: '个人助手',
        description: '全电脑只读；不能修改文件或执行命令'
      },
      ...workspaces.map((workspace) => ({
        value: workspace.workspaceId,
        label: workspace.name,
        description: `Agent 工作区 · ${workspace.rootPath}`
      }))
    ];
  }, [workspaces]);
  const nodes = useMemo(() => runtime.messages.map(toConversationNode), [runtime.messages]);
  const activeRun = runtime.runs.find((run) => run.parentRunId === undefined && run.sessionId === runtime.selectedSessionId && [
    'queued', 'running', 'waiting_permission', 'waiting_decision', 'waiting_budget',
    'waiting_children', 'cancelling'
  ].includes(run.status));
  const running = Boolean(activeRun);
  const runActionAvailable = activeRun?.origin === 'projection';
  const inboxAvailable = runtime.status.capabilities.includes('agent.inbox');
  const queuedInputs = activeRun?.inbox.filter((input) => (
    input.state === 'queued' && input.source === undefined
  )) ?? [];
  const agentInputDeliveries = runtime.agentInputDeliveries.filter((receipt) => (
    receipt.sessionId === runtime.selectedSessionId
  ));
  const sending = runtime.messages.some((message) => message.deliveryState === 'pending');
  const imageAttachmentsAvailable = !running && canChat && effectiveVisionModel !== undefined;
  const hasDraftInput = draft.trim().length > 0 || draftImages.length > 0;

  useEffect(() => {
    if (
      editingInbox !== null
      && !queuedInputs.some((input) => (
        input.inputId === editingInbox.inputId
        && input.version === editingInbox.version
      ))
    ) setEditingInbox(null);
  }, [editingInbox, queuedInputs]);

  useEffect(() => {
    if (defaultsLoadedRef.current) return;
    defaultsLoadedRef.current = true;
    void services.agentSettings.load().then((settings) => {
      setRoutingStrategy(settings.routingStrategy);
      setPermissionMode(settings.permissionMode);
      setSettingsSnapshot(settings);
    }).catch(() => undefined);
  }, [services.agentSettings]);

  useEffect(() => {
    let active = true;
    const refreshWorkspaces = (): void => {
      void services.conversationNavigation.listSelectableWorkspaces().then((catalog) => {
        if (active) setWorkspaces(catalog);
      }).catch(() => undefined);
    };
    const applySelection = (workspaceId: string | null): void => {
      if (active) setDraftWorkspaceId(workspaceId);
    };
    const unsubscribeWorkspaces = services.conversationNavigation.onWorkspacesChanged(refreshWorkspaces);
    const unsubscribeSelection = services.conversationNavigation.onSelectedWorkspaceChanged(applySelection);
    refreshWorkspaces();
    return () => {
      active = false;
      unsubscribeWorkspaces();
      unsubscribeSelection();
    };
  }, [services.conversationNavigation]);

  useEffect(() => services.events.subscribe('chat:new-draft-requested', ({ workspaceId }) => {
    setDraftWorkspaceId(workspaceId);
    requestAnimationFrame(() => composerInputRef.current?.focus());
  }), [services.events]);

  useEffect(() => services.events.subscribe('speech:composer-transcript', ({ requestId, text, final }) => {
    setDraft((current) => {
      let base = speechDraftBasesRef.current.get(requestId);
      if (base === undefined) {
        base = current;
        speechDraftBasesRef.current.set(requestId, base);
      }
      const separator = base.trim().length > 0 && text.trim().length > 0 ? ' ' : '';
      return `${base}${separator}${text}`;
    });
    if (final) speechDraftBasesRef.current.delete(requestId);
    requestAnimationFrame(() => composerInputRef.current?.focus());
  }), [services.events]);

  useEffect(() => services.system.onApprovalNavigation(({ sessionId }) => {
    void services.sessions.select(sessionId).catch(() => undefined);
  }), [services.sessions, services.system]);

  const changePermissionMode = async (nextPermissionMode: AgentPermissionMode): Promise<void> => {
    if (savingPermissionMode || nextPermissionMode === permissionMode) return;
    const previous = permissionMode;
    setPermissionMode(nextPermissionMode);
    setSavingPermissionMode(true);
    try {
      const settings = settingsSnapshot ?? await services.agentSettings.load();
      const result = await services.agentSettings.apply({
        expectedRevision: settings.revision,
        operations: [{ kind: 'permissions.set', mode: nextPermissionMode }]
      });
      if (!result.ok) {
        setSettingsSnapshot(result.settings);
        setPermissionMode(result.settings.permissionMode);
        console.error(result.error.code, result.error.message);
        return;
      }
      const saved = result.settings;
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

  useLayoutEffect(() => {
    if (composerInputRef.current) syncComposerTextareaHeight(composerInputRef.current);
  }, [draft]);

  useEffect(() => {
    const input = composerInputRef.current;
    const composer = input?.closest<HTMLElement>('.composer');
    if (!input || !composer) return;
    let previousWidth = composer.getBoundingClientRect().width;
    let frame: number | null = null;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || Math.abs(entry.contentRect.width - previousWidth) < 0.5) return;
      previousWidth = entry.contentRect.width;
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
        syncComposerTextareaHeight(input);
      });
    });
    observer.observe(composer);
    return () => {
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, []);

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

  const addSelectedImages = async (files: FileList | null): Promise<void> => {
    if (files === null || files.length === 0) return;
    setDraftImageError(null);
    try {
      const next = await encodeDraftImages(files);
      if (draftImages.length + next.length > MAX_IMAGE_ATTACHMENTS_PER_MESSAGE_V3) {
        throw new Error(`每条消息最多添加 ${MAX_IMAGE_ATTACHMENTS_PER_MESSAGE_V3} 张图片。`);
      }
      const combined = [...draftImages, ...next];
      if (combined.reduce((sum, image) => sum + image.bytes, 0)
        > MAX_IMAGE_ATTACHMENT_MESSAGE_BYTES_V3) {
        throw new Error('图片合计不能超过 2 MB。');
      }
      setDraftImages(combined);
    } catch (error) {
      setDraftImageError(error instanceof Error ? error.message : '无法读取所选图片。');
    } finally {
      if (imageInputRef.current) imageInputRef.current.value = '';
    }
  };

  const send = async (delivery: 'next_turn' | 'next_step' = 'next_turn'): Promise<void> => {
    const message = draft;
    const images = draftImages;
    if (
      (message.trim().length === 0 && images.length === 0)
      || sending
      || !canChat
      || (planModeEnabled && !planModeAvailable)
    ) return;
    if (images.length > 0 && (activeRun || effectiveVisionModel === undefined)) {
      setDraftImageError(activeRun
        ? '运行中的补充输入暂不支持图片；请等待当前任务结束。'
        : '所选模型不支持图片理解。');
      return;
    }
    setDraft('');
    setDraftImages([]);
    setDraftImageError(null);
    setFollowingLatest(true);
    try {
      if (activeRun && inboxAvailable) {
        await services.runs.enqueueInput(activeRun, message, delivery);
      } else if (activeRun) {
        throw new Error('runtime_capability_missing:agent.inbox');
      } else {
        await services.messages.send(message, {
          ...(images.length > 0
            ? { modelId: effectiveVisionModel!.id }
            : selectedModelId !== AUTO_MODEL_ID
              ? { modelId: selectedModelId }
              : {}),
          ...(selectedInference ? { inference: selectedInference } : {}),
          ...(planModeEnabled ? {} : { routingStrategy }),
          workspaceId: composerWorkspaceId,
          ...(images.length === 0
            ? {}
            : {
                attachments: images.map(({ mediaType, data, name }) => ({
                  mediaType,
                  data,
                  ...(name === undefined ? {} : { name })
                }))
              })
        });
      }
    } catch {
      setDraft(message);
      setDraftImages(images);
    }
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send(event.metaKey || event.ctrlKey ? 'next_step' : 'next_turn');
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
            <h1 id={`${moduleId}-title`}>{selectedSession
              ? selectedSession.title
              : 'Ariadne 助手'}</h1>
            <span className="chat-subtitle" data-runtime-availability={runtime.status.availability}><span className="presence-dot" /> Runtime {formatRuntimeAvailability(runtime.status.availability)}</span>
          </div>
          <div className="chat-header-meta">
            <StatusPill tone={running
              ? 'running'
              : modelState.statusTone}>
              {activeRun?.userFacingLabel
                ?? modelState.statusLabel}
            </StatusPill>
          </div>
        </header>

        <div className="message-stage">
          <div className="message-viewport" ref={viewportRef} onScroll={handleViewportScroll}>
            <div className="message-list" ref={messageListRef}>
              {nodes.length === 0
                ? <EmptyConversation modelState={modelState} />
                : nodes.map((node) => (
                  <div id={`chat-node-${node.id}`} data-conversation-node key={node.id} className={`conversation-node conversation-node--${node.kind}`}>
                    <ConversationMessage
                      node={node}
                      run={runtime.runs.find((run) => run.runId === node.runId)}
                      activities={node.runId
                        ? runtime.activities.filter((activity) => activity.runId === node.runId)
                        : []}
                      onOpenActivity={node.runId
                        ? () => {
                            services.events.emitRetained('session-activity:select-run', {
                              runId: node.runId!
                            });
                            services.events.emit('module:open', SESSION_ACTIVITY_MODULE_ID);
                          }
                        : undefined}
                      onCopy={(text) => services.clipboard.writeText({ text })}
                      onFork={node.reference === undefined ? undefined : async () => {
                        setConversationActionError(null);
                        try {
                          await services.sessions.forkFromMessage(
                            node.reference!.sessionId,
                            node.reference!
                          );
                        } catch (error) {
                          setConversationActionError(error instanceof Error
                            ? error.message
                            : '无法从这条消息创建分支。');
                        }
                      }}
                    />
                  </div>
                ))}
              <ConversationApprovalCards
                services={services}
                sessionId={runtime.selectedSessionId}
              />
            </div>
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
            {agentInputDeliveries.length > 0 && (
              <div
                className="agent-input-deliveries"
                aria-label="Agent 输入投递状态"
                aria-live="polite"
              >
                {agentInputDeliveries.map((receipt) => (
                  <div
                    className="agent-input-delivery"
                    data-state={receipt.state}
                    data-command-id={receipt.commandId}
                    key={receipt.commandId}
                  >
                    <span className="agent-input-delivery-state">
                      {agentInputDeliveryLabel(receipt.state)}
                    </span>
                    <code title={receipt.commandId}>#{receipt.commandId.slice(0, 8)}</code>
                    <span className="agent-input-delivery-content">{receipt.content}</span>
                    {receipt.error && (
                      <span className="agent-input-delivery-error" title={receipt.error}>
                        {receipt.error}
                      </span>
                    )}
                    {receipt.state === 'reconcile' && (
                      <button
                        type="button"
                        disabled={runtime.status.availability !== 'ready'}
                        onClick={() => void services.runs.reconcileInputDelivery(
                          receipt.commandId
                        )}
                      >重新确认</button>
                    )}
                    {receipt.state === 'failed' && (
                      <button
                        type="button"
                        onClick={() => {
                          setDraft((current) => current.trim().length === 0
                            ? receipt.content
                            : `${current}\n${receipt.content}`);
                          services.runs.dismissInputDelivery(receipt.commandId);
                          requestAnimationFrame(() => composerInputRef.current?.focus());
                        }}
                      >恢复输入</button>
                    )}
                    {receipt.state === 'accepted' && (
                      <button
                        type="button"
                        onClick={() => services.runs.dismissInputDelivery(
                          receipt.commandId
                        )}
                      >关闭</button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {queuedInputs.length > 0 && activeRun && (
              <div className="agent-inbox" aria-label="Agent 输入队列">
                {queuedInputs.map((input) => (
                  <div className="agent-inbox-row" key={input.inputId}>
                    <span className="agent-inbox-mode">
                      {input.delivery === 'next_step' ? '下一步' : '下一轮'}
                    </span>
                    {editingInbox?.inputId === input.inputId
                      ? <input
                          className="agent-inbox-edit"
                          aria-label="编辑排队消息"
                          autoFocus
                          value={editingInbox.content}
                          onChange={(event) => setEditingInbox({
                            ...editingInbox,
                            content: event.target.value
                          })}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') setEditingInbox(null);
                            if (event.key === 'Enter' && editingInbox.content.trim()) {
                              event.preventDefault();
                              const replacement = editingInbox;
                              setEditingInbox(null);
                              void services.runs.replaceInput(
                                activeRun,
                                replacement.inputId,
                                replacement.version,
                                replacement.content
                              );
                            }
                          }}
                        />
                      : <span className="agent-inbox-content">{input.content}</span>}
                    <button type="button" onClick={() => setEditingInbox({
                      inputId: input.inputId,
                      version: input.version,
                      content: input.content
                    })}>编辑</button>
                    <button type="button" onClick={() => void services.runs.removeInput(
                      activeRun,
                      input.inputId,
                      input.version
                    )}>移除</button>
                  </div>
                ))}
              </div>
            )}
            <div className="composer-context-bar">
              <SelectMenu<string>
                    className="composer-workspace-menu"
                    ariaLabel="选择助手或 Agent 工作区"
                    placement="top"
                    leadingIcon={assistantMode ? <Sparkles size={13} /> : <Folder size={13} />}
                    value={composerWorkspaceId}
                    options={workspaceOptions}
                    disabled={selectedSession !== undefined}
                    onChange={(workspaceId) => {
                      if (workspaceId === PERSONAL_ASSISTANT_WORKSPACE_ID) {
                        setDraftWorkspaceId(null);
                        services.conversationNavigation.selectAssistant();
                      } else {
                        setDraftWorkspaceId(workspaceId);
                        void services.conversationNavigation.selectWorkspace(workspaceId);
                      }
                    }}
                  />
            </div>
            <input
              ref={imageInputRef}
              className="composer-image-file-input"
              type="file"
              accept={IMAGE_ATTACHMENT_MEDIA_TYPES_V3.join(',')}
              multiple
              aria-label="选择图片附件"
              tabIndex={-1}
              onChange={(event) => void addSelectedImages(event.target.files)}
            />
            {draftImages.length > 0 && (
              <div className="composer-image-drafts" aria-label="待发送图片">
                {draftImages.map((image) => (
                  <figure className="composer-image-draft" key={image.clientId}>
                    <img
                      src={`data:${image.mediaType};base64,${image.data}`}
                      alt={image.name ?? '待发送图片'}
                    />
                    <figcaption>{image.name ?? '图片'}</figcaption>
                    <button
                      type="button"
                      aria-label={`移除 ${image.name ?? '图片'}`}
                      onClick={() => setDraftImages((current) => current.filter(
                        (candidate) => candidate.clientId !== image.clientId
                      ))}
                    ><X size={13} /></button>
                  </figure>
                ))}
              </div>
            )}
            {(draftImageError || conversationActionError) && <p className="composer-image-error" role="alert">{draftImageError ?? conversationActionError}</p>}
            <textarea
              ref={composerInputRef}
              value={draft}
              rows={1}
              placeholder={running ? '继续输入：Enter 排到下一轮，Ctrl/⌘+Enter 在下一步介入' : modelState.composerPlaceholder}
              aria-label="消息输入框"
              disabled={!canChat}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onComposerKeyDown}
            />
            <div className="composer-toolbar">
              <div className="composer-model-controls">
                <ComposerAddMenu
                  planModeAvailable={planModeAvailable}
                  planModeEnabled={planModeEnabled}
                  imageAttachmentsAvailable={imageAttachmentsAvailable}
                  {...(imageAttachmentsAvailable
                    ? {}
                    : {
                        imageAttachmentsDisabledReason: running
                          ? '运行中的补充输入暂不支持图片'
                          : '当前没有可用的视觉模型'
                      })}
                  {...(assistantMode
                    ? { planModeDisabledReason: '选择一个工作区后才能使用计划模式' }
                    : {})}
                  onPlanModeChange={(enabled) => services.sessions.setPlanModeEnabled(
                    enabled,
                    runtime.selectedSessionId
                  )}
                  onAddImages={() => imageInputRef.current?.click()}
                />
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
                {!assistantMode && (
                  <SelectMenu<AgentPermissionMode>
                    className="composer-permission-mode-menu"
                    ariaLabel="选择 Agent 权限模式"
                    placement="top"
                    value={permissionMode}
                    options={permissionModeOptions}
                    disabled={savingPermissionMode}
                    onChange={(nextPermissionMode) => void changePermissionMode(nextPermissionMode)}
                  />
                )}
                <button
                  type="button"
                  className={`composer-mic-button${speech.foregroundRequestId ? ' is-active' : ''}`}
                  aria-label={speech.foregroundRequestId ? '停止语音输入' : '开始语音输入'}
                  title={speech.status.availability === 'disabled'
                    ? '请先在设置中启用语音模块'
                    : speech.status.detail}
                  disabled={!speech.status.capabilities.includes('stt')}
                  onClick={() => void services.speech.toggleForegroundRecognition().catch((error) => {
                    console.error('Unable to toggle speech recognition.', error);
                  })}
                >{speech.foregroundRequestId ? <MicOff size={15} /> : <Mic size={15} />}</button>
                <button
                  type="button"
                  className={`send-button${running && !hasDraftInput ? ' send-button--stop' : ''}`}
                  disabled={sending || (running && !hasDraftInput
                    ? !runActionAvailable
                    : !hasDraftInput || !canChat)}
                  onClick={() => running && activeRun && !hasDraftInput
                    ? void services.runs.requestCancellation(activeRun)
                    : void send('next_turn')}
                  aria-label={running && !hasDraftInput ? '取消 Agent 任务' : running ? '排到下一轮' : '发送消息'}
                >
                  {running && !hasDraftInput ? <span className="send-stop-glyph" aria-hidden="true" /> : <Send size={16} />}
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

function syncComposerTextareaHeight(input: HTMLTextAreaElement): void {
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

function EmptyConversation({ modelState }: { modelState: ChatModelState }): React.JSX.Element {
  return <div className="empty-conversation"><span><Sparkles size={21} /></span><h2>{modelState.emptyTitle}</h2><p>{modelState.emptyDescription}</p></div>;
}

function agentInputDeliveryLabel(
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

function toConversationNode(message: RuntimeMessage): ConversationNode {
  const content = message.content;
  const summary = content
    || message.reasoning?.content
    || (message.status === 'streaming' ? '正在处理…' : '');
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
    summary: summary.slice(0, 160),
    content,
    ...(message.attachments === undefined
      ? {}
      : { attachments: message.attachments.map((attachment) => ({ ...attachment })) }),
    status: message.status,
    ...(message.runId ? { runId: message.runId } : {}),
    ...(message.reference ? { reference: { ...message.reference } } : {}),
    ...(message.processingDurationMs !== undefined
      ? { processingDurationMs: message.processingDurationMs }
      : {}),
    ...(message.reasoning ? { reasoning: message.reasoning } : {}),
    ...(message.deliveryState ? { deliveryState: message.deliveryState } : {}),
    ...(message.error ? { error: message.error } : {})
  };
}

function ConversationMessage({
  node,
  run,
  activities,
  onOpenActivity,
  onCopy,
  onFork
}: {
  node: ConversationNode;
  run?: RuntimeRun | undefined;
  activities: import('@ariadne/protocol/public').RunActivity[];
  onOpenActivity?: (() => void) | undefined;
  onCopy(text: string): Promise<void>;
  onFork?: (() => Promise<void>) | undefined;
}): React.JSX.Element {
  const text = node.content ?? node.summary;
  const isUser = node.kind === 'user';
  const formalAnswerVisible = shouldShowFormalAnswer(node, run);
  const visibleText = formalAnswerVisible ? text : '';
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

async function encodeDraftImages(files: FileList): Promise<readonly DraftImageAttachment[]> {
  const selected = Array.from(files);
  if (selected.length > MAX_IMAGE_ATTACHMENTS_PER_MESSAGE_V3) {
    throw new Error(`每条消息最多添加 ${MAX_IMAGE_ATTACHMENTS_PER_MESSAGE_V3} 张图片。`);
  }
  return Promise.all(selected.map(async (file) => {
    if (!IMAGE_ATTACHMENT_MEDIA_TYPES_V3.includes(
      file.type as (typeof IMAGE_ATTACHMENT_MEDIA_TYPES_V3)[number]
    )) {
      throw new Error(`不支持 ${file.name || '所选文件'} 的图片格式。`);
    }
    if (file.size < 1 || file.size > MAX_IMAGE_ATTACHMENT_SOURCE_BYTES_V3) {
      throw new Error(`${file.name || '图片'} 必须小于 2 MB。`);
    }
    const mediaType = file.type as EncodedImageAttachmentV3['mediaType'];
    const data = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
    const normalizedName = file.name.trim().slice(0, 256);
    return {
      clientId: crypto.randomUUID(),
      mediaType,
      data,
      bytes: file.size,
      ...(normalizedName.length === 0 ? {} : { name: normalizedName })
    };
  }));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function formatBytes(bytes: number): string {
  return bytes < 1_024
    ? `${bytes} B`
    : `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
}
