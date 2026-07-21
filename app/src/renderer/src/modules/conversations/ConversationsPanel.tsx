import { useMemo, useState } from 'react';
import { MessageSquarePlus, Pencil, Pin, Search, Trash2 } from 'lucide-react';
import type { FeaturePanelProps } from '@renderer/core/modules/module-contract';
import { ConfirmDialog, TextPromptDialog } from '@renderer/shared/ui/ActionDialog';

interface ConversationItem {
  id: string;
  title: string;
  time: string;
  running: boolean;
  pinned: boolean;
}

interface ConversationGroupData {
  label: string;
  items: ConversationItem[];
}

const initialGroups: ConversationGroupData[] = [
  { label: '今天', items: [
    { id: 'architecture', title: '完善桌面端模块化架构', time: '16:13', running: true, pinned: true },
    { id: 'startup', title: '分析项目启动异常', time: '14:42', running: false, pinned: false }
  ] },
  { label: '昨天', items: [
    { id: 'permissions', title: '整理 Agent 权限边界', time: '昨天', running: false, pinned: false },
    { id: 'game-detection', title: '设计游戏状态检测接口', time: '昨天', running: false, pinned: false }
  ] },
  { label: '更早', items: [
    { id: 'desktop-stack', title: '桌面端技术选型', time: '7月15日', running: false, pinned: false }
  ] }
];

export function ConversationsPanel({ moduleId }: FeaturePanelProps): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('architecture');
  const [groups, setGroups] = useState<ConversationGroupData[]>(initialGroups);
  const [renameTarget, setRenameTarget] = useState<ConversationItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ConversationItem | null>(null);
  const normalized = query.trim().toLocaleLowerCase();
  const filtered = useMemo(() => groups.map((group) => ({
    ...group,
    items: group.items.filter((item) => item.title.toLocaleLowerCase().includes(normalized))
  })).filter((group) => group.items.length > 0), [groups, normalized]);

  const updateItem = (id: string, update: (item: ConversationItem) => ConversationItem): void => {
    setGroups((current) => current.map((group) => ({
      ...group,
      items: group.items.map((item) => item.id === id ? update(item) : item)
    })));
  };

  const removeItem = (id: string): void => {
    setGroups((current) => current.map((group) => ({ ...group, items: group.items.filter((item) => item.id !== id) })));
    if (selected === id) setSelected('');
  };

  return (
    <section className="conversations-panel" aria-labelledby={`${moduleId}-title`}>
      <div className="conversations-actions">
        <button type="button" className="new-conversation" onClick={() => {
          const id = crypto.randomUUID();
          const item = { id, title: '未命名会话', time: '刚刚', running: false, pinned: false };
          setGroups((current) => [{ label: '今天', items: [item, ...(current[0]?.items ?? [])] }, ...current.slice(1)]);
          setSelected(id);
        }}><MessageSquarePlus size={15} /> 新建会话</button>
        <label className="conversation-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索会话" /></label>
      </div>
      <div className="conversation-groups">
        {filtered.map((group) => (
          <section className="conversation-group" key={group.label}>
            <h2>{group.label}</h2>
            {group.items.map((item) => (
              <div className={`conversation-row${selected === item.id ? ' is-active' : ''}`} key={item.id}>
                <button type="button" className="conversation-row-main" onClick={() => setSelected(item.id)}>
                  <span className="conversation-title">{item.running && <i className="running-dot" />}{item.title}</span>
                  <span className="conversation-meta">{item.pinned && <span className="conversation-pin-badge"><Pin size={11} />置顶</span>}<span>{item.time}</span></span>
                </button>
                <div className="conversation-row-actions">
                  <button type="button" className={item.pinned ? 'is-pinned' : ''} aria-pressed={item.pinned} title={item.pinned ? '取消置顶' : '置顶'} onClick={() => updateItem(item.id, (value) => ({ ...value, pinned: !value.pinned }))}><Pin size={11} /></button>
                  <button type="button" title="重命名" onClick={() => setRenameTarget(item)}><Pencil size={11} /></button>
                  <button type="button" title="删除" onClick={() => setDeleteTarget(item)}><Trash2 size={11} /></button>
                </div>
              </div>
            ))}
          </section>
        ))}
      </div>
      <TextPromptDialog
        open={renameTarget !== null}
        title="重命名会话"
        description="输入一个便于之后查找的会话名称。"
        initialValue={renameTarget?.title ?? ''}
        confirmLabel="保存名称"
        onClose={() => setRenameTarget(null)}
        onConfirm={(title) => {
          if (renameTarget) updateItem(renameTarget.id, (value) => ({ ...value, title }));
          setRenameTarget(null);
        }}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除这个会话？"
        description={deleteTarget ? `“${deleteTarget.title}”将从当前 Mock 会话列表中移除。` : ''}
        confirmLabel="删除会话"
        danger
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) removeItem(deleteTarget.id);
          setDeleteTarget(null);
        }}
      />
    </section>
  );
}
