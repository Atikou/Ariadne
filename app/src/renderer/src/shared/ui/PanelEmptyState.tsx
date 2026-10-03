import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import './panel-empty-state.css';

export function PanelEmptyState({ icon: Icon, title, description, action, compact = false }: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
  compact?: boolean;
}): React.JSX.Element {
  return <div className={`panel-empty-state${compact ? ' panel-empty-state--compact' : ''}`}>
    <Icon size={24} aria-hidden="true" />
    <div><strong>{title}</strong><p>{description}</p></div>
    {action}
  </div>;
}
