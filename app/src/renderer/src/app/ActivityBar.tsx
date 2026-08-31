import type { ModuleId } from '@renderer/core/modules/module-contract';
import type { ModuleNavigationAction } from '@renderer/core/modules/module-registry';
import { ModuleGlyph } from '@renderer/shared/ui/ModuleGlyph';

interface ActivityBarProps {
  actions: readonly ModuleNavigationAction[];
  openModuleIds: ReadonlySet<string>;
  onOpen(ids: readonly ModuleId[]): void;
}

export function ActivityBar({ actions, openModuleIds, onOpen }: ActivityBarProps): React.JSX.Element {
  const renderAction = (action: ModuleNavigationAction): React.JSX.Element => (
    <button
      key={action.id}
      type="button"
      className={action.moduleIds.some((id) => openModuleIds.has(id)) ? 'is-active' : ''}
      data-tooltip={action.label}
      aria-label={action.label}
      onClick={() => onOpen(action.moduleIds)}
    >
      <ModuleGlyph icon={action.icon} size={18} />
    </button>
  );
  return (
    <nav className="activity-bar" aria-label="桌面功能栏">
      <div>{actions.filter((action) => action.position === 'primary').map(renderAction)}</div>
      <div>{actions.filter((action) => action.position === 'footer').map(renderAction)}</div>
    </nav>
  );
}
