import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent } from 'react';
import { AlertTriangle, ArchiveRestore, BellRing, CheckCircle2, ChevronRight, Database, FolderArchive, KeyRound, Laptop, MessageCircle, Mic, Moon, PackageOpen, Plus, RotateCcw, Save, Sun, X } from 'lucide-react';
import type {
  AgentAcpSubagentProviderSettingsView,
  AgentProviderId,
  AgentProviderSettingsPatch,
  AgentProviderSettingsView,
  AgentSettingsEffect,
  AgentSettingsOperation,
  AgentSettingsView,
  ThemePreference,
  UserPreferences
} from '@shared/contract';
import {
  AGENT_PROVIDER_CATALOG,
  AGENT_PROVIDER_IDS,
  createDefaultAssistantChatProfile
} from '@shared/contract';
import { useRuntimeSnapshot } from '@renderer/core/runtime/runtime-store';
import { formatRuntimeAvailability } from '@renderer/core/runtime/runtime-labels';
import type { FeaturePanelProps } from '@renderer/core/modules/module-contract';
import { workspaceNameFromPath } from '@renderer/core/conversations/conversation-navigation-service';
import { createEditableLocalModelRoots, moveLocalModelRoot, normalizeLocalModelRoots } from './local-model-roots';
import { useSpeechSnapshot } from '@renderer/core/speech/speech-coordinator';
import { SelectMenu } from '@renderer/shared/ui/SelectMenu';

const themeOptions: Array<{ value: ThemePreference; label: string; icon: typeof Sun }> = [
  { value: 'system', label: '跟随系统', icon: Laptop },
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'light', label: '浅色', icon: Sun }
];

const emptyKeys = Object.fromEntries(AGENT_PROVIDER_IDS.map((id) => [id, ''])) as Record<AgentProviderId, string>;
const noClearRequests = Object.fromEntries(AGENT_PROVIDER_IDS.map((id) => [id, false])) as Record<AgentProviderId, boolean>;
const initialProviderExpansion = Object.fromEntries(AGENT_PROVIDER_IDS.map((id) => [id, false])) as Record<AgentProviderId, boolean>;
const SETTINGS_CATEGORY_STORAGE_KEY = 'ariadne.settings.category.v1';

type SettingsCategory = 'agent' | 'chat' | 'speech' | 'archives' | 'desktop';

const settingsCategories: ReadonlyArray<{
  id: SettingsCategory;
  label: string;
  description: string;
  icon: typeof KeyRound;
}> = [
  { id: 'agent', label: 'Agent 与模型', description: 'Provider、模型与 SubAgent', icon: KeyRound },
  { id: 'chat', label: '聊天与人设', description: '助手与用户人设', icon: MessageCircle },
  { id: 'speech', label: '本地语音', description: '识别、播报与音色包', icon: Mic },
  { id: 'archives', label: '归档管理', description: '聊天与工作区恢复', icon: ArchiveRestore },
  { id: 'desktop', label: '外观与桌面', description: '主题、托盘与通知', icon: Laptop }
];

