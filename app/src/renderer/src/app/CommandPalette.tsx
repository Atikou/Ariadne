import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { CornerDownLeft, Search, TerminalSquare } from 'lucide-react';
import type { ModuleRegistry } from '@renderer/core/modules/module-registry';
import type { ModuleId } from '@renderer/core/modules/module-contract';
import type { HumanSkillCommand, LoadedHumanSkill, HumanSkillFeatureStore } from '@renderer/core/runtime/features/human-skill-feature-store';
import { ModuleGlyph } from '@renderer/shared/ui/ModuleGlyph';
import { getNearestScrollDelta } from '@shared/scroll-geometry';
import { useModalDialog } from '@renderer/shared/ui/ModalSurface';

interface CommandPaletteProps {
  open: boolean;
  registry: ModuleRegistry;
  onClose(): void;
  onOpenModule(id: ModuleId): void;
  humanSkills: HumanSkillFeatureStore;
  workspaceId: string;
}

export function CommandPalette({ open, registry, onClose, onOpenModule, humanSkills, workspaceId }: CommandPaletteProps): React.JSX.Element | null {
  const [query, setQuery] = useState('');
  const [skills, setSkills] = useState<readonly HumanSkillCommand[]>([]);
  const [loadedSkill, setLoadedSkill] = useState<LoadedHumanSkill | null>(null);
  const [skillError, setSkillError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingSkill, setLoadingSkill] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const requestGeneration = useRef(0);
  const listId = useId();

  useModalDialog(dialogRef, open, inputRef);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelectedKey(null);
    setSkills([]);
    setLoadedSkill(null);
    setSkillError(null);
    setLoading(true);
    setLoadingSkill(false);
    let current = true;
    void humanSkills.queryCommands(workspaceId).then(
      commands => { if (current) setSkills(commands); },
      () => { if (current) setSkillError('技能命令目录暂不可用，仍可打开模块。'); }
    ).finally(() => { if (current) setLoading(false); });
    return () => { current = false; requestGeneration.current += 1; };
  }, [humanSkills, open, workspaceId]);

  const entries = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return [
      ...registry.list()
        .filter(module => `${module.name} ${module.description}`.toLocaleLowerCase().includes(search))
        .map(module => ({ kind: 'module' as const, key: `module:${module.id}`, module })),
      ...skills
        .filter(skill => `/${skill.name} ${skill.description}`.toLocaleLowerCase().includes(search))
        .map(skill => ({ kind: 'skill' as const, key: `skill:${skill.name}:${skill.revision}`, skill }))
    ];
  }, [query, registry, skills]);
  const selectedIndex = Math.max(0, entries.findIndex(entry => entry.key === selectedKey));

  useEffect(() => {
    const viewport = resultsRef.current;
    const item = viewport?.querySelector(`[data-command-index="${selectedIndex}"]`);
    if (!viewport || !item) return;
    const bounds = viewport.getBoundingClientRect();
    const itemBounds = item.getBoundingClientRect();
    viewport.scrollTop += getNearestScrollDelta(bounds.top, bounds.bottom, itemBounds.top, itemBounds.bottom, 6);
  }, [selectedIndex, query]);

  const activate = (index: number): void => {
    const entry = entries[index];
    if (!entry) return;
    if (entry.kind === 'module') {
      onClose();
      onOpenModule(entry.module.id);
      return;
    }
    const generation = ++requestGeneration.current;
    setLoadedSkill(null);
    setSkillError(null);
    setLoadingSkill(true);
    void humanSkills.loadCommand(workspaceId, entry.skill.name, entry.skill.revision).then(
      skill => { if (generation === requestGeneration.current) setLoadedSkill(skill); },
      () => { if (generation === requestGeneration.current) setSkillError('技能命令加载失败，请重试。'); }
    ).finally(() => { if (generation === requestGeneration.current) setLoadingSkill(false); });
  };

  const navigate = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      activate(selectedIndex);
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && entries.length > 0) {
      event.preventDefault();
      const next = (selectedIndex + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length;
      setSelectedKey(entries[next]!.key);
    }
  };

  if (!open) return null;
  return createPortal(
    <dialog
      ref={dialogRef}
      className="command-palette"
      aria-label="搜索模块与技能"
      onCancel={event => { event.preventDefault(); onClose(); }}
      onClick={event => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
      }}
    >
      <label>
        <Search size={17} />
        <input
          ref={inputRef}
          value={query}
          role="combobox"
          aria-label="搜索模块或技能命令"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={entries.length ? `${listId}-${selectedIndex}` : undefined}
          onChange={event => {
            setQuery(event.target.value);
            setSelectedKey(null);
            setLoadedSkill(null);
            setLoadingSkill(false);
            requestGeneration.current += 1;
          }}
          placeholder="搜索模块或技能命令…"
          onKeyDown={navigate}
        />
        <button type="button" className="command-dismiss" onClick={onClose} aria-label="关闭搜索">Esc</button>
      </label>
      <div ref={resultsRef} className="command-results" id={listId} role="listbox" aria-label="搜索结果">
        {entries.map((entry, index) => <button
          type="button"
          role="option"
          tabIndex={-1}
          id={`${listId}-${index}`}
          key={entry.key}
          data-command-index={index}
          aria-selected={selectedIndex === index}
          onMouseDown={event => event.preventDefault()}
          onClick={() => activate(index)}
        >
          {entry.kind === 'module' ? <ModuleGlyph icon={entry.module.icon} size={16} /> : <TerminalSquare size={16} />}
          <div>
            <strong>{entry.kind === 'module' ? entry.module.name : `/${entry.skill.name}`}</strong>
            <small>{entry.kind === 'module' ? entry.module.description : entry.skill.description}</small>
          </div>
          <CornerDownLeft size={13} />
        </button>)}
      </div>
      {!entries.length && <p className="command-empty" role="status">{loading ? '正在读取技能目录…' : '没有匹配结果，试试其他关键词。'}</p>}
      {loadingSkill && <p className="command-empty" role="status">正在读取技能…</p>}
      {skillError && <p className="command-empty is-warning" role="status">{skillError}</p>}
      {loadedSkill && <article className="command-skill-preview" tabIndex={0} aria-label="技能预览">
        <strong>/{loadedSkill.name}</strong><pre>{loadedSkill.body}</pre>
        {loadedSkill.resources.length > 0 && <small>{loadedSkill.resources.length} 个可读取资源</small>}
      </article>}
      <footer className="command-footer"><span>↑ ↓ 选择 · Enter 打开 · Esc 关闭</span><span>技能只读预览，不启动 Agent</span></footer>
    </dialog>,
    document.body
  );
}
