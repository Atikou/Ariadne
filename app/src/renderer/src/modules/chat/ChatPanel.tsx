import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
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
import type { ModelInferenceOptions } from '@ariadne/protocol/public';
import {
  IMAGE_ATTACHMENT_MEDIA_TYPES,
  PERSONAL_ASSISTANT_WORKSPACE_ID
} from '@ariadne/protocol/public';
import { messageMetadataOf } from '@ariadne/protocol/public';
import type { AgentPermissionMode, AgentSettingsView } from '@shared/contract';
import { useFeatureSnapshot } from '@renderer/core/runtime/features/feature-snapshot-store';
import { formatRuntimeAvailability } from '@renderer/core/runtime/runtime-labels';
import { type FeaturePanelProps } from '@renderer/core/modules/module-contract';
import { SelectMenu, type SelectMenuOption } from '@renderer/shared/ui/SelectMenu';
import { StatusPill } from '@renderer/shared/ui/StatusPill';
import { getCenteredScrollDelta, isScrollNearBottom } from '@shared/scroll-geometry';
import { ConversationOverviewRuler } from './ConversationOverviewRuler';
import { ConversationSidebar } from './ConversationSidebar';
import { AgentInboxPanel } from './AgentInboxPanel';
import { ConversationApprovalCards } from '@renderer/app/ApprovalCenter';
import { ComposerAddMenu } from './ComposerAddMenu';
import { deriveChatModelState } from './chat-model-state';
import type { ConversationWorkspace } from '@renderer/core/conversations/conversation-navigation-service';
import { useConversationPresentationRevision } from '@renderer/core/conversations/use-conversation-presentation';
import { useSpeechSnapshot } from '@renderer/core/speech/speech-coordinator';
import { applicationProfileComponents } from '@shared/application-profile';
import './ImageAttachments.css';
import './AgentInputDelivery.css';
import { encodeDraftImages } from './ChatImageAttachments';
import { chatDraftOwnerKey } from '@shared/chat-drafts';
import { useChatDraftImages } from '@renderer/core/conversations/use-chat-draft-images';
import { composerKeyAction } from './ChatComposerKeyboard';
import {
  defaultInference,
  inferenceSupported,
  modelCapabilityLabel,
  permissionModeOptions,
  reasoningEffortLabel,
  reasoningModeLabel
} from './ChatComposerPolicy';
import {
  EmptyConversation,
  agentInputDeliveryLabel,
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
  const draftSnapshot = useSyncExternalStore(services.drafts.subscribe, services.drafts.getSnapshot);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [draftImageError, setDraftImageError] = useState<string | null>(null);
  const [conversationActionError, setConversationActionError] = useState<string | null>(null);
  const [notificationTarget, setNotificationTarget] = useState<{ sessionId: string; decisionId: string } | null>(null);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [localFallbackModelId, setLocalFallbackModelId] = useState('');
  const [savingModelSelection, setSavingModelSelection] = useState(false);
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode>('request');
  const [settingsSnapshot, setSettingsSnapshot] = useState<AgentSettingsView | null>(null);
  const [workspaces, setWorkspaces] = useState<readonly ConversationWorkspace[]>([]);
  const [draftWorkspaceId, setDraftWorkspaceId] = useState<string | null>(null);
  const [savingPermissionMode, setSavingPermissionMode] = useState(false);
  const [inferenceByModel, setInferenceByModel] = useState<Record<string, ModelInferenceOptions>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isAtLatest, setIsAtLatest] = useState(true);
  const viewportRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const followLatestRef = useRef(true);
  const defaultsLoadedRef = useRef(false);
  const speechDraftBasesRef = useRef(new Map<string, { owner: ReturnType<typeof services.drafts.ownerFor>; generation: string; text: string; revision: number }>());
  const selectedSession = runtime.sessions.find((session) => session.sessionId === runtime.selectedSessionId);
  const composerWorkspaceId = selectedSession?.workspaceId
    ?? draftWorkspaceId
    ?? PERSONAL_ASSISTANT_WORKSPACE_ID;
  const draftOwner = services.drafts.ownerFor(composerWorkspaceId, runtime.selectedSessionId);
  const draftOwnerKey = chatDraftOwnerKey(draftOwner);
  const composerOwnerRef = useRef(draftOwner);
  composerOwnerRef.current = draftOwner;
  const currentDraft = draftSnapshot.drafts.find(row => chatDraftOwnerKey(row.owner) === draftOwnerKey) ?? services.drafts.draft(draftOwner);
  const draft = currentDraft.editing.text;
  const imageBodies = useChatDraftImages(services.drafts, draftOwner, currentDraft.editing.attachments);
  const draftImages = currentDraft.editing.attachments.map(reference => ({ ...reference, clientId: reference.attachmentId,
    data: imageBodies.bodies.get(reference.attachmentId)?.data ?? '' }));
  const draftBlocked = !draftSnapshot.ready || Boolean(draftSnapshot.error) || currentDraft.submissions.some(row => row.status !== 'recoverable');
  useEffect(() => { services.drafts.select(draftOwner); services.messages.selectDraftOwner(draftOwner.target.kind === 'new' ? draftOwnerKey : null);
    setDraftImageError(null); setConversationActionError(null); }, [services.drafts, services.messages, draftOwnerKey]);
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
    selectedModelId,
    localFallbackModelId,
    modelsReadReady: runtime.modelsReadReady,
    models: runtime.models
  }), [
    runtime.status.availability,
    planModeAvailable,
    planModeEnabled,
    executionMode,
    selectedModelId,
    localFallbackModelId,
    runtime.modelsReadReady,
    runtime.models
  ]);
  const availableModels = modelState.readyModels;
  const eligibleModels = modelState.eligibleModels;
  const selectedModel = runtime.models.find((model) => model.id === selectedModelId);
  const effectiveVisionModel = selectedModel?.supportsVision ? selectedModel : undefined;
  const selectedInference = selectedModel
    ? inferenceByModel[selectedModel.id] ?? defaultInference(selectedModel)
    : undefined;
  const reasoning = selectedModel?.inference?.reasoning;
  const canChat = modelState.canChat && !savingModelSelection;
  const modelOptions = useMemo<readonly SelectMenuOption<string>[]>(() => (
    (['local', 'remote'] as const).map(location => ({
      value: `__${location}__`,
      label: location === 'local' ? '本地模型' : '远程 API',
      children: runtime.models.filter(model => model.location === location && model.enabled !== false).map(model => ({
        value: model.id, label: model.label,
        description: `${modelCapabilityLabel(model)}${model.availability === 'ready' ? '' : ' · 暂不可用'}`
      }))
    })).filter(group => group.children.length > 0)
  ), [runtime.models]);
  const fallbackOptions = useMemo<readonly SelectMenuOption<string>[]>(() => [
    { value: '', label: '不使用本地备用', description: '远程 API 不可用时停止' },
    ...eligibleModels.filter(model => model.location === 'local').map(model => ({
      value: model.id, label: model.label, description: '远程 API 不可用时使用此模型'
    }))
  ], [eligibleModels]);
  const saveModelSelection = async (modelId: string, fallbackId: string): Promise<void> => {
    if (savingModelSelection) return;
    setSavingModelSelection(true);
    setConversationActionError(null);
    try {
      const current = await services.agentSettings.load();
      const result = await services.agentSettings.apply({ expectedRevision: current.revision,
        operations: [{ kind: 'modelSelection.set', selection: { modelId, localFallbackModelId: fallbackId } }] });
      if (!result.ok) throw new Error(result.error.message);
      setSettingsSnapshot(result.settings);
      setSelectedModelId(modelId);
      setLocalFallbackModelId(fallbackId);
    } catch (error) {
      setConversationActionError(error instanceof Error ? error.message : '保存模型选择失败');
    } finally { setSavingModelSelection(false); }
  };
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
  const agentInputDeliveries = runtime.agentInputDeliveries.filter((receipt) => (
    receipt.sessionId === runtime.selectedSessionId
  ));
  const sending = runtime.messages.some((message) => message.deliveryState === 'pending');
  const imageAttachmentsAvailable = !running && canChat && effectiveVisionModel !== undefined;
  const hasDraftInput = draft.trim().length > 0 || draftImages.length > 0;


  useEffect(() => {
    if (defaultsLoadedRef.current) return;
    defaultsLoadedRef.current = true;
    void services.agentSettings.load().then((settings) => {
      setSelectedModelId(settings.modelSelection.modelId);
      setLocalFallbackModelId(settings.modelSelection.localFallbackModelId);
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
    services.drafts.newDraft(workspaceId ?? PERSONAL_ASSISTANT_WORKSPACE_ID);
    setDraftWorkspaceId(workspaceId);
    requestAnimationFrame(() => composerInputRef.current?.focus());
  }), [services.events, services.drafts]);

  useEffect(() => services.events.subscribe('speech:composer-transcript', ({ requestId, text, final }) => {
    const base = speechDraftBasesRef.current.get(requestId);
    if (!base) return;
    const current = services.drafts.draft(base.owner).editing;
    if (current.generation === base.generation && current.revision === base.revision) {
      const separator = base.text.trim() && text.trim() ? ' ' : '';
      services.drafts.edit(base.owner, `${base.text}${separator}${text}`);
      base.revision = services.drafts.draft(base.owner).editing.revision;
    }
    if (final) speechDraftBasesRef.current.delete(requestId);
  }), [services.events, services.drafts]);

  useEffect(() => services.events.subscribe('speech:composer-started', ({ requestId }) => {
    const owner = composerOwnerRef.current, editing = services.drafts.draft(owner).editing;
    speechDraftBasesRef.current.clear();
    speechDraftBasesRef.current.set(requestId, { owner, generation: editing.generation, text: editing.text, revision: editing.revision });
  }), [services.events, services.drafts]);

  useEffect(() => services.system.onApprovalNavigation(({ sessionId, decisionId, taskNavigation }) => {
    if (taskNavigation) {
      return;
    }
    setNotificationTarget(decisionId ? { sessionId, decisionId } : null);
    void services.sessions.select(sessionId).then(() => decisionId ? services.decisions.openDetail(decisionId) : undefined)
      .catch(error => setConversationActionError(error instanceof Error ? error.message : '读取待确认操作失败。'));
  }), [services]);

  useEffect(() => {
    if (!notificationTarget || runtime.selectedSessionId !== notificationTarget.sessionId) return;
    const target = [...(messageListRef.current?.querySelectorAll<HTMLElement>('[data-decision-id]') ?? [])]
      .find(element => element.dataset.decisionId === notificationTarget.decisionId);
    if (target) {
      const viewport = viewportRef.current;
      if (viewport) {
        const viewportBounds = viewport.getBoundingClientRect();
        const targetBounds = target.getBoundingClientRect();
        viewport.scrollTo({ top: viewport.scrollTop + getCenteredScrollDelta(
          viewportBounds.top, viewportBounds.height, targetBounds.top, targetBounds.height
        ) });
      }
      target.focus({ preventScroll: true }); setNotificationTarget(null);
    }
  }, [notificationTarget, runtime]);

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
  }, [draft, currentDraft.editorId]);

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
  }, [currentDraft.editorId]);

  useLayoutEffect(() => { composingRef.current = false; }, [currentDraft.editorId]);

  const historyAnchor = messages.messageWindow?.window.kind === 'around'
    ? messages.messageWindow.window.anchorMessageId : null;
  useLayoutEffect(() => {
    if (historyAnchor === null) return;
    const viewport = viewportRef.current, target = document.getElementById(`chat-node-${historyAnchor}`);
    if (!viewport || !target || !viewport.contains(target)) return;
    setFollowingLatest(false); setSelectedId(historyAnchor); setActiveId(historyAnchor);
    const bounds = viewport.getBoundingClientRect(), targetBounds = target.getBoundingClientRect();
    viewport.scrollTop += getCenteredScrollDelta(bounds.top, viewport.clientHeight, targetBounds.top, targetBounds.height);
  }, [historyAnchor, runtime.selectedSessionId, setFollowingLatest]);

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
    const read = services.drafts.captureImageRead(draftOwner);
    try {
      const next = await encodeDraftImages(files);
      services.drafts.appendImages(read, next);
    } catch (error) {
      if (services.drafts.isSelected(read.owner)) setDraftImageError(error instanceof Error && error.name !== 'ZodError'
        ? error.message : '无法添加图片；每条消息最多 4 张、合计 2 MB。');
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
      || draftBlocked
      || !canChat
      || (planModeEnabled && !planModeAvailable)
    ) return;
    if (images.length > 0 && (activeRun || effectiveVisionModel === undefined)) {
      setDraftImageError(activeRun
        ? '运行中的补充输入暂不支持图片；请等待当前任务结束。'
        : '所选模型不支持图片理解。');
      return;
    }
    setDraftImageError(null);
    setConversationActionError(null);
    setFollowingLatest(true);
    try {
      if (activeRun && !inboxAvailable) {
        throw new Error('runtime_capability_missing:agent.inbox');
      }
      await services.draftDelivery.send(draftOwner, {
          modelId: selectedModelId,
          localFallbackModelId: selectedModel?.location === 'remote' ? localFallbackModelId || null : null,
          ...(selectedInference ? { inference: selectedInference } : {}),
        }, activeRun, delivery);
    } catch (error) {
      if (services.drafts.isSelected(draftOwner)) setConversationActionError(error instanceof Error ? error.message : '发送未完成，请核对草稿。');
    }
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const action = composerKeyAction(event.nativeEvent, composingRef.current,
      canChat && !sending && !draftBlocked && hasDraftInput && (!planModeEnabled || planModeAvailable));
    if (action === 'native') return;
    event.preventDefault();
    if (action !== 'blocked') void send(action);
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
    <section className={`chat-panel${sidebarOpen ? '' : ' chat-panel--sidebar-hidden'}`} aria-labelledby={`${moduleId}-title`} aria-busy={!runtime.modelsReadReady}>
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
              {messages.messageWindow?.hasEarlier && <button type="button" className="secondary-button"
                onClick={() => {
                  const row = messages.messageWindow?.rows[0];
                  const anchor = row === undefined ? undefined : messageMetadataOf(row).messageId;
                  if (anchor) void services.messages.showWindow({ kind: 'before', anchorMessageId: anchor, limit: 64 })
                    .catch(error => setConversationActionError(error instanceof Error ? error.message : '读取历史消息失败。'));
                }}>查看更早的消息</button>}
              {messages.messageWindow?.hasLater && <button type="button" className="secondary-button"
                onClick={() => void services.messages.showWindow({ kind: 'latest', limit: 64 })
                  .catch(error => setConversationActionError(error instanceof Error ? error.message : '读取最新消息失败。'))}>返回最新消息</button>}
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
                        onClick={() => void (receipt.draftSubmissionId
                          ? services.draftDelivery.reconcile(draftOwner, receipt.draftSubmissionId)
                          : services.runs.reconcileInputDelivery(receipt.commandId)).catch(() => setConversationActionError('原发送尚未确认，内容仍已保留。'))}
                      >重新确认</button>
                    )}
                    {receipt.state === 'failed' && !receipt.draftSubmissionId && (
                      <button
                        type="button"
                        onClick={() => {
                          const current = services.drafts.draft(draftOwner).editing.text;
                          services.drafts.edit(draftOwner, current.trim().length === 0 ? receipt.content : `${current}\n${receipt.content}`);
                          services.runs.dismissInputDelivery(receipt.commandId);
                          requestAnimationFrame(() => composerInputRef.current?.focus());
                        }}
                      >恢复输入</button>
                    )}
                    {receipt.state === 'accepted' && (
                      <button
                        type="button"
                        onClick={() => {
                          if (receipt.draftSubmissionId) void services.draftDelivery.dismissInputReceipt(receipt.commandId, receipt.draftSubmissionId)
                            .catch(() => setConversationActionError('发送已接受，但安全保存或结算未完成；回执仍已保留。'));
                          else services.runs.dismissInputDelivery(receipt.commandId);
                        }}
                      >关闭</button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {activeRun && activeRun.collections.inbox.total > 0 && <AgentInboxPanel key={`${activeRun.sessionId}:${activeRun.runId}`} run={activeRun} reads={services.runs} />}
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
              accept={IMAGE_ATTACHMENT_MEDIA_TYPES.join(',')}
              multiple
              aria-label="选择图片附件"
              tabIndex={-1}
              onChange={(event) => void addSelectedImages(event.target.files)}
            />
            {draftImages.length > 0 && (
              <div className="composer-image-drafts" aria-label="待发送图片">
                {draftImages.map((image) => (
                  <figure className="composer-image-draft" key={image.clientId}>
                    {image.data ? <img
                      src={`data:${image.mediaType};base64,${image.data}`}
                      alt={image.name ?? '待发送图片'}
                    /> : imageBodies.failed.has(image.clientId)
                      ? <span role="alert">图片读取失败 <button type="button" onClick={imageBodies.retry}>重试读取</button></span>
                      : <span role="status">正在读取图片</span>}
                    <figcaption>{image.name ?? '图片'}</figcaption>
                    <button
                      type="button"
                      aria-label={`移除 ${image.name ?? '图片'}`}
                      onClick={() => services.drafts.removeImage(draftOwner, image.clientId)}
                    ><X size={13} /></button>
                  </figure>
                ))}
              </div>
            )}
            {(draftSnapshot.error || draftImageError || conversationActionError) && <p className="composer-image-error" role="alert">{draftSnapshot.error ?? draftImageError ?? conversationActionError}</p>}
            {currentDraft.submissions.map(row => <div className="composer-draft-recovery" key={row.submissionId} role="status">
              <span>{row.status === 'recoverable' ? '未发送内容已保留' : '这次发送尚待确认'}：{row.text.slice(0, 80) || `${row.attachments.length} 张图片`}</span>
              <button type="button" onClick={() => {
                setConversationActionError(null);
                if (row.status === 'recoverable') {
                  try { services.drafts.restore(draftOwner, row.submissionId); } catch { setConversationActionError('请先处理当前输入，再恢复保留内容。'); }
                } else void services.draftDelivery.reconcile(draftOwner, row.submissionId).catch(error =>
                  setConversationActionError(error instanceof Error ? error.message : '原发送核对失败，内容仍已保留。'));
              }}>{row.status === 'recoverable' ? '恢复到输入框' : '核对原发送'}</button>
            </div>)}
            <textarea
              key={currentDraft.editorId}
              ref={composerInputRef}
              value={draft}
              rows={1}
              placeholder={running ? '继续输入：Enter 排到下一轮，Ctrl/⌘+Enter 在下一步介入' : modelState.composerPlaceholder}
              aria-label="消息输入框"
              onChange={(event) => { try { services.drafts.edit(draftOwner, event.target.value); } catch { setConversationActionError('输入未更新，请检查草稿存储或缩短内容。'); } }}
              onKeyDown={onComposerKeyDown}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={() => { composingRef.current = false; }}
              onBlur={() => { composingRef.current = false; }}
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
                  value={selectedModelId}
                  triggerLabel={selectedModel?.label ?? '请选择模型'}
                  disabled={savingModelSelection}
                  options={modelOptions}
                  onChange={(modelId) => { void saveModelSelection(modelId, localFallbackModelId); }}
                />
                {selectedModel?.location === 'remote' && (
                  <SelectMenu<string>
                    className="composer-fallback-menu" ariaLabel="远程不可用时" placement="top"
                    value={localFallbackModelId} options={fallbackOptions} disabled={savingModelSelection}
                    triggerLabel={localFallbackModelId ? `备用：${runtime.models.find(model => model.id === localFallbackModelId)?.label ?? '模型不可用'}` : '远程失败：停止'}
                    onChange={(modelId) => { void saveModelSelection(selectedModelId, modelId); }}
                  />
                )}
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
                    : !hasDraftInput || !canChat || draftBlocked)}
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
