import { useLayoutEffect, useRef } from 'react';

/** Focus an explicitly opened detail inside its own module scroll container. */
export function usePanelDetailFocus(selected: boolean, identity: string) {
  const element = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const target = element.current;
    if (!selected || !target) return;
    const focus = (): boolean => {
      if (!target.checkVisibility() || target.getBoundingClientRect().height === 0) return false;
      target.focus({ preventScroll: true });
      for (let container = target.parentElement; container; container = container.parentElement) {
        if (container === document.body || container === document.documentElement) break;
        const style = getComputedStyle(container);
        if (container.scrollHeight > container.clientHeight && ['auto', 'scroll'].includes(style.overflowY)) {
          const box = target.getBoundingClientRect(), viewport = container.getBoundingClientRect();
          if (box.top < viewport.top || box.bottom > viewport.bottom) container.scrollTop += box.top - viewport.top;
          break;
        }
      }
      return true;
    };
    if (focus()) return;
    const observer = new ResizeObserver(() => { if (focus()) observer.disconnect(); });
    observer.observe(target);
    return () => observer.disconnect();
  }, [selected, identity]);
  return element;
}
