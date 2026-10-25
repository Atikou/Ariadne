import { ChevronRight, Plus, X } from 'lucide-react';
import type { ModelSummary } from '@ariadne/protocol/public';
import { AGENT_PROVIDER_CATALOG, type AgentProviderSettingsView, type AgentProviderSettingsPatch } from '@shared/contract';
import { SelectMenu } from '@renderer/shared/ui/SelectMenu';

type Provider = AgentProviderSettingsView;
export function RemoteProviderSettings(props: {
  moduleId: string;
  providers: Record<string, Provider>;
  keys: Record<string, string>;
  clearRequests: Record<string, boolean>;
  expanded: Record<string, boolean>;
  health: ReadonlyMap<string, ModelSummary>;
  checking: ReadonlySet<string>;
  busy: boolean;
  result: string | null;
  onAdd(): void;
  onRemove(id: string): void;
  onExpand(id: string): void;
  onChange(id: string, patch: AgentProviderSettingsPatch): void;
  onKey(id: string, value: string): void;
  onClearKey(id: string): void;
  onCheck(id: string): void;
  onCheckAll(): void;
}) {
  return <div className="provider-settings-list">
    <div className="provider-list-heading">
      <div className="settings-section-copy"><h3>远程模型连接</h3>
        <p>每条连接独立配置一个地址、密钥和模型。修改后先保存，再检测连接；检测失败的连接会关闭。</p></div>
      <button type="button" className="secondary-button" disabled={props.busy} onClick={props.onCheckAll}>检测全部已启用</button>
    </div>
    {props.result && <div className="provider-check-result" role="status" aria-live="polite">{props.result}</div>}
    {Object.entries(props.providers).map(([id, provider]) => {
      const expanded = props.expanded[id] === true;
      const health = props.health.get(provider.modelId);
      const keyStatus = props.clearRequests[id] ? '保存后清除' : props.keys[id] ? '待保存'
        : provider.apiKeyStatus === 'configured' ? '已安全保存' : provider.apiKeyStatus === 'unavailable' ? '密文不可用' : '未配置';
      const label = provider.label || '未命名连接';
      return <fieldset className={`provider-settings-card${expanded ? ' is-expanded' : ' is-collapsed'}`} key={id} data-provider-id={id} disabled={props.busy}>
        <legend><button type="button" className="provider-disclosure" aria-expanded={expanded}
          aria-controls={`${props.moduleId}-${id}-details`} onClick={() => props.onExpand(id)}>
          <ChevronRight size={14} aria-hidden="true" /><span>{label}</span>
        </button><label className="provider-enable"><input type="checkbox" aria-label={`启用 ${label}`}
          checked={provider.enabled} disabled={props.busy} onChange={event => props.onChange(id, { enabled: event.target.checked })} /><span>启用</span></label></legend>
        <div id={`${props.moduleId}-${id}-details`} className="provider-settings-body" hidden={!expanded}>
          <div className="provider-health"><span className={`provider-health-dot provider-health-dot--${health?.availability ?? 'unavailable'}`} />
            {health?.availability === 'ready' ? '模型可用' : health?.availability === 'checking' ? '检测中' : '尚不可用'} · API Key {keyStatus}
            <button type="button" className="secondary-button provider-check-button" disabled={!provider.enabled || props.busy}
              onClick={() => props.onCheck(id)}>{props.checking.has(provider.modelId) ? '检测中…' : '检查此连接'}</button>
          </div>
          <div className="agent-settings-grid">
            <label className="settings-field"><span>连接名称</span><input aria-label="连接名称" required maxLength={128} value={provider.label}
              onChange={event => props.onChange(id, { label: event.target.value })} placeholder="例如 工作模型、备用线路" /></label>
            <div className="settings-field settings-select-field"><span>接口类型</span><SelectMenu
              ariaLabel={`${label} 接口类型`} value={provider.inferenceDialect} placement="bottom"
              options={[{ value: 'openai', label: 'OpenAI 兼容' }, { value: 'anthropic', label: 'Anthropic Messages' },
                { value: 'deepseek', label: 'DeepSeek 兼容' }, { value: 'kimi', label: 'Kimi 兼容' }]}
              onChange={dialect => {
                const preset = AGENT_PROVIDER_CATALOG[dialect];
                props.onChange(id, { protocol: preset.protocol, inferenceDialect: dialect,
                  inference: structuredClone(preset.defaultInference),
                  ...(provider.baseUrl ? {} : { baseUrl: preset.defaultBaseUrl }),
                  ...(provider.model ? {} : { model: preset.defaultModel }) });
              }} /></div>
            <label className="settings-field settings-field--wide"><span>API 地址</span><input aria-label="API 地址" required type="url" value={provider.baseUrl}
              onChange={event => props.onChange(id, { baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></label>
            <label className="settings-field"><span>模型名称</span><input aria-label="模型名称" required maxLength={256} value={provider.model}
              onChange={event => props.onChange(id, { model: event.target.value })} placeholder="填写服务端模型 ID" /></label>
            <label className="settings-field"><span>支持图片输入</span><input type="checkbox" checked={provider.supportsVision}
              onChange={event => props.onChange(id, { supportsVision: event.target.checked })} />
              <small>仅在接口和模型支持图片时开启；仍需通过能力检测。</small></label>
            <label className="settings-field"><span>上下文窗口（tokens）</span><input type="number" required min={8192} max={10000000} step={1}
              value={provider.contextWindowTokens} onChange={event => props.onChange(id, { contextWindowTokens: Number(event.target.value) })} /></label>
            <label className="settings-field"><span>最大输出（tokens）</span><input type="number" required min={256} max={1000000} step={1}
              value={provider.maxOutputTokens} onChange={event => props.onChange(id, { maxOutputTokens: Number(event.target.value) })} /></label>
            <label className="settings-field settings-field--wide"><span>API Key</span><div className="api-key-input">
              <input aria-label="API Key" type="password" autoComplete="off" value={props.keys[id] ?? ''}
                onChange={event => props.onKey(id, event.target.value)} placeholder={provider.apiKeyStatus === 'configured' ? '已安全保存；留空保留原密钥' : '输入 API Key'} />
              <button type="button" disabled={provider.apiKeyStatus === 'missing' && !props.keys[id]} onClick={() => props.onClearKey(id)}>清除</button>
            </div></label>
          </div>
          <button type="button" className="secondary-button" disabled={props.busy} onClick={() => props.onRemove(id)}><X size={12} />删除此连接</button>
        </div>
      </fieldset>;
    })}
    {Object.keys(props.providers).length === 0 && <p className="module-empty-state">尚未添加远程模型连接。</p>}
    <button type="button" className="local-model-root-add" disabled={props.busy || Object.keys(props.providers).length >= 16} onClick={props.onAdd}>
      <Plus size={12} />添加远程连接
    </button>
  </div>;
}
