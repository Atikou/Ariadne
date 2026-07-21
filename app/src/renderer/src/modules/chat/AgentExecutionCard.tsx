import { useState } from 'react';
import { Check, ChevronDown, ChevronRight, Circle, LoaderCircle, TriangleAlert, X } from 'lucide-react';

export type ExecutionStatus = 'cancelled' | 'failed' | 'running' | 'success' | 'waiting' | 'warning';

interface AgentExecutionCardProps {
  title: string;
  status: ExecutionStatus;
  duration?: string;
  summary: string;
  details: string;
}

const statusIcons = {
  cancelled: X,
  failed: X,
  running: LoaderCircle,
  success: Check,
  waiting: Circle,
  warning: TriangleAlert
};

export function AgentExecutionCard({ title, status, duration, summary, details }: AgentExecutionCardProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const Icon = statusIcons[status];

  return (
    <section className={`execution-card execution-card--${status}`}>
      <button className="execution-summary" type="button" onClick={() => setExpanded((value) => !value)}>
        <Icon className={status === 'running' ? 'is-spinning' : ''} size={15} />
        <span className="execution-title"><strong>{title}</strong><small>{summary}</small></span>
        {duration && <time>{duration}</time>}
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {expanded && (
        <div className="execution-details">
          <dl><dt>工具</dt><dd>shell_command</dd><dt>权限</dt><dd>工作区只读 / 构建命令</dd></dl>
          <pre>{details}</pre>
          {status === 'failed' && <button type="button" className="secondary-button">重试</button>}
        </div>
      )}
    </section>
  );
}
