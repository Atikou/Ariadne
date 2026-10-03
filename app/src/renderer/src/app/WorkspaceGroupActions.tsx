import { useEffect, useReducer } from 'react';
import type { IDockviewHeaderActionsProps } from 'dockview-react';
import { SelectMenu } from '@renderer/shared/ui/SelectMenu';
import './workspace-group-actions.css';

export function WorkspaceGroupActions({ panels, activePanel, group, headerPosition, location }: IDockviewHeaderActionsProps): React.JSX.Element | null {
  const [, refreshTitles] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    const subscriptions = panels.map(panel => panel.api.onDidTitleChange(refreshTitles));
    return () => subscriptions.forEach(subscription => subscription.dispose());
  }, [panels]);
  if (panels.length < 2) return null;

  return <SelectMenu
    key={location?.type}
    className="workspace-group-tabs"
    popoverClassName="workspace-group-tab-list"
    value={activePanel?.id ?? ''}
    triggerLabel={String(panels.length)}
    ariaLabel={`当前分组全部标签（${panels.length}）`}
    options={panels.map(panel => ({ value: panel.id, label: panel.title ?? panel.id }))}
    placement={headerPosition === 'bottom' ? 'top' : 'bottom'}
    onChange={id => {
      const panel = panels.find(candidate => candidate.id === id);
      if (!panel) return;
      group.api.expand();
      panel.api.setActive();
    }}
  />;
}
