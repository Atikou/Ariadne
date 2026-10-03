import { useLayoutEffect, type RefObject } from 'react';
import type { DockviewPanelApi } from 'dockview-react';

// The app's whole-tab slots resize independently of panel activation. Keep
// the active slot in its local strip when resizing or changing header position.
export function useActiveTabLayout(rootRef: RefObject<HTMLDivElement | null>, api: DockviewPanelApi, location: DockviewPanelApi['location']['type']): void {
  useLayoutEffect(() => {
    const root = rootRef.current;
    const view = root?.ownerDocument.defaultView;
    if (!root || !view) return;
    let frame = 0;
    const observer = new view.ResizeObserver(() => {
      view.cancelAnimationFrame(frame);
      frame = view.requestAnimationFrame(() => {
        if (!api.isActive || !root.isConnected) return;
        const tab = root.closest<HTMLElement>('[role="tab"]');
        const strip = tab?.parentElement;
        if (!tab || strip?.getAttribute('aria-orientation') !== 'horizontal') return;
        const bounds = strip.getBoundingClientRect();
        const slot = tab.getBoundingClientRect();
        const delta = slot.left < bounds.left - 1 ? slot.left - bounds.left
          : slot.right > bounds.right + 1 ? slot.right - bounds.right : 0;
        if (delta) strip.scrollLeft += delta;
      });
    });
    observer.observe(root);
    return () => { observer.disconnect(); view.cancelAnimationFrame(frame); };
  }, [api, location, rootRef]);
}
