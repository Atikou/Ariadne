import type { ReactNode } from 'react';

interface StatusPillProps {
  children: ReactNode;
  tone?: 'danger' | 'neutral' | 'running' | 'success' | 'warning';
}

export function StatusPill({ children, tone = 'neutral' }: StatusPillProps): React.JSX.Element {
  return <span className={`status-pill status-pill--${tone}`}>{children}</span>;
}
