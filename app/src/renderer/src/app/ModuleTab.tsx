import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Ellipsis, ExternalLink, Maximize2, X } from 'lucide-react';
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
  const [menuDocument, setMenuDocument] = useState<Document>(() => document);
  const [locationType, setLocationType] = useState(api.location.type);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const title = api.title ?? params.moduleId;

  useEffect(() => api.onDidLocationChange((event) => {
    setLocationType(event.location.type);
    setMenuDocument(rootRef.current?.ownerDocument ?? document);
  }).dispose, [api]);

  const popout = useCallback((): void => {
    const panel = containerApi.getPanel(api.id);
    if (!panel || panel.api.location.type === 'popout') return;
    void containerApi.addPopoutGroup(panel).catch((error: unknown) => {
      console.error('Unable to open module in a separate window', error);
    });
  }, [api.id, containerApi]);

  const closeMenu = useCallback((restoreFocus = false): void => {
    setMenuOpen(false);
    setMenuPosition(null);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const menuWindow = menuDocument.defaultView;
    const OwnerNode = menuWindow?.Node;
    const isInsideMenu = (target: EventTarget | null): boolean => {
      if (!OwnerNode || !(target instanceof OwnerNode)) return false;
      return Boolean(rootRef.current?.contains(target)) || Boolean(menuRef.current?.contains(target));
    };
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

    menuDocument.addEventListener('pointerdown', closeWhenOutside, true);
    menuDocument.addEventListener('focusin', closeWhenOutside, true);
    menuDocument.addEventListener('keydown', closeOnEscape);
    menuDocument.addEventListener('scroll', closeOnViewportChange, true);
    menuWindow?.addEventListener('resize', closeOnViewportChange);
    menuWindow?.addEventListener('blur', closeOnViewportChange);
    return () => {
      menuDocument.removeEventListener('pointerdown', closeWhenOutside, true);
      menuDocument.removeEventListener('focusin', closeWhenOutside, true);
      menuDocument.removeEventListener('keydown', closeOnEscape);
      menuDocument.removeEventListener('scroll', closeOnViewportChange, true);
      menuWindow?.removeEventListener('resize', closeOnViewportChange);
      menuWindow?.removeEventListener('blur', closeOnViewportChange);
    };
  }, [closeMenu, menuDocument, menuOpen]);

  useLayoutEffect(() => {
    if (!menuOpen) return;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;

    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const group = rootRef.current?.closest('.dv-groupview');
    const menuWindow = menuDocument.defaultView;
    const viewportWidth = menuWindow?.innerWidth ?? window.innerWidth;
    const viewportHeight = menuWindow?.innerHeight ?? window.innerHeight;
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
      top: Math.round(Math.min(Math.max(top, viewportPadding), viewportHeight - menuRect.height - viewportPadding)),
      left: Math.round(Math.min(Math.max(left, viewportPadding), viewportWidth - menuRect.width - viewportPadding))
    });
  }, [menuDocument, menuOpen]);

  const maximize = (): void => {
    const group = containerApi.getPanel(api.id)?.group;
    if (!group) return;
    if (group.api.isMaximized()) group.api.exitMaximized();
    else group.api.maximize();
  };

  return <div
    className="module-tab"
    data-module-id={api.id}
    ref={rootRef}
    onClickCapture={(event) => {
      const target = event.target;
      const isTabAction = target instanceof Element && Boolean(target.closest('.module-tab-actions'));
      const handled = activateEdgeTab({
        isEdgeGroup: locationType === 'edge',
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
            setMenuDocument(rootRef.current?.ownerDocument ?? document);
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
        {locationType !== 'popout' && (
          <button
            type="button"
            role="menuitem"
            data-module-action="popout"
            onClick={() => { closeMenu(); popout(); }}
          ><ExternalLink size={13} /> 在独立窗口中打开</button>
        )}
        <button type="button" role="menuitem" onClick={() => { closeMenu(); maximize(); }}><Maximize2 size={13} /> 最大化 / 恢复</button>
        <button type="button" role="menuitem" onClick={() => { closeMenu(); api.close(); }}><X size={13} /> 关闭模块</button>
      </div>,
      menuDocument.body
    )}
  </div>;
}
