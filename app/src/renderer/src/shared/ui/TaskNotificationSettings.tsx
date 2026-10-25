import './TaskNotificationSettings.css';
export function TaskNotificationSettings({ value, disabled, onChange }: {
  value: { completed: boolean; failed: boolean }; disabled: boolean;
  onChange: (state: 'completed' | 'failed', enabled: boolean) => void;
}): React.JSX.Element {
  return <fieldset disabled={disabled} className="task-notification-settings">
    <legend>任务系统提醒</legend>
    <p>开启后提醒新完成或失败的 Agent 运行，不补发开启前的历史。仅后台显示，遵循游戏抑制设置。</p>
    {(['completed', 'failed'] as const).map(state => <div className="setting-block" key={state}>
      <div><strong>{state === 'completed' ? '任务完成提醒' : '任务失败提醒'}</strong></div>
      <label className="switch"><input type="checkbox" aria-label={state === 'completed' ? '任务完成提醒' : '任务失败提醒'}
        checked={value[state]} onChange={event => onChange(state, event.target.checked)} /><span /></label>
    </div>)}
  </fieldset>;
}
