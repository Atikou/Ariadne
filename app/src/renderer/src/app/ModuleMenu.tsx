import { useEffect, useId, useRef, useState } from 'react';
import { Boxes, Check, ChevronDown } from 'lucide-react';
import type { FeatureModuleDefinition, ModuleId } from '@renderer/core/modules/module-contract';
import { ModuleGlyph } from '@renderer/shared/ui/ModuleGlyph';

interface ModuleMenuProps {
  modules: readonly FeatureModuleDefinition[];
  openModuleIds: ReadonlySet<string>;
  onOpenModule(id: ModuleId): void;
}

export function ModuleMenu({ modules, openModuleIds, onOpenModule }: ModuleMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const closeWhenOutside = (event: PointerEvent | FocusEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeWhenOutside);
    document.addEventListener('focusin', closeWhenOutside);
    return () => {
      document.removeEventListener('pointerdown', closeWhenOutside);
      document.removeEventListener('focusin', closeWhenOutside);
    };
  }, [open]);

  return (
    <div className="module-menu" ref={rootRef}>
      <button ref={triggerRef} className="toolbar-button" type="button" onClick={() => setOpen((value) => !value)} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          setOpen(true);
        }
      }}>
        <Boxes size={15} /> 模块 <ChevronDown size={13} />
      </button>
      {open && (
        <div ref={menuRef} id={menuId} className="module-popover" role="menu" aria-label="功能模块" onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            triggerRef.current?.focus();
            return;
          }
          const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
          if (!items.length) return;
          const current = items.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
            : event.key === 'ArrowDown' ? (current + 1) % items.length
            : event.key === 'ArrowUp' ? (current - 1 + items.length) % items.length : null;
          if (next !== null) {
            event.preventDefault();
            items[next]?.focus();
          }
        }}>
          <div className="popover-heading">功能模块</div>
          {modules.map((module) => {
            const isOpen = openModuleIds.has(module.id);
            return (
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="module-option"
                key={module.id}
                onClick={() => {
                  setOpen(false);
                  triggerRef.current?.focus();
                  onOpenModule(module.id);
                }}
              >
                <span className="module-option-icon"><ModuleGlyph icon={module.icon} size={16} /></span>
                <span><strong>{module.name}</strong><small>{module.description}</small></span>
                {isOpen && <Check className="module-check" size={15} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
