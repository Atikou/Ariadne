import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Ellipsis, Maximize2, X } from 'lucide-react';
import type { IDockviewPanelHeaderProps } from 'dockview-react';
import type { ModuleIcon } from '@renderer/core/modules/module-contract';
import { ModuleGlyph } from '@renderer/shared/ui/ModuleGlyph';
import { activateEdgeTab } from '@shared/edge-tab-policy';

interface ModuleTabParameters {
  moduleId: string;
  icon: ModuleIcon;
  [key: string]: unknown;
}

interface MenuPosition {
  top: number;
  left: number;
}

export function ModuleTab({ api, containerApi, params }: IDockviewPanelHeaderProps<ModuleTabParameters>): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const title = api.title ?? params.moduleId;

  const closeMenu = useCallback((restoreFocus = false): void => {
    setMenuOpen(false);
    setMenuPosition(null);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const isInsideMenu = (target: EventTarget | null): boolean => target instanceof Node && (
      Boolean(rootRef.current?.contains(target)) || Boolean(menuRef.current?.contains(target))
    );
    const closeWhenOutside = (event: PointerEvent | FocusEvent): void => {
      if (!isInsideMenu(event.target)) closeMenu();
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu(true);
      }
    };
    const closeOnViewportChange = (): void => closeMenu();

    document.addEventListener('pointerdown', closeWhenOutside, true);
    document.addEventListener('focusin', closeWhenOutside, true);
    document.addEventListener('keydown', closeOnEscape);
    document.addEventListener('scroll', closeOnViewportChange, true);
    window.addEventListener('resize', closeOnViewportChange);
    window.addEventListener('blur', closeOnViewportChange);
    return () => {
      document.removeEventListener('pointerdown', closeWhenOutside, true);
      document.removeEventListener('focusin', closeWhenOutside, true);
      document.removeEventListener('keydown', closeOnEscape);
      document.removeEventListener('scroll', closeOnViewportChange, true);
      window.removeEventListener('resize', closeOnViewportChange);
      window.removeEventListener('blur', closeOnViewportChange);
    };
  }, [closeMenu, menuOpen]);

  useLayoutEffect(() => {
    if (!menuOpen) return;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;

    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const group = rootRef.current?.closest('.dv-groupview');
    const gap = 6;
    const viewportPadding = 8;
    let top = triggerRect.bottom + gap;
    let left = triggerRect.right - menuRect.width;

    if (group?.classList.contains('dv-groupview-header-bottom')) {
      top = triggerRect.top - menuRect.height - gap;
    } else if (group?.classList.contains('dv-groupview-header-left')) {
      top = triggerRect.top;
      left = triggerRect.right + gap;
    } else if (group?.classList.contains('dv-groupview-header-right')) {
      top = triggerRect.top;
      left = triggerRect.left - menuRect.width - gap;
    }

    setMenuPosition({
      top: Math.round(Math.min(Math.max(top, viewportPadding), window.innerHeight - menuRect.height - viewportPadding)),
      left: Math.round(Math.min(Math.max(left, viewportPadding), window.innerWidth - menuRect.width - viewportPadding))
    });
  }, [menuOpen]);

  const maximize = (): void => {
    const group = containerApi.getPanel(api.id)?.group;
    if (!group) return;
    if (group.api.isMaximized()) group.api.exitMaximized();
    else group.api.maximize();
  };

  return <div
    className="module-tab"
    ref={rootRef}
    onClickCapture={(event) => {
      const target = event.target;
      const isTabAction = target instanceof Element && Boolean(target.closest('.module-tab-actions'));
      const handled = activateEdgeTab({
        isEdgeGroup: api.location.type === 'edge',
        isTabAction,
        setActive: () => api.setActive(),
        expand: () => api.group.api.expand()
      });
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    }}
  >
    <ModuleGlyph icon={params.icon} size={13} />
    <span>{title}</span>
    <div className="module-tab-actions">
      <button
        ref={triggerRef}
        type="button"
        aria-label={`${title} 更多操作`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? menuId : undefined}
        onClick={(event) => {
          event.stopPropagation();
          if (menuOpen) closeMenu();
          else {
            setMenuPosition(null);
            setMenuOpen(true);
          }
        }}
      ><Ellipsis size={13} /></button>
      <button type="button" aria-label={`关闭 ${title}`} onClick={(event) => { event.stopPropagation(); api.close(); }}><X size={13} /></button>
    </div>
    {menuOpen && createPortal(
      <div
        ref={menuRef}
        id={menuId}
        className="module-tab-menu"
        role="menu"
        aria-label={`${title} 操作`}
        style={{
          top: menuPosition?.top ?? 0,
          left: menuPosition?.left ?? 0,
          visibility: menuPosition ? 'visible' : 'hidden'
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" role="menuitem" onClick={() => { closeMenu(); maximize(); }}><Maximize2 size={13} /> 最大化 / 恢复</button>
        <button type="button" role="menuitem" onClick={() => { closeMenu(); api.close(); }}><X size={13} /> 关闭模块</button>
      </div>,
      document.body
    )}
  </div>;
}
