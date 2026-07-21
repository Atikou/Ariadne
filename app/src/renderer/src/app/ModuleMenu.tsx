import { useEffect, useRef, useState } from 'react';
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

  useEffect(() => {
    if (!open) return;
    const closeWhenOutside = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeWhenOutside);
    return () => document.removeEventListener('pointerdown', closeWhenOutside);
  }, [open]);

  return (
    <div className="module-menu" ref={rootRef}>
      <button className="toolbar-button" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <Boxes size={15} /> 模块 <ChevronDown size={13} />
      </button>
      {open && (
        <div className="module-popover" role="menu">
          <div className="popover-heading">功能模块</div>
          {modules.map((module) => {
            const isOpen = openModuleIds.has(module.id);
            return (
              <button
                type="button"
                role="menuitem"
                className="module-option"
                key={module.id}
                onClick={() => {
                  onOpenModule(module.id);
                  setOpen(false);
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
