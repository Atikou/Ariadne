import { useEffect, useMemo, useRef, useState } from 'react';
import { CornerDownLeft, Search } from 'lucide-react';
import type { ModuleRegistry } from '@renderer/core/modules/module-registry';
import type { ModuleId } from '@renderer/core/modules/module-contract';
import type {
  HumanSkillCommand,
  LoadedHumanSkill,
  RuntimeStore
} from '@renderer/core/runtime/runtime-store';
import { ModuleGlyph } from '@renderer/shared/ui/ModuleGlyph';

interface CommandPaletteProps {
  open: boolean;
  registry: ModuleRegistry;
  onClose(): void;
  onOpenModule(id: ModuleId): void;
  runtime: RuntimeStore;
  workspaceId: string;
}

export function CommandPalette({ open, registry, onClose, onOpenModule, runtime, workspaceId }: CommandPaletteProps): React.JSX.Element | null {
  const [query, setQuery] = useState('');
  const [skills, setSkills] = useState<readonly HumanSkillCommand[]>([]);
  const [loadedSkill, setLoadedSkill] = useState<LoadedHumanSkill | null>(null);
  const [skillError, setSkillError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setLoadedSkill(null);
    setSkillError(null);
    setTimeout(() => input.current?.focus(), 0);
    let current = true;
    void runtime.queryHumanSkillCommands(workspaceId).then(
      (commands) => { if (current) setSkills(commands); },
      () => { if (current) { setSkills([]); setSkillError('技能命令目录暂不可用'); } }
    );
    return () => { current = false; };
  }, [open, runtime, workspaceId]);
  const modules = useMemo(() => registry.list().filter((module) => `${module.name} ${module.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [query, registry]);
  const visibleSkills = useMemo(() => skills.filter((skill) => `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [query, skills]);
  if (!open) return null;
  return <div className="command-backdrop" onMouseDown={onClose}><section className="command-palette" role="dialog" aria-label="命令入口" onMouseDown={(event) => event.stopPropagation()}><label><Search size={17} /><input ref={input} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模块或技能命令" onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }} /></label><div className="command-results"><span>打开模块</span>{modules.map((module) => <button type="button" key={module.id} onClick={() => { onOpenModule(module.id); onClose(); }}><ModuleGlyph icon={module.icon} size={15} /><div><strong>{module.name}</strong><small>{module.description}</small></div><CornerDownLeft size={13} /></button>)}<span>技能命令（不启动 Agent）</span>{visibleSkills.map((skill) => <button type="button" key={`${skill.name}:${skill.revision}`} onClick={() => { setSkillError(null); void runtime.loadHumanSkillCommand(workspaceId, skill.name, skill.revision).then(setLoadedSkill, () => setSkillError('技能命令加载失败')); }}><div><strong>/{skill.name}</strong><small>{skill.description}</small></div><CornerDownLeft size={13} /></button>)}{skillError ? <small role="status">{skillError}</small> : null}{loadedSkill ? <article className="command-skill-preview"><strong>/{loadedSkill.name}</strong><pre>{loadedSkill.body}</pre>{loadedSkill.resources.length > 0 ? <small>{loadedSkill.resources.length} 个可读取资源</small> : null}</article> : null}</div></section></div>;
}
