import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent
} from 'react';
import {
  ArrowDown,
  Folder,
  Mic,
  MicOff,
  PanelLeftClose,
  PanelLeftOpen,
  Send,
  Sparkles,
  X
} from 'lucide-react';
import type { ChatRoutingStrategy, ModelInferenceOptions } from '@ariadne/protocol/public';
import {
  IMAGE_ATTACHMENT_MEDIA_TYPES_V3,
  MAX_IMAGE_ATTACHMENTS_PER_MESSAGE_V3,
  MAX_IMAGE_ATTACHMENT_MESSAGE_BYTES_V3,
  PERSONAL_ASSISTANT_WORKSPACE_ID
} from '@ariadne/protocol/public';
import type { AgentPermissionMode, AgentSettingsView } from '@shared/contract';
import { useFeatureSnapshot } from '@renderer/core/runtime/features/feature-snapshot-store';
import { formatRuntimeAvailability } from '@renderer/core/runtime/runtime-labels';
import { type FeaturePanelProps } from '@renderer/core/modules/module-contract';
import { SelectMenu, type SelectMenuOption } from '@renderer/shared/ui/SelectMenu';
import { StatusPill } from '@renderer/shared/ui/StatusPill';
import { getCenteredScrollDelta, isScrollNearBottom } from '@shared/scroll-geometry';
import { ConversationOverviewRuler } from './ConversationOverviewRuler';
import { ConversationSidebar } from './ConversationSidebar';
import { ConversationApprovalCards } from '@renderer/app/ApprovalCenter';
import { ComposerAddMenu } from './ComposerAddMenu';
import { deriveChatModelState } from './chat-model-state';
import type { ConversationWorkspace } from '@renderer/core/conversations/conversation-navigation-service';
import { useConversationPresentationRevision } from '@renderer/core/conversations/use-conversation-presentation';
import { useSpeechSnapshot } from '@renderer/core/speech/speech-coordinator';
import { applicationProfileComponents } from '@shared/application-profile';
import './ImageAttachments.css';
import './AgentInputDelivery.css';
import { type DraftImageAttachment, encodeDraftImages } from './ChatImageAttachments';
import {
  AUTO_MODEL_ID,
  defaultInference,
  inferenceSupported,
  modelCapabilityLabel,
  parseRoutingSelectionValue,
  permissionModeOptions,
  reasoningEffortLabel,
  reasoningModeLabel,
  routingOptions
} from './ChatComposerPolicy';
import {
  EmptyConversation,
  agentInputDeliveryLabel,
  routingSelectionValue,
  syncComposerTextareaHeight
} from './ChatPresentation';
import { toConversationNode } from './ChatMessageProjection';
import { ConversationMessageRow, EMPTY_RUN_ACTIVITIES } from './ConversationMessageRow';



export function ChatPanel({ moduleId, services }: FeaturePanelProps): React.JSX.Element {
  const diagnostics = useFeatureSnapshot(services.diagnostics.view);
  const messages = useFeatureSnapshot(services.messages.view);
  const models = useFeatureSnapshot(services.models.view);
  const runs = useFeatureSnapshot(services.runs.view);
  const sessions = useFeatureSnapshot(services.sessions.view);
  const runtime = { ...diagnostics, ...messages, ...models, ...runs, ...sessions };
  const speech = useSpeechSnapshot(services.speech);
  const speechComponents = applicationProfileComponents(services.applicationProfile, 'speech');
  const speechInputInstalled = speechComponents.includes('speech.stt');
  useConversationPresentationRevision(services.conversationNavigation);
  const [draft, setDraft] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(true);
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
  const executionMode = assistantMode ? 'chat' : planModeEnabled ? 'plan' : 'agent';
  const modelState = useMemo(() => deriveChatModelState({
    runtimeAvailability: runtime.status.availability,
    planModeAvailable,
    planModeEnabled,
    executionMode,
    routingStrategy,
    models: runtime.models
  }), [
    runtime.status.availability,
    planModeAvailable,
    planModeEnabled,
    executionMode,
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
      description: executionMode === 'chat' ? '按路由策略选择' : `按${executionMode === 'plan' ? '计划' : ' Agent'}能力选择`,
      ...(executionMode !== 'chat'
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
      description: `${model.location === 'local' ? '本地模型' : '远程模型'} · ${modelCapabilityLabel(model)}`
    }))
  ], [eligibleModels, executionMode]);
  const modelSelectionValue = selectedModelId === AUTO_MODEL_ID
    ? executionMode !== 'chat'
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
  const runsById = useMemo(() => new Map(runtime.runs.map(run => [run.runId, run])), [runtime.runs]);
  const activitiesByRun = useMemo(() => {
    const groups = new Map<string, Array<(typeof runtime.activities)[number]>>();
    for (const activity of runtime.activities) {
      const group = groups.get(activity.runId) ?? [];
      group.push(activity);
      groups.set(activity.runId, group);
    }
    return groups;
  }, [runtime.activities]);
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
    <section className={`chat-panel${sidebarOpen ? '' : ' chat-panel--sidebar-hidden'}`} aria-labelledby={`${moduleId}-title`}>
      <div className="chat-sidebar-slot" id={`${moduleId}-sidebar`} hidden={!sidebarOpen}>
        <ConversationSidebar services={services} />
      </div>
      <div className={`chat-conversation${nodes.length === 0 ? ' chat-conversation--empty' : ''}`}>
        <header className="chat-header">
          <div className="chat-heading">
            <button type="button" className="bare-icon-button" aria-label={sidebarOpen ? '收起会话列表' : '展开会话列表'} aria-expanded={sidebarOpen} aria-controls={`${moduleId}-sidebar`} onClick={() => setSidebarOpen((open) => !open)}>
              {sidebarOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
            </button>
            <div>
            <h1 id={`${moduleId}-title`}>{selectedSession
              ? selectedSession.title
              : 'Ariadne 助手'}</h1>
            <span className="chat-subtitle" data-runtime-availability={runtime.status.availability}><span className="presence-dot" /> Runtime {formatRuntimeAvailability(runtime.status.availability)}</span>
            </div>
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
                : nodes.map(node => <ConversationMessageRow key={node.id} node={node}
                    run={node.runId ? runsById.get(node.runId) : undefined}
                    activities={(node.runId ? activitiesByRun.get(node.runId) : undefined) ?? EMPTY_RUN_ACTIVITIES}
                    workspaceId={selectedSession?.workspaceId}
                    services={services} onError={setConversationActionError} />)}
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
                {speechInputInstalled && <button
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
                >{speech.foregroundRequestId ? <MicOff size={15} /> : <Mic size={15} />}</button>}
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
