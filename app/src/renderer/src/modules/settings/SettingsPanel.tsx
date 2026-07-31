import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent } from 'react';
import { AlertTriangle, ArchiveRestore, BellRing, CheckCircle2, ChevronRight, Database, FolderArchive, KeyRound, Laptop, Moon, Plus, Save, Sun, X } from 'lucide-react';
import type {
  AgentProviderId,
  AgentProviderSettingsView,
  AgentSettingsUpdate,
  AgentSettingsView,
  ThemePreference,
  UserPreferences
} from '@shared/contract';
import { AGENT_PROVIDER_CATALOG, AGENT_PROVIDER_IDS } from '@shared/contract';
import { useRuntimeSnapshot } from '@renderer/core/runtime/runtime-store';
import { formatRuntimeAvailability } from '@renderer/core/runtime/runtime-labels';
import type { FeaturePanelProps } from '@renderer/core/modules/module-contract';
import { workspaceNameFromPath } from '@renderer/core/conversations/conversation-navigation-service';
import { createEditableLocalModelRoots, moveLocalModelRoot, normalizeLocalModelRoots } from './local-model-roots';

const themeOptions: Array<{ value: ThemePreference; label: string; icon: typeof Sun }> = [
  { value: 'system', label: '跟随系统', icon: Laptop },
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'light', label: '浅色', icon: Sun }
];

const emptyKeys = Object.fromEntries(AGENT_PROVIDER_IDS.map((id) => [id, ''])) as Record<AgentProviderId, string>;
const noClearRequests = Object.fromEntries(AGENT_PROVIDER_IDS.map((id) => [id, false])) as Record<AgentProviderId, boolean>;
const initialProviderExpansion = Object.fromEntries(AGENT_PROVIDER_IDS.map((id) => [id, false])) as Record<AgentProviderId, boolean>;

