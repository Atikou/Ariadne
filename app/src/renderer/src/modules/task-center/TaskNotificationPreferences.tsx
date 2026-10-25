import { useEffect, useState } from 'react';
import type { AriadneApi, UserPreferences } from '@shared/contract';
import { TaskNotificationSettings } from '@renderer/shared/ui/TaskNotificationSettings';

export function TaskNotificationPreferences({ preferences }: { preferences: AriadneApi['preferences'] }): React.JSX.Element {
  const [value, setValue] = useState<UserPreferences | null>(null), [saving, setSaving] = useState(false), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void preferences.load().then(result => { if (active) setValue(result); })
      .catch(() => { if (active) setError('读取提醒设置失败，请收起后重试。'); });
    return () => { active = false; };
  }, [preferences]);
  const change = async (state: 'completed' | 'failed', enabled: boolean) => {
    if (saving) return;
    setSaving(true); setError(null);
    try {
      const current = await preferences.load();
      const saved = await preferences.update({ ...current, taskNotifications: {
        ...(current.taskNotifications ?? { completed: false, failed: false }), [state]: enabled } });
      setValue(saved);
    } catch { setError('保存提醒设置失败，原设置已保留。'); }
    finally { setSaving(false); }
  };
  return <div>{error && <p role="alert">{error}</p>}<TaskNotificationSettings
    value={value?.taskNotifications ?? { completed: false, failed: false }} disabled={value === null || saving}
    onChange={(state, enabled) => { void change(state, enabled); }} /></div>;
}