export function SettingsPanel({ moduleId, services }: FeaturePanelProps): React.JSX.Element {
  const runtime = useRuntimeSnapshot(services.runtime);
  const speech = useSpeechSnapshot(services.speech);
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [agentSettings, setAgentSettings] = useState<AgentSettingsView | null>(null);
  const [apiKeys, setApiKeys] = useState<Record<AgentProviderId, string>>(emptyKeys);
  const [clearRequests, setClearRequests] = useState<Record<AgentProviderId, boolean>>(noClearRequests);
  const [expandedProviders, setExpandedProviders] = useState<Record<AgentProviderId, boolean>>(() => ({ ...initialProviderExpansion }));
  const [localModelRoots, setLocalModelRoots] = useState<string[]>(['']);
  const [draggingRootIndex, setDraggingRootIndex] = useState<number | null>(null);
  const [dropTargetRootIndex, setDropTargetRootIndex] = useState<number | null>(null);
  const localModelRootInputs = useRef<Array<HTMLInputElement | null>>([]);
  const localModelRootHandles = useRef<Array<HTMLButtonElement | null>>([]);
  const preferenceUpdateGeneration = useRef(0);
  const persistedAgentSettings = useRef<AgentSettingsView | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  const [notificationTestResult, setNotificationTestResult] = useState<string | null>(null);
  const [restoringWorkspaceId, setRestoringWorkspaceId] = useState<string | null>(null);
  const [workspaceLifecycleError, setWorkspaceLifecycleError] = useState<string | null>(null);
  const [restoringSessionId, setRestoringSessionId] = useState<string | null>(null);
  const [sessionLifecycleError, setSessionLifecycleError] = useState<string | null>(null);
  const [speechActionResult, setSpeechActionResult] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>(() => {
    const saved = window.localStorage.getItem(SETTINGS_CATEGORY_STORAGE_KEY);
    return settingsCategories.some((category) => category.id === saved)
      ? saved as SettingsCategory
      : 'agent';
  });

  const selectCategory = (category: SettingsCategory): void => {
    setActiveCategory(category);
    window.localStorage.setItem(SETTINGS_CATEGORY_STORAGE_KEY, category);
  };

  useEffect(() => {
    void Promise.all([services.preferences.load(), services.agentSettings.load()]).then(([loadedPreferences, loadedAgentSettings]) => {
      setPreferences(loadedPreferences);
      setAgentSettings(loadedAgentSettings);
      persistedAgentSettings.current = loadedAgentSettings;
      setLocalModelRoots(createEditableLocalModelRoots(loadedAgentSettings.localModelRoots));
    }).catch((error) => {
      setSaveResult({ tone: 'error', message: errorMessage(error) });
    });
    if (typeof services.agentSettings.onWorkspacesChanged !== 'function') return undefined;
    return services.agentSettings.onWorkspacesChanged((settings) => {
      persistedAgentSettings.current = persistedAgentSettings.current
        ? {
            ...persistedAgentSettings.current,
            revision: settings.revision,
            workspaces: settings.workspaces
          }
        : settings;
      setAgentSettings((current) => current
        ? { ...current, revision: settings.revision, workspaces: settings.workspaces }
        : settings);
    });
  }, [services]);

  const modelHealth = useMemo(() => new Map(runtime.models.map((model) => [model.id, model])), [runtime.models]);
  const runtimeIsLoading = runtime.status.availability === 'starting' || runtime.status.availability === 'restarting';
  const runtimeStateTone = runtime.status.availability === 'ready'
    ? 'ready'
    : runtimeIsLoading
      ? 'loading'
      : runtime.status.availability === 'degraded'
        ? 'degraded'
        : runtime.status.availability === 'crashed'
          ? 'error'
          : 'inactive';
  const runtimeStateSymbol = runtime.status.availability === 'ready'
    ? '✓'
    : runtime.status.availability === 'degraded' || runtime.status.availability === 'crashed'
      ? '!'
      : '–';
  const runtimeStateLabel = runtimeIsLoading
    ? 'Runtime 正在更新'
    : `Runtime ${formatRuntimeAvailability(runtime.status.availability)}`;

  const savePreferences = (next: UserPreferences): void => {
    const generation = ++preferenceUpdateGeneration.current;
    setPreferences(next);
    setPreferenceError(null);
    void (async () => {
      try {
        const saved = await services.preferences.update(next);
        if (generation !== preferenceUpdateGeneration.current) return;
        setPreferences(saved);
        services.events.emit('preferences:changed', saved);
      } catch (error) {
        if (generation !== preferenceUpdateGeneration.current) return;
        try {
          const restored = await services.preferences.load();
          if (generation !== preferenceUpdateGeneration.current) return;
          setPreferences(restored);
          services.events.emit('preferences:changed', restored);
        } catch (reloadError) {
          if (generation !== preferenceUpdateGeneration.current) return;
          setPreferenceError(errorMessage(
            new AggregateError([error, reloadError], '保存桌面偏好失败，且无法重新读取当前设置。'),
            '保存桌面偏好失败。'
          ));
          return;
        }
        setPreferenceError(errorMessage(error, '保存桌面偏好失败。'));
      }
    })();
  };

  const updateProvider = (id: AgentProviderId, patch: Partial<AgentProviderSettingsView>): void => {
    setAgentSettings((current) => current ? {
      ...current,
      providers: {
        ...current.providers,
        [id]: { ...current.providers[id], ...patch }
      }
    } : current);
  };

  const updateSubagentProvider = (
    index: number,
    patch: Partial<AgentAcpSubagentProviderSettingsView>
  ): void => {
    setAgentSettings((current) => current ? {
      ...current,
      subagentProviders: current.subagentProviders.map((provider, providerIndex) => (
        providerIndex === index ? { ...provider, ...patch } : provider
      ))
    } : current);
  };

  const addSubagentProvider = (): void => {
    setAgentSettings((current) => {
      if (!current || current.subagentProviders.length >= 8) return current;
      const providerId = nextAcpProviderId(current.subagentProviders);
      return {
        ...current,
        subagentProviders: [...current.subagentProviders, {
          kind: 'acp_stdio',
          providerId,
          displayName: '外部 ACP 子代理',
          enabled: false,
          command: 'C:\\path\\to\\acp-agent.exe',
          args: [],
          permissionPolicy: 'reject',
          networkAccess: 'offline',
          timeoutMs: 30 * 60_000,
          disposeGraceMs: 6_000
        }]
      };
    });
  };

  const removeSubagentProvider = (index: number): void => {
    setAgentSettings((current) => current ? {
      ...current,
      subagentProviders: current.subagentProviders.filter((_, providerIndex) => (
        providerIndex !== index
      ))
    } : current);
  };

  const updateLocalModelRoot = (index: number, value: string): void => {
    setLocalModelRoots((current) => current.map((root, rootIndex) => rootIndex === index ? value : root));
  };

  const addLocalModelRoot = (): void => {
    const nextIndex = localModelRoots.length;
    setLocalModelRoots((current) => [...current, '']);
    requestAnimationFrame(() => localModelRootInputs.current[nextIndex]?.focus());
  };

  const removeLocalModelRoot = (index: number): void => {
    setLocalModelRoots((current) => createEditableLocalModelRoots(current.filter((_, rootIndex) => rootIndex !== index)));
  };

  const reorderLocalModelRoot = (fromIndex: number, toIndex: number): void => {
    if (fromIndex === toIndex) return;
    setLocalModelRoots((current) => moveLocalModelRoot(current, fromIndex, toIndex));
  };

  const handleRootDragStart = (event: DragEvent<HTMLButtonElement>, index: number): void => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(index));
    setDraggingRootIndex(index);
    setDropTargetRootIndex(index);
  };

  const handleRootDrop = (event: DragEvent<HTMLDivElement>, index: number): void => {
    event.preventDefault();
    if (draggingRootIndex !== null) reorderLocalModelRoot(draggingRootIndex, index);
    setDraggingRootIndex(null);
    setDropTargetRootIndex(null);
  };

  const handleRootReorderKey = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    const targetIndex = event.key === 'ArrowUp' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= localModelRoots.length) return;
    reorderLocalModelRoot(index, targetIndex);
    requestAnimationFrame(() => localModelRootHandles.current[targetIndex]?.focus());
  };

  const saveAgentSettings = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!agentSettings || saving) return;
    const baseline = persistedAgentSettings.current;
    if (!baseline) return;
    setSaving(true);
    setSaveResult(null);
    try {
      const normalizedRoots = normalizeLocalModelRoots(localModelRoots);
      const operations: AgentSettingsOperation[] = [];
      if (!sameJsonValue(agentSettings.assistant, baseline.assistant)) {
        operations.push({
          kind: 'assistant.replace',
          assistant: structuredClone(agentSettings.assistant)
        });
      }
      if (!sameJsonValue(normalizedRoots, baseline.localModelRoots)) {
        operations.push({ kind: 'modelRoots.replace', roots: normalizedRoots });
      }
      for (const id of AGENT_PROVIDER_IDS) {
        const provider = agentSettings.providers[id];
        const previous = baseline.providers[id];
        const patch: AgentProviderSettingsPatch = {};
        if (provider.enabled !== previous.enabled) patch.enabled = provider.enabled;
        if (provider.baseUrl !== previous.baseUrl) patch.baseUrl = provider.baseUrl;
        if (provider.model !== previous.model) patch.model = provider.model;
        if (provider.contextWindowTokens !== previous.contextWindowTokens) {
          patch.contextWindowTokens = provider.contextWindowTokens;
        }
        if (provider.maxOutputTokens !== previous.maxOutputTokens) {
          patch.maxOutputTokens = provider.maxOutputTokens;
        }
        if (!sameJsonValue(provider.inference, previous.inference)) patch.inference = provider.inference;
        const apiKey = apiKeys[id].trim();
        if (clearRequests[id]) patch.clearApiKey = true;
        else if (apiKey) patch.apiKey = apiKey;
        if (Object.keys(patch).length > 0) {
          operations.push({ kind: 'provider.update', providerId: id, patch });
        }
      }
      if (!sameJsonValue(agentSettings.subagentProviders, baseline.subagentProviders)) {
        operations.push({
          kind: 'subagentProviders.replace',
          providers: agentSettings.subagentProviders.map((provider) => ({
            ...provider,
            args: [...provider.args]
          }))
        });
      }
      if (operations.length === 0) {
        setSaveResult({ tone: 'success', message: activeCategory === 'chat' ? '聊天设置没有变更。' : 'Agent 设置没有变更。' });
        return;
      }
      const result = await services.agentSettings.apply({
        expectedRevision: baseline.revision,
        operations
      });
      if (!result.ok) {
        persistedAgentSettings.current = result.settings;
        setAgentSettings(result.settings);
        setLocalModelRoots(createEditableLocalModelRoots(result.settings.localModelRoots));
        throw new Error(`${result.error.code}: ${result.error.message}`);
      }
      const saved = result.settings;
      persistedAgentSettings.current = saved;
      setAgentSettings(saved);
      setLocalModelRoots(createEditableLocalModelRoots(saved.localModelRoots));
      setApiKeys({ ...emptyKeys });
      setClearRequests({ ...noClearRequests });
      setSaveResult({ tone: 'success', message: settingsEffectMessage(result.effect) });
    } catch (error) {
      setSaveResult({ tone: 'error', message: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  const restoreWorkspace = async (workspaceId: string): Promise<void> => {
    if (restoringWorkspaceId) return;
    setRestoringWorkspaceId(workspaceId);
    setWorkspaceLifecycleError(null);
    try {
      await services.conversationNavigation.restoreWorkspace(workspaceId);
    } catch (error) {
      setWorkspaceLifecycleError(errorMessage(error, '恢复工作区失败。'));
    } finally {
      setRestoringWorkspaceId(null);
    }
  };

  const restoreSession = async (
    session: (typeof runtime.sessions)[number]
  ): Promise<void> => {
    if (restoringSessionId) return;
    setRestoringSessionId(session.sessionId);
    setSessionLifecycleError(null);
    try {
      await services.runtime.restoreSession(session);
    } catch (error) {
      setSessionLifecycleError(errorMessage(error, '恢复聊天失败。'));
    } finally {
      setRestoringSessionId(null);
    }
  };

  const archivedWorkspaces = agentSettings?.workspaces.filter(
    (workspace) => workspace.archivedAt
  ) ?? [];
  const archivedSessions = runtime.sessions.filter(
    (session) => session.status === 'archived'
  );

  return (
    <section className="settings-panel" aria-labelledby={`${moduleId}-title`}>
      <aside className="settings-navigation">
        <header className="settings-navigation-header">
          <span>设置中心</span>
          <h1 id={`${moduleId}-title`}>Ariadne 设置</h1>
          <p>按功能分类管理桌面能力。</p>
        </header>
        <nav aria-label="设置分类">
          {settingsCategories.map(({ id, label, description, icon: Icon }) => (
            <button
              type="button"
              key={id}
              title={label}
              className={`settings-navigation-item${activeCategory === id ? ' is-active' : ''}`}
              aria-current={activeCategory === id ? 'page' : undefined}
              onClick={() => selectCategory(id)}
            >
              <span className="settings-navigation-icon"><Icon size={16} /></span>
              <span className="settings-navigation-copy"><strong>{label}</strong><small>{description}</small></span>
            </button>
          ))}
        </nav>
        <p className="settings-navigation-note">桌面偏好自动保存；Agent 与聊天配置需手动确认。</p>
      </aside>

      <div className={`settings-content${activeCategory === 'agent' || activeCategory === 'chat' ? ' settings-content--with-actions' : ''}`}>
        <div className="settings-content-scroll">
      {activeCategory === 'agent' && <section className="settings-section" aria-labelledby={`${moduleId}-model-settings`}>
        <div className="settings-section-heading">
          <div className="settings-section-title"><span className="settings-section-icon"><KeyRound size={16} /></span><div className="settings-section-copy"><h2 id={`${moduleId}-model-settings`}>Agent 与模型</h2><p>配置本地模型目录和远程 Provider；工作区通过 Chat 侧栏的“打开工作区”管理。</p></div></div>
          <span className={`settings-runtime-state settings-runtime-state--${runtimeStateTone}`} data-runtime-availability={runtime.status.availability} role="status" aria-live="polite">
            <span className={`settings-runtime-indicator settings-runtime-indicator--${runtimeStateTone}`} aria-hidden="true">{runtimeIsLoading ? null : runtimeStateSymbol}</span>
            <span>{runtimeStateLabel}</span>
          </span>
        </div>

        {agentSettings ? (
          <form id={`${moduleId}-agent-settings-form`} className="agent-settings-form" onSubmit={(event) => void saveAgentSettings(event)}>
            <div className="agent-settings-grid">
              <div className="settings-field settings-field--wide local-model-roots-field">
                <span id={`${moduleId}-local-model-roots-label`}>本地模型目录</span>
                <div className="local-model-roots-control" aria-labelledby={`${moduleId}-local-model-roots-label`}>
                  <div className="local-model-roots-list">
                    {localModelRoots.map((root, index) => <div
                      className={`local-model-root-row${draggingRootIndex === index ? ' is-dragging' : ''}${dropTargetRootIndex === index && draggingRootIndex !== index ? ' is-drop-target' : ''}`}
                      key={index}
                      onDragOver={(event) => {
                        if (draggingRootIndex === null) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = 'move';
                        setDropTargetRootIndex(index);
                      }}
                      onDrop={(event) => handleRootDrop(event, index)}
                    >
                      <button
                        ref={(element) => { localModelRootHandles.current[index] = element; }}
                        type="button"
                        className="local-model-root-handle"
                        draggable
                        aria-label={`拖动调整目录 ${index + 1} 的顺序`}
                        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                        onDragStart={(event) => handleRootDragStart(event, index)}
                        onDragEnd={() => {
                          setDraggingRootIndex(null);
                          setDropTargetRootIndex(null);
                        }}
                        onKeyDown={(event) => handleRootReorderKey(event, index)}
                      ><span aria-hidden="true">=</span></button>
                      <input
                        ref={(element) => { localModelRootInputs.current[index] = element; }}
                        className="local-model-root-input"
                        value={root}
                        aria-label={`本地模型目录 ${index + 1}`}
                        placeholder={index === 0 ? '例如 D:\\Models' : '输入绝对路径'}
                        onChange={(event) => updateLocalModelRoot(index, event.target.value)}
                      />
                      <button type="button" className="local-model-root-remove" aria-label={`删除目录 ${index + 1}`} onClick={() => removeLocalModelRoot(index)}><X size={12} /></button>
                    </div>)}
                  </div>
                  <button type="button" className="local-model-root-add" onClick={addLocalModelRoot}><Plus size={12} />添加目录</button>
                </div>
                <small>目录从上到下按优先级排列；拖动左侧“=”可以调整顺序。</small>
              </div>
            </div>

            <div className="provider-settings-list">
              {AGENT_PROVIDER_IDS.map((id) => {
                const { label, runtimeModelId, apiKeyLabel } = AGENT_PROVIDER_CATALOG[id];
                const provider = agentSettings.providers[id];
                const health = modelHealth.get(runtimeModelId);
                const expanded = expandedProviders[id];
                const detailsId = `${moduleId}-${id}-provider-details`;
                const keyStatus = clearRequests[id]
                  ? '保存后清除'
                  : apiKeys[id]
                    ? '待保存'
                    : provider.apiKeyStatus === 'configured'
                      ? '已安全保存'
                      : provider.apiKeyStatus === 'unavailable'
                        ? '密文不可用'
                        : '未配置';
                return <fieldset className={`provider-settings-card${expanded ? ' is-expanded' : ' is-collapsed'}`} key={id}>
                  <legend>
                    <button
                      type="button"
                      className="provider-disclosure"
                      aria-expanded={expanded}
                      aria-controls={detailsId}
                      onClick={() => setExpandedProviders((current) => ({ ...current, [id]: !current[id] }))}
                    >
                      <ChevronRight size={14} aria-hidden="true" />
                      <span>{label}</span>
                    </button>
                    <label className="provider-enable"><input type="checkbox" aria-label={`启用 ${label}`} checked={provider.enabled} onChange={(event) => updateProvider(id, { enabled: event.target.checked })} /><span>启用</span></label>
                  </legend>
                  <div id={detailsId} className="provider-settings-body" hidden={!expanded}>
                    <div className="provider-health"><span className={`provider-health-dot provider-health-dot--${health?.availability ?? 'unavailable'}`} />{health ? modelAvailabilityLabel(health.availability) : '等待 Runtime 检查'} · API Key {keyStatus}</div>
                    <div className="agent-settings-grid">
                      <label className="settings-field"><span>模型</span><input value={provider.model} onChange={(event) => {
                        const model = event.target.value;
                        updateProvider(id, {
                          model,
                          ...(model === AGENT_PROVIDER_CATALOG[id].defaultModel
                            ? {
                                contextWindowTokens: AGENT_PROVIDER_CATALOG[id].defaultContextWindowTokens,
                                maxOutputTokens: AGENT_PROVIDER_CATALOG[id].defaultMaxOutputTokens
                              }
                            : {}),
                          inference: model === AGENT_PROVIDER_CATALOG[id].defaultModel
                            ? structuredClone(AGENT_PROVIDER_CATALOG[id].defaultInference)
                            : {}
                        });
                      }} /><small>{inferenceDescription(provider.inference)}</small></label>
                      <label className="settings-field"><span>上下文窗口（tokens）</span><input type="number" min={8192} max={10000000} step={1024} value={provider.contextWindowTokens} onChange={(event) => updateProvider(id, { contextWindowTokens: Number(event.target.value) })} /><small>必须填写精确模型容量；用于 v3 压力压缩。</small></label>
                      <label className="settings-field"><span>最大输出（tokens）</span><input type="number" min={256} max={1000000} step={256} value={provider.maxOutputTokens} onChange={(event) => updateProvider(id, { maxOutputTokens: Number(event.target.value) })} /><small>在输入预算之前预留。</small></label>
                      <label className="settings-field settings-field--wide"><span>API 地址</span><input type="url" value={provider.baseUrl} onChange={(event) => updateProvider(id, { baseUrl: event.target.value })} /></label>
                      <label className="settings-field settings-field--wide"><span>{apiKeyLabel}</span><div className="api-key-input"><input type="password" autoComplete="off" value={apiKeys[id]} onChange={(event) => {
                        setApiKeys((current) => ({ ...current, [id]: event.target.value }));
                        if (event.target.value) setClearRequests((current) => ({ ...current, [id]: false }));
                      }} placeholder={provider.apiKeyStatus === 'configured' ? '已安全保存；输入新值可替换' : '输入 API Key'} />
                      <button type="button" disabled={provider.apiKeyStatus === 'missing' && !apiKeys[id]} onClick={() => {
                        setApiKeys((current) => ({ ...current, [id]: '' }));
                        setClearRequests((current) => ({ ...current, [id]: true }));
                      }}>清除</button></div></label>
                    </div>
                  </div>
                </fieldset>;
              })}
            </div>

            <div className="provider-settings-list" aria-label="外部 SubAgent Provider">
              <div className="settings-section-copy">
                <h3>外部 SubAgent（ACP）</h3>
                <p>每次委派启动独立进程，只共享当前工作目录和委派目标。默认拒绝无人值守权限请求；允许项和联网仍受 Child 冻结权限与能力约束，不会继承父对话、父工具或环境凭据。</p>
              </div>
              {agentSettings.subagentProviders.map((provider, index) => (
                <fieldset className="provider-settings-card is-expanded" key={`${provider.providerId}-${index}`}>
                  <legend>
                    <span>{provider.displayName || provider.providerId}</span>
                    <label className="provider-enable"><input
                      type="checkbox"
                      checked={provider.enabled}
                      onChange={(event) => updateSubagentProvider(index, { enabled: event.target.checked })}
                    /><span>启用</span></label>
                  </legend>
                  <div className="provider-settings-body">
                    <div className="agent-settings-grid">
                      <label className="settings-field"><span>Provider ID</span><input
                        value={provider.providerId}
                        onChange={(event) => updateSubagentProvider(index, { providerId: event.target.value })}
                      /></label>
                      <label className="settings-field"><span>显示名称</span><input
                        value={provider.displayName}
                        onChange={(event) => updateSubagentProvider(index, { displayName: event.target.value })}
                      /></label>
                      <label className="settings-field settings-field--wide"><span>ACP 可执行文件（绝对路径）</span><input
                        value={provider.command}
                        onChange={(event) => updateSubagentProvider(index, { command: event.target.value })}
                      /></label>
                      <label className="settings-field settings-field--wide"><span>启动参数（每行一个）</span><textarea
                        value={provider.args.join('\n')}
                        onChange={(event) => updateSubagentProvider(index, {
                          args: event.target.value.split(/\r?\n/u).filter((value) => value.length > 0)
                        })}
                      /></label>
                      <div className="settings-field settings-select-field"><span>权限请求</span><SelectMenu
                        className="settings-select-menu"
                        ariaLabel="选择 ACP 权限策略"
                        placement="bottom"
                        value={provider.permissionPolicy}
                        options={[{ value: 'reject', label: '默认拒绝' }, { value: 'allow', label: '按 Child 权限允许' }]}
                        onChange={(permissionPolicy) => updateSubagentProvider(index, { permissionPolicy })}
                      /></div>
                      <div className="settings-field settings-select-field"><span>网络</span><SelectMenu
                        className="settings-select-menu"
                        ariaLabel="选择 ACP 网络策略"
                        placement="bottom"
                        value={provider.networkAccess}
                        options={[{ value: 'offline', label: '离线' }, { value: 'online-approved', label: '按 Child 权限联网' }]}
                        onChange={(networkAccess) => updateSubagentProvider(index, { networkAccess })}
                      /></div>
                      <label className="settings-field"><span>运行超时（毫秒）</span><input
                        type="number" min={1000} max={86400000}
                        value={provider.timeoutMs}
                        onChange={(event) => updateSubagentProvider(index, { timeoutMs: Number(event.target.value) })}
                      /></label>
                      <label className="settings-field"><span>回收宽限（毫秒）</span><input
                        type="number" min={100} max={60000}
                        value={provider.disposeGraceMs}
                        onChange={(event) => updateSubagentProvider(index, { disposeGraceMs: Number(event.target.value) })}
                      /></label>
                    </div>
                    <button type="button" className="secondary-button" onClick={() => removeSubagentProvider(index)}><X size={12} />移除 Provider</button>
                  </div>
                </fieldset>
              ))}
              <button
                type="button"
                className="local-model-root-add"
                disabled={agentSettings.subagentProviders.length >= 8}
                onClick={addSubagentProvider}
              ><Plus size={12} />添加 ACP Provider</button>
            </div>

            <div className="settings-json-note"><Database size={14} /><p>配置写入用户数据目录的 <code>settings.toml</code>。API Key 只以系统安全存储生成的密文保存，加载设置时不会回传明文。</p></div>
          </form>
        ) : <p className="module-empty-state">正在读取 Agent 设置…</p>}
      </section>}

      {activeCategory === 'chat' && <section className="settings-section" aria-labelledby={`${moduleId}-chat-settings`}>
        <div className="settings-section-heading">
          <div className="settings-section-title"><span className="settings-section-icon"><MessageCircle size={16} /></span><div className="settings-section-copy"><h2 id={`${moduleId}-chat-settings`}>聊天与人设</h2><p>控制个人助手的称呼、回答风格，以及可选的用户背景。个人助手始终直接回答。</p></div></div>
        </div>
        {agentSettings ? (
          <form id={`${moduleId}-chat-settings-form`} className="agent-settings-form assistant-settings-form" onSubmit={(event) => void saveAgentSettings(event)}>
            <div className="agent-settings-grid">
              <label className="settings-field"><span>助手名称</span><input
                required
                maxLength={64}
                value={agentSettings.assistant.name}
                onChange={(event) => setAgentSettings((current) => current ? {
                  ...current,
                  assistant: { ...current.assistant, name: event.target.value }
                } : current)}
                placeholder="Ariadne"
              /><small>作为当前个人助手的名称写入每次聊天的系统指令。</small></label>
              <label className="settings-field settings-field--wide"><span>助手人设 / 回答风格</span><textarea
                required
                maxLength={32768}
                rows={10}
                value={agentSettings.assistant.systemPrompt}
                onChange={(event) => setAgentSettings((current) => current ? {
                  ...current,
                  assistant: { ...current.assistant, systemPrompt: event.target.value }
                } : current)}
                placeholder="描述助手的身份、语气、简洁程度、回答格式和需要长期遵守的偏好。"
              /><small>作为系统指令发送给本地模型和远程 API；不同模型的遵循程度可能不同。不要填写 API Key、密码或其他敏感信息。</small></label>
              <label className="settings-field settings-field--wide settings-field--user-persona"><span>用户人设（可选）</span><textarea
                maxLength={32768}
                rows={6}
                value={agentSettings.assistant.userPersona}
                onChange={(event) => setAgentSettings((current) => current ? {
                  ...current,
                  assistant: { ...current.assistant, userPersona: event.target.value }
                } : current)}
                placeholder="例如你的背景、沟通偏好或希望助手长期了解的信息；不填写时不会向模型添加用户人设。"
              /><small>默认留空。只有填写内容时才会进入个人助手的系统指令；它不会授予文件、命令或工具权限。</small></label>
            </div>
            <button type="button" className="secondary-button assistant-reset-button" onClick={() => setAgentSettings((current) => current ? {
              ...current,
              assistant: createDefaultAssistantChatProfile()
            } : current)}><RotateCcw size={14} />恢复默认人设</button>
          </form>
        ) : <p className="module-empty-state">正在读取聊天设置…</p>}
      </section>}

      {activeCategory === 'speech' && <section className="settings-section" aria-labelledby={`${moduleId}-speech-settings`}>
        <div className="settings-section-heading">
          <div className="settings-section-title"><span className="settings-section-icon"><Mic size={16} /></span><div className="settings-section-copy"><h2 id={`${moduleId}-speech-settings`}>本地语音</h2><p>独立 Sidecar；关闭、缺失或崩溃不会影响文字聊天和 Agent。</p></div></div>
          <span className={`settings-runtime-state settings-runtime-state--${speech.status.availability === 'available' ? 'ready' : speech.status.availability === 'degraded' ? 'degraded' : 'inactive'}`}>
            <span>{speechAvailabilityLabel(speech.status.availability)}</span>
          </span>
        </div>
        {preferences && <div className="speech-settings-grid">
          <div className="setting-block setting-block--wide"><div><strong>启用语音模块</strong><p>{speech.status.detail}</p></div><label className="switch"><input type="checkbox" checked={preferences.speech.enabled} onChange={(event) => savePreferences({ ...preferences, speech: { ...preferences.speech, enabled: event.target.checked } })} /><span /></label></div>
          <label className="settings-field settings-field--wide"><span>模块根目录</span><input value={preferences.speech.moduleRoot} onChange={(event) => setPreferences({ ...preferences, speech: { ...preferences.speech, moduleRoot: event.target.value } })} onBlur={(event) => savePreferences({ ...preferences, speech: { ...preferences.speech, moduleRoot: event.currentTarget.value } })} /><small>运行时、模型、语音包和训练资产统一放在 E 盘外部目录。</small></label>
          <div className="settings-field settings-select-field"><span>前台语音输入</span><SelectMenu className="settings-select-menu" ariaLabel="选择前台语音输入模式" placement="bottom" value={preferences.speech.foregroundSttMode} options={[{ value: 'compose', label: '写入输入框确认' }, { value: 'auto-send', label: '识别完成后自动发送' }]} onChange={(foregroundSttMode) => savePreferences({ ...preferences, speech: { ...preferences.speech, foregroundSttMode } })} /></div>
          <label className="settings-field"><span>唤醒关键词</span><input value={preferences.speech.wakeKeywords.join(', ')} onChange={(event) => setPreferences({ ...preferences, speech: { ...preferences.speech, wakeKeywords: parseWakeKeywords(event.target.value) } })} onBlur={(event) => savePreferences({ ...preferences, speech: { ...preferences.speech, wakeKeywords: parseWakeKeywords(event.currentTarget.value) } })} /><small>逗号分隔；默认 Ariadne。</small></label>
          <div className="setting-block"><div><strong>后台关键词唤醒</strong><p>仅窗口隐藏到托盘时监听，唤醒后在个人助手专用会话中自动发送。</p></div><label className="switch"><input type="checkbox" checked={preferences.speech.backgroundWakeEnabled} onChange={(event) => savePreferences({ ...preferences, speech: { ...preferences.speech, backgroundWakeEnabled: event.target.checked } })} /><span /></label></div>
          <div className="setting-block"><div><strong>锁屏时继续监听</strong><p>默认关闭；开启后锁屏仍会保持关键词检测。</p></div><label className="switch"><input type="checkbox" checked={preferences.speech.listenWhenLocked} onChange={(event) => savePreferences({ ...preferences, speech: { ...preferences.speech, listenWhenLocked: event.target.checked } })} /><span /></label></div>
          <div className="settings-field settings-select-field"><span>麦克风</span><SelectMenu className="settings-select-menu" ariaLabel="选择麦克风" placement="bottom" value={preferences.speech.inputDeviceId} options={[{ value: 'default', label: '系统默认' }, ...speech.status.inputDevices.filter((device) => device.id !== 'default').map((device) => ({ value: device.id, label: device.label }))]} onChange={(inputDeviceId) => savePreferences({ ...preferences, speech: { ...preferences.speech, inputDeviceId } })} /></div>
          <div className="settings-field settings-select-field"><span>扬声器</span><SelectMenu className="settings-select-menu" ariaLabel="选择扬声器" placement="bottom" value={preferences.speech.outputDeviceId} options={[{ value: 'default', label: '系统默认' }, ...speech.status.outputDevices.filter((device) => device.id !== 'default').map((device) => ({ value: device.id, label: device.label }))]} onChange={(outputDeviceId) => savePreferences({ ...preferences, speech: { ...preferences.speech, outputDeviceId } })} /></div>
          <div className="settings-field settings-field--wide settings-select-field"><span>当前音色</span><SelectMenu className="settings-select-menu" ariaLabel="选择当前音色" placement="bottom" value={speech.status.voices.find((voice) => voice.active) ? `${speech.status.voices.find((voice) => voice.active)!.voiceId}@${speech.status.voices.find((voice) => voice.active)!.version}` : ''} options={[{ value: '', label: '未选择' }, ...speech.status.voices.map((voice) => ({ value: `${voice.voiceId}@${voice.version}`, label: `${voice.displayName} · ${voice.version}` }))]} onChange={(value) => {
            const [voiceId, version] = value.split('@');
            if (!voiceId || !version) return;
            setSpeechActionResult('正在测试并切换音色…');
            void services.speech.activateVoice(voiceId, version).then(async (voice) => {
              const saved = await services.preferences.load();
              setPreferences(saved);
              services.events.emit('preferences:changed', saved);
              setSpeechActionResult(`已切换到 ${voice.displayName}。`);
            }).catch((error) => setSpeechActionResult(`切换失败：${errorMessage(error)}`));
          }} /></div>
          <div className="setting-block setting-block--wide"><div><strong>安装语音包</strong><p>导入 .avp 后先校验哈希和模型试合成，再安装到固定目录。</p>{speechActionResult && <small>{speechActionResult}</small>}</div><button type="button" className="secondary-button" disabled={!preferences.speech.enabled || !speech.status.capabilities.includes('voice-pack')} onClick={() => {
            setSpeechActionResult('正在校验语音包…');
            void services.speech.importVoicePack().then((result) => setSpeechActionResult(result ? result.detail : '已取消导入。')).catch((error) => setSpeechActionResult(`导入失败：${errorMessage(error)}`));
          }}><PackageOpen size={14} />导入 .avp</button></div>
        </div>}
      </section>}

      {activeCategory === 'archives' && <div className="settings-content-stack">
      <section className="settings-section archived-workspaces-section" aria-labelledby={`${moduleId}-archived-sessions`}>
        <div className="settings-section-heading">
          <div className="settings-section-title">
            <span className="settings-section-icon"><ArchiveRestore size={16} /></span>
            <div className="settings-section-copy">
              <h2 id={`${moduleId}-archived-sessions`}>已归档聊天</h2>
              <p>归档只会从会话侧栏隐藏聊天，不会删除消息；可随时恢复。</p>
            </div>
          </div>
        </div>
        {archivedSessions.length === 0 ? (
          <p className="archived-workspaces-empty">暂无已归档聊天。</p>
        ) : (
          <div className="archived-workspaces-list">
            {sessionLifecycleError && <p className="is-danger" role="alert">{sessionLifecycleError}</p>}
            {archivedSessions.map((session) => (
              <article className="archived-workspace-card" key={session.sessionId}>
                <div>
                  <strong>{session.title}</strong>
                  <small>消息与运行记录仍然保留。</small>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={restoringSessionId !== null}
                  onClick={() => { void restoreSession(session); }}
                ><ArchiveRestore size={14} />{restoringSessionId === session.sessionId ? '正在恢复…' : '恢复'}</button>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="settings-section archived-workspaces-section" aria-labelledby={`${moduleId}-archived-workspaces`}>
        <div className="settings-section-heading">
          <div className="settings-section-title">
            <span className="settings-section-icon"><FolderArchive size={16} /></span>
            <div className="settings-section-copy">
              <h2 id={`${moduleId}-archived-workspaces`}>已归档工作区</h2>
              <p>归档只会从侧栏隐藏工作区，不会删除会话数据；可随时恢复。</p>
            </div>
          </div>
        </div>
        {workspaceLifecycleError && <p className="is-danger" role="alert">{workspaceLifecycleError}</p>}
        {archivedWorkspaces.length === 0 ? (
          <p className="archived-workspaces-empty">暂无已归档工作区。</p>
        ) : (
          <div className="archived-workspaces-list">
            {archivedWorkspaces.map((workspace) => (
              <article className="archived-workspace-card" key={workspace.workspaceId}>
                <div>
                  <strong>{workspaceNameFromPath(workspace.rootPath)}</strong>
                  <code>{workspace.rootPath}</code>
                  <small>关联会话数据会继续保留。</small>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={restoringWorkspaceId !== null}
                  onClick={() => void restoreWorkspace(workspace.workspaceId)}
                ><ArchiveRestore size={14} />{restoringWorkspaceId === workspace.workspaceId ? '正在恢复…' : '恢复'}</button>
              </article>
            ))}
          </div>
        )}
      </section>
      </div>}

      {activeCategory === 'desktop' && <section className="settings-section" aria-labelledby={`${moduleId}-desktop-settings`}>
        <div className="settings-section-heading"><div className="settings-section-title"><span className="settings-section-icon"><Laptop size={16} /></span><div className="settings-section-copy"><h2 id={`${moduleId}-desktop-settings`}>外观与桌面行为</h2><p>这些设置不会触发 Runtime 重启。</p></div></div></div>
        {preferenceError && <p className="is-danger" role="alert">{preferenceError}</p>}
        <div className="setting-block"><div><strong>主题</strong><p>默认跟随系统，也可以单独覆盖 Ariadne 外观。</p></div><div className="theme-options">{themeOptions.map(({ value, label, icon: Icon }) => <button type="button" key={value} className={preferences?.theme === value ? 'is-active' : ''} onClick={() => preferences && savePreferences({ ...preferences, theme: value })}><Icon size={17} />{label}</button>)}</div></div>
        <div className="setting-block"><div><strong>后台常驻</strong><p>关闭主窗口时保留托盘中的桌面应用。</p></div><label className="switch"><input type="checkbox" checked={preferences?.runInBackground ?? true} onChange={(event) => preferences && savePreferences({ ...preferences, runInBackground: event.target.checked })} /><span /></label></div>
        <div className="setting-block"><div><strong>启动时运行</strong><p>登录系统后自动启动桌面应用。</p></div><label className="switch"><input type="checkbox" checked={preferences?.startAtLogin ?? false} onChange={(event) => preferences && savePreferences({ ...preferences, startAtLogin: event.target.checked })} /><span /></label></div>
        <div className="setting-block"><div><strong>Windows 权限通知</strong><p>应用在后台时显示；点击通知会返回对应会话。</p>{notificationTestResult && <small>{notificationTestResult}</small>}</div><button type="button" className="secondary-button" onClick={() => {
          setNotificationTestResult(null);
          void services.system.testApprovalNotification()
            .then((result) => setNotificationTestResult(result.shown
              ? '测试通知已发送。'
              : '当前系统不支持 Electron Windows 通知。'))
            .catch((error) => setNotificationTestResult(`测试失败：${errorMessage(error)}`));
        }}><BellRing size={14} />测试 Windows 通知</button></div>
        <div className="setting-block"><div><strong>安全边界</strong><p>Renderer 保持沙箱与上下文隔离，只通过固定 Preload API 使用桌面能力。</p></div></div>
      </section>}
        </div>
        {(activeCategory === 'agent' || activeCategory === 'chat') && agentSettings && <footer className="agent-settings-actions settings-floating-actions">
          {saveResult && <span className={saveResult.tone === 'success' ? 'is-success' : 'is-error'}>{saveResult.tone === 'success' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}{saveResult.message}</span>}
          <button type="submit" form={`${moduleId}-${activeCategory}-settings-form`} className="primary-button" disabled={saving}><Save size={14} />{saving ? '正在保存并重启…' : activeCategory === 'chat' ? '保存聊天设置' : '保存 Agent 设置'}</button>
        </footer>}
      </div>
    </section>
  );
}

function modelAvailabilityLabel(value: 'ready' | 'unavailable' | 'checking' | 'error'): string {
  switch (value) {
    case 'ready': return '模型可用';
    case 'checking': return '正在检查';
    case 'error': return '检查失败';
    case 'unavailable': return '模型不可用';
  }
}

function inferenceDescription(profile: AgentProviderSettingsView['inference']): string {
  const reasoning = profile.reasoning;
  if (!reasoning) return '未声明可调推理参数；Chat 不显示推理控件。';
  const modes = reasoning.modes.map(reasoningModeLabel).join('、');
  const efforts = reasoning.efforts.map(reasoningEffortLabel).join('、');
  return `推理模式：${modes}${efforts ? `；强度：${efforts}` : ''}`;
}

function reasoningModeLabel(value: 'off' | 'on' | 'auto' | 'pro'): string {
  return { off: '关闭', on: '开启', auto: '自动', pro: 'Pro' }[value];
}

function reasoningEffortLabel(value: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'): string {
  return { none: '无', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高' }[value];
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function nextAcpProviderId(
  providers: readonly AgentAcpSubagentProviderSettingsView[]
): string {
  const existing = new Set(providers.map((provider) => provider.providerId));
  for (let index = 1; index <= 8; index += 1) {
    const candidate = index === 1 ? 'external.acp' : `external.acp.${index}`;
    if (!existing.has(candidate)) return candidate;
  }
  return 'external.acp.8';
}

function settingsEffectMessage(effect: AgentSettingsEffect): string {
  switch (effect) {
    case 'hot_applied': return 'Agent 设置已立即应用。';
    case 'reload_scheduled': return 'Agent 设置已保存，将在下一次 Runtime 启动时生效；当前任务不会中断。';
    case 'restart_required': return 'Agent 设置已保存，Runtime 已按需重新加载。';
  }
}

function errorMessage(error: unknown, fallback = '保存 Agent 设置失败。'): string {
  if (!(error instanceof Error)) return fallback;
  return error.message
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim() || fallback;
}

function parseWakeKeywords(value: string): string[] {
  const keywords = value.split(/[,，]/u).map((item) => item.trim()).filter(Boolean).slice(0, 16);
  return keywords.length > 0 ? keywords : ['Ariadne'];
}

function speechAvailabilityLabel(value: 'available' | 'degraded' | 'disabled' | 'unavailable'): string {
  return { available: '语音就绪', degraded: '部分可用', disabled: '已关闭', unavailable: '未安装' }[value];
}