export function SettingsPanel({ moduleId, services }: FeaturePanelProps): React.JSX.Element {
  const runtime = useRuntimeSnapshot(services.runtime);
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
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  const [notificationTestResult, setNotificationTestResult] = useState<string | null>(null);
  const [restoringWorkspaceId, setRestoringWorkspaceId] = useState<string | null>(null);
  const [workspaceLifecycleError, setWorkspaceLifecycleError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([services.preferences.load(), services.agentSettings.load()]).then(([loadedPreferences, loadedAgentSettings]) => {
      setPreferences(loadedPreferences);
      setAgentSettings(loadedAgentSettings);
      setLocalModelRoots(createEditableLocalModelRoots(loadedAgentSettings.localModelRoots));
    }).catch((error) => {
      setSaveResult({ tone: 'error', message: errorMessage(error) });
    });
    if (typeof services.agentSettings.onWorkspacesChanged !== 'function') return undefined;
    return services.agentSettings.onWorkspacesChanged((settings) => {
      setAgentSettings((current) => current
        ? { ...current, workspaces: settings.workspaces }
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
    setSaving(true);
    setSaveResult(null);
    try {
      const providers = Object.fromEntries(AGENT_PROVIDER_IDS.map((id) => {
        const provider = agentSettings.providers[id];
        const apiKey = apiKeys[id].trim();
        return [id, {
          enabled: provider.enabled,
          baseUrl: provider.baseUrl,
          model: provider.model,
          inference: provider.inference,
          clearApiKey: clearRequests[id],
          ...(apiKey ? { apiKey } : {})
        }];
      })) as AgentSettingsUpdate['providers'];
      const saved = await services.agentSettings.update({
        routingStrategy: agentSettings.routingStrategy,
        permissionMode: agentSettings.permissionMode,
        customPermissions: agentSettings.customPermissions,
        workspaceRoot: agentSettings.workspaceRoot,
        workspaceAccess: agentSettings.workspaceAccess,
        localModelRoots: normalizeLocalModelRoots(localModelRoots),
        providers
      });
      setAgentSettings(saved);
      setLocalModelRoots(createEditableLocalModelRoots(saved.localModelRoots));
      setApiKeys({ ...emptyKeys });
      setClearRequests({ ...noClearRequests });
      setSaveResult({ tone: 'success', message: 'Agent 设置已保存，Runtime 已按新配置重新启动。' });
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

  const archivedWorkspaces = agentSettings?.workspaces.filter(
    (workspace) => workspace.workspaceId !== 'primary' && workspace.archivedAt
  ) ?? [];

  return (
    <section className="simple-module-panel settings-panel" aria-labelledby={`${moduleId}-title`}>
      <header className="module-content-header"><div><span>设置</span><h1 id={`${moduleId}-title`}>Ariadne 配置</h1></div></header>

      <section className="settings-section" aria-labelledby={`${moduleId}-model-settings`}>
        <div className="settings-section-heading">
          <div className="settings-section-title"><span className="settings-section-icon"><KeyRound size={16} /></span><div className="settings-section-copy"><h2 id={`${moduleId}-model-settings`}>Agent 与模型</h2><p>配置工作区根目录、本地模型目录和远程 Provider；运行权限与路由策略在 Chat 输入区动态选择。</p></div></div>
          <span className={`settings-runtime-state settings-runtime-state--${runtimeStateTone}`} role="status" aria-live="polite">
            <span className={`settings-runtime-indicator settings-runtime-indicator--${runtimeStateTone}`} aria-hidden="true">{runtimeIsLoading ? null : runtimeStateSymbol}</span>
            <span>{runtimeStateLabel}</span>
          </span>
        </div>

        {agentSettings ? (
          <form className="agent-settings-form" onSubmit={(event) => void saveAgentSettings(event)}>
            <div className="agent-settings-grid">
              <label className="settings-field settings-field--wide"><span>Agent 工作区根目录</span><input
                value={agentSettings.workspaceRoot}
                placeholder="例如 E:\\Project\\MyProject"
                onChange={(event) => setAgentSettings({ ...agentSettings, workspaceRoot: event.target.value })}
              /><small>保存后会同时重启 Runtime 与文件浏览器边界；必须使用绝对路径。</small></label>
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
                          inference: model === AGENT_PROVIDER_CATALOG[id].defaultModel
                            ? structuredClone(AGENT_PROVIDER_CATALOG[id].defaultInference)
                            : {}
                        });
                      }} /><small>{inferenceDescription(provider.inference)}</small></label>
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

            <div className="settings-json-note"><Database size={14} /><p>配置写入用户数据目录的 <code>settings.toml</code>。API Key 只以系统安全存储生成的密文保存，加载设置时不会回传明文。</p></div>
            <footer className="agent-settings-actions">
              {saveResult && <span className={saveResult.tone === 'success' ? 'is-success' : 'is-error'}>{saveResult.tone === 'success' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}{saveResult.message}</span>}
              <button type="submit" className="primary-button" disabled={saving}><Save size={14} />{saving ? '正在保存并重启…' : '保存 Agent 设置'}</button>
            </footer>
          </form>
        ) : <p className="module-empty-state">正在读取 Agent 设置…</p>}
      </section>

      <section className="settings-section archived-workspaces-section" aria-labelledby={`${moduleId}-archived-workspaces`}>
        <div className="settings-section-heading">
          <div className="settings-section-title">
            <span className="settings-section-icon"><FolderArchive size={16} /></span>
            <div className="settings-section-copy">
              <h2 id={`${moduleId}-archived-workspaces`}>已归档工作区</h2>
              <p>归档后保留 7 天；到期会永久清理关联会话、上下文和活动记录。</p>
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
                  <small>{workspace.purgedAt
                    ? `关联记录已于 ${formatWorkspaceLifecycleTime(workspace.purgedAt)} 永久清理；恢复后将作为空工作区使用。`
                    : `关联记录将在 ${formatWorkspaceLifecycleTime(workspace.purgeAfter ?? workspace.archivedAt!)} 永久清理。`}</small>
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

      <section className="settings-section" aria-labelledby={`${moduleId}-desktop-settings`}>
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
      </section>
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

function errorMessage(error: unknown, fallback = '保存 Agent 设置失败。'): string {
  if (!(error instanceof Error)) return fallback;
  return error.message
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim() || fallback;
}

function formatWorkspaceLifecycleTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}
