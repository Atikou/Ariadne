import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { useRuntimeSnapshot } from '@renderer/core/runtime/runtime-store';
import type { FeaturePanelProps } from '@renderer/core/modules/module-contract';
import {
  traceMessageForDisplay,
  traceMetadataForDisplay
} from '@shared/log-entry-presentation';

export function LogsPanel({ moduleId, services }: FeaturePanelProps): React.JSX.Element {
  const runtime = useRuntimeSnapshot(services.runtime);
  return <section className="logs-panel" aria-labelledby={`${moduleId}-title`}>
    {runtime.trace.slice(-200).reverse().map((entry) => {
      const message = traceMessageForDisplay(entry);
      const metadata = traceMetadataForDisplay(entry);
      return <div className={`log-row${entry.level === 'error' ? ' is-error' : entry.level === 'warning' ? ' is-warning' : ''}`} key={entry.traceId}>
        <span>{new Date(entry.occurredAt).toLocaleTimeString()}</span>
        {entry.level === 'error' || entry.level === 'warning' ? <AlertTriangle size={13} /> : entry.level === 'info' ? <Info size={13} /> : <CheckCircle2 size={13} />}
        <code title={entry.category}>{entry.category}</code>
        <div className="log-copy">
          {message && <p title={message}>{message}</p>}
          {metadata && <details>
            <summary>结构化详情</summary>
            <pre>{metadata}</pre>
          </details>}
        </div>
      </div>;
    })}
    {runtime.trace.length === 0 && <div className="log-row"><span>—</span><Info size={13} /><code>Runtime</code><p>暂无追踪记录。</p></div>}
  </section>;
}
