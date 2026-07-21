import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import type { FeaturePanelProps } from '@renderer/core/modules/module-contract';

export function LogsPanel({ moduleId }: FeaturePanelProps): React.JSX.Element {
  return <section className="logs-panel" aria-labelledby={`${moduleId}-title`}><div className="log-row"><span>16:32:19.471</span><Info size={13} /><code>renderer</code><p>Dockview layout restored</p></div><div className="log-row"><span>16:32:19.473</span><CheckCircle2 size={13} /><code>modules</code><p>10 built-in modules registered</p></div><div className="log-row is-warning"><span>16:32:20.104</span><AlertTriangle size={13} /><code>system</code><p>Game activity detector unavailable in phase one</p></div></section>;
}
