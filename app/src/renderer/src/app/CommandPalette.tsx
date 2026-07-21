import { useEffect, useMemo, useRef, useState } from 'react';
import { CornerDownLeft, Search } from 'lucide-react';
import type { ModuleRegistry } from '@renderer/core/modules/module-registry';
import type { ModuleId } from '@renderer/core/modules/module-contract';
import { ModuleGlyph } from '@renderer/shared/ui/ModuleGlyph';

interface CommandPaletteProps {
  open: boolean;
  registry: ModuleRegistry;
  onClose(): void;
  onOpenModule(id: ModuleId): void;
}

export function CommandPalette({ open, registry, onClose, onOpenModule }: CommandPaletteProps): React.JSX.Element | null {
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setQuery(''); setTimeout(() => input.current?.focus(), 0); } }, [open]);
  const modules = useMemo(() => registry.list().filter((module) => `${module.name} ${module.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [query, registry]);
  if (!open) return null;
  return <div className="command-backdrop" onMouseDown={onClose}><section className="command-palette" role="dialog" aria-label="命令入口" onMouseDown={(event) => event.stopPropagation()}><label><Search size={17} /><input ref={input} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模块或输入命令" onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }} /></label><div className="command-results"><span>打开模块</span>{modules.map((module) => <button type="button" key={module.id} onClick={() => { onOpenModule(module.id); onClose(); }}><ModuleGlyph icon={module.icon} size={15} /><div><strong>{module.name}</strong><small>{module.description}</small></div><CornerDownLeft size={13} /></button>)}</div></section></div>;
}
