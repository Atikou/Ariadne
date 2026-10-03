import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { useFeatureSnapshot } from '@renderer/core/runtime/features/feature-snapshot-store';
import type { FeaturePanelProps } from '@renderer/core/modules/module-contract';
import { SelectMenu, type SelectMenuOption } from '@renderer/shared/ui/SelectMenu';
import { PanelEmptyState } from '@renderer/shared/ui/PanelEmptyState';
import './logs.css';
import {
  coalesceTraceLogs,
  traceLogCategory,
  traceLogCategoryLabel,
  traceMatchesLevel,
  traceMatchesView,
  traceMessageForDisplay,
  traceMetadataForDisplay,
  type LogLevelFilter,
  type LogViewFilter
} from '@shared/log-entry-presentation';

const viewOptions: ReadonlyArray<{ value: LogViewFilter; label: string }> = [
  { value: 'important', label: '重要' },
  { value: 'agent', label: 'Agent' },
  { value: 'tool', label: '工具' },
  { value: 'network', label: '网络' },
  { value: 'model', label: '模型' },
  { value: 'security', label: '安全' },
  { value: 'system', label: '系统' }
];

const levelOptions: readonly SelectMenuOption<LogLevelFilter>[] = [
  { value: 'all', label: '全部级别' },
  { value: 'warning', label: '警告及错误' },
  { value: 'error', label: '仅错误' }
];

export function LogsPanel({ moduleId, services }: FeaturePanelProps): React.JSX.Element {
  const diagnostics = useFeatureSnapshot(services.diagnostics.view);
  const [view, setView] = useState<LogViewFilter>('important');
  const [level, setLevel] = useState<LogLevelFilter>('all');
  const rows = useMemo(() => coalesceTraceLogs(
    diagnostics.trace
      .filter((entry) => traceMatchesView(entry, view) && traceMatchesLevel(entry, level))
      .slice(-200)
  ).reverse(), [diagnostics.trace, level, view]);

  return <section className="logs-panel" aria-labelledby={`${moduleId}-title`}>
    <header className="logs-toolbar">
      <h1 id={`${moduleId}-title`}>运行日志</h1>
      <code title={services.applicationProfile.digest}>
        {services.applicationProfile.id}@{services.applicationProfile.revision}
      </code>
      <span className="logs-result-count">{rows.length} 条</span>
      <div className="logs-controls">
      <div className="logs-view-filters" role="toolbar" aria-label="日志类别">
        {viewOptions.map((option) => <button
          type="button"
          key={option.value}
          className={view === option.value ? 'is-active' : ''}
          aria-pressed={view === option.value}
          onClick={() => setView(option.value)}
        >{option.label}</button>)}
      </div>
      <SelectMenu<LogLevelFilter>
        className="logs-level-filter"
        ariaLabel="筛选日志级别"
        value={level}
        options={levelOptions}
        onChange={setLevel}
      />
      </div>
    </header>
    <div className="logs-list">
      {rows.map(({ entry, repeats }) => {
        const message = traceMessageForDisplay(entry);
        const metadata = traceMetadataForDisplay(entry);
        const category = traceLogCategory(entry);
        return <div className={`log-row${entry.level === 'error' ? ' is-error' : entry.level === 'warning' ? ' is-warning' : ''}`} key={entry.traceId}>
          <span>{new Date(entry.occurredAt).toLocaleTimeString()}</span>
          {entry.level === 'error' || entry.level === 'warning' ? <AlertTriangle size={13} /> : entry.level === 'info' ? <Info size={13} /> : <CheckCircle2 size={13} />}
          <code title={entry.category}>{traceLogCategoryLabel(category)}</code>
          <div className="log-copy">
            {message && <p title={message}>{message}</p>}
            {metadata && <details>
              <summary>技术详情</summary>
              <pre>{metadata}</pre>
            </details>}
          </div>
          {repeats > 1 && <span className="log-repeat-count" title={`${repeats} 条相同日志`}>×{repeats}</span>}
        </div>;
      })}
      {rows.length === 0 && <PanelEmptyState compact icon={Info} title="没有匹配的日志" description="当前筛选下没有需要关注的日志，可切换类别或级别。" />}
    </div>
  </section>;
}
