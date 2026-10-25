import { useLayoutEffect, type RefObject } from 'react';
import type { DockviewPanelApi } from 'dockview-react';

// The app's whole-tab slots resize independently of panel activation. Keep
// the active slot in its local strip when resizing or changing header position.
export function useActiveTabLayout(rootRef: RefObject<HTMLDivElement | null>, api: DockviewPanelApi, location: DockviewPanelApi['location']['type']): void {
  useLayoutEffect(() => {
    const root = rootRef.current;
    const view = root?.ownerDocument.defaultView;
    if (!root || !view) return;
    let frame: { view: Window; id: number } | null = null;
    const cancelFrame = (): void => {
      if (frame) frame.view.cancelAnimationFrame(frame.id);
      frame = null;
    };
    const schedule = (): void => {
      cancelFrame();
      // Dockview moves these DOM nodes between documents. Layout belongs to
      // the current owner window, including when the main window is hidden.
      const owner = root.ownerDocument.defaultView;
      if (!owner) return;
      frame = { view: owner, id: owner.requestAnimationFrame(() => {
        frame = null;
        if (!api.isActive || !root.isConnected) return;
        const tab = root.closest<HTMLElement>('[role="tab"]');
        const strip = tab?.parentElement;
        if (!tab || strip?.getAttribute('aria-orientation') !== 'horizontal') return;
        const bounds = strip.getBoundingClientRect();
        const slot = tab.getBoundingClientRect();
        if (bounds.width <= 0 || slot.width <= 0) return;
        const delta = slot.left < bounds.left - 1 ? slot.left - bounds.left
          : slot.right > bounds.right + 1 ? slot.right - bounds.right : 0;
        if (delta) strip.scrollLeft += delta;
      }) };
    };
    const observer = new view.ResizeObserver(schedule);
    const observeLayout = (): void => {
      observer.disconnect();
      observer.observe(root);
      const strip = root.closest('[role="tab"]')?.parentElement;
      if (strip) observer.observe(strip);
      schedule();
    };
    const active = api.onDidActiveChange(schedule);
    const group = api.onDidGroupChange(observeLayout);
    observeLayout();
    return () => { active.dispose(); group.dispose(); observer.disconnect(); cancelFrame(); };
  }, [api, location, rootRef]);
}
