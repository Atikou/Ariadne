import { useEffect, useState } from 'react';
import { Laptop, Moon, Sun } from 'lucide-react';
import type { ThemePreference, UserPreferences } from '@shared/contract';
import type { FeaturePanelProps } from '@renderer/core/modules/module-contract';

const themeOptions: Array<{ value: ThemePreference; label: string; icon: typeof Sun }> = [
  { value: 'system', label: '跟随系统', icon: Laptop },
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'light', label: '浅色', icon: Sun }
];

export function SettingsPanel({ moduleId, services }: FeaturePanelProps): React.JSX.Element {
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  useEffect(() => { void services.preferences.load().then(setPreferences); }, [services]);
  const save = (next: UserPreferences): void => {
    setPreferences(next);
    void services.preferences.update(next).then((saved) => services.events.emit('preferences:changed', saved));
  };
  return (
    <section className="simple-module-panel settings-panel" aria-labelledby={`${moduleId}-title`}>
      <header className="module-content-header"><div><span>PREFERENCES</span><h1 id={`${moduleId}-title`}>外观与桌面行为</h1></div></header>
      <div className="setting-block"><div><strong>主题</strong><p>默认跟随系统，也可以单独覆盖 Ariadne 外观。</p></div><div className="theme-options">{themeOptions.map(({ value, label, icon: Icon }) => <button type="button" key={value} className={preferences?.theme === value ? 'is-active' : ''} onClick={() => preferences && save({ ...preferences, theme: value })}><Icon size={17} />{label}</button>)}</div></div>
      <div className="setting-block"><div><strong>后台常驻</strong><p>关闭主窗口时保留托盘中的桌面应用。</p></div><label className="switch"><input type="checkbox" checked={preferences?.runInBackground ?? true} onChange={(event) => preferences && save({ ...preferences, runInBackground: event.target.checked })} /><span /></label></div>
      <div className="setting-block"><div><strong>启动时运行</strong><p>登录系统后自动启动桌面壳。</p></div><label className="switch"><input type="checkbox" checked={preferences?.startAtLogin ?? false} onChange={(event) => preferences && save({ ...preferences, startAtLogin: event.target.checked })} /><span /></label></div>
      <div className="setting-block"><div><strong>安全边界</strong><p>Renderer 保持沙箱与上下文隔离，只通过固定 Preload API 使用桌面能力。</p></div></div>
    </section>
  );
}
