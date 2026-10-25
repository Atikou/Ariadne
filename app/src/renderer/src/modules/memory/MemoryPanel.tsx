import { useCallback, useEffect, useRef, useState } from 'react';
import type { LongMemoryContent, LongMemoryRecord } from '@ariadne/protocol/public';
import type { FeaturePanelProps } from '@renderer/core/modules/module-contract';
import { useFeatureSnapshot } from '@renderer/core/runtime/features/feature-snapshot-store';
import type { MemoryPage, MemoryRecall, MemoryOwnerScope } from '@renderer/core/runtime/features/long-memory-feature-store';
import { usePanelAction } from '@renderer/shared/ui/usePanelAction';
import { SelectMenu } from '@renderer/shared/ui/SelectMenu';
import { MemoryEditor } from './MemoryEditor';

const states = { candidate: '待审核', active: '已启用', inactive: '已停用' };
const scopes = { global: '全局共享', workspace: '当前工作区', session: '当前会话' };
export function MemoryPanel(props: FeaturePanelProps): React.JSX.Element {
  const sessions = useFeatureSnapshot(props.services.sessions.view);
  const session = sessions.sessions.find(item => item.sessionId === sessions.selectedSessionId);
  if (!session) return <section className="simple-module-panel"><p className="module-empty-state">请先选择一个会话。</p></section>;
  return <ScopedMemoryPanel key={JSON.stringify([session.workspaceId, session.sessionId])} {...props} owner={session} />;
}
function ScopedMemoryPanel({ moduleId, services, owner }: FeaturePanelProps & { owner: MemoryOwnerScope }): React.JSX.Element {
  const [page, setPage] = useState<MemoryPage | null>(null); const [filter, setFilter] = useState<'all' | LongMemoryRecord['status']>('all');
  const [selected, setSelected] = useState<LongMemoryRecord | null>(null); const [editing, setEditing] = useState(false);
  const [editingMemory, setEditingMemory] = useState<LongMemoryRecord | null>(null);
  const [forgetId, setForgetId] = useState<string | null>(null); const [query, setQuery] = useState(''); const [recall, setRecall] = useState<MemoryRecall | null>(null);
  const [loading, setLoading] = useState(true); const [loadError, setLoadError] = useState<string | null>(null);
  const revision = useRef(0); const mounted = useRef(false); const selection = useRef(selected); selection.current = selected;
  const action = usePanelAction();
  const refresh = useCallback(async () => {
    const request = ++revision.current; const selectedId = selection.current?.memoryId;
    const [next, current] = await Promise.all([services.memory.query(owner, filter), selectedId ? services.memory.read(owner, selectedId) : Promise.resolve(null)]);
    if (!mounted.current || request !== revision.current) return;
    setPage(next); setLoadError(null); setLoading(false); setRecall(null);
    if (selectedId && selection.current?.memoryId === selectedId) setSelected(current);
  }, [services.memory, owner.workspaceId, owner.sessionId, filter]);
  useEffect(() => {
    mounted.current = true; setLoading(true); setPage(null); setRecall(null);
    const pending = refresh(); const request = revision.current;
    void pending.catch((error: unknown) => { if (mounted.current && request === revision.current) { setLoadError(error instanceof Error ? error.message : '长期记忆暂不可用'); setLoading(false); } });
    return () => { mounted.current = false; revision.current++; };
  }, [refresh]);
  const run = (operation: () => Promise<unknown>, reload = true) => { void action.execute(async () => {
    await operation(); if (mounted.current && reload) await refresh();
  }); };
  const save = (content: LongMemoryContent, baseline: { memoryId: string | null; version: number | null }) => run(async () => {
    await services.memory.put(owner, baseline.memoryId ?? crypto.randomUUID(), baseline.version, content);
    if (mounted.current) { setEditing(false); setSelected(null); setForgetId(null); }
  });
  const select = (memory: LongMemoryRecord) => { if (!action.pending && !editing) { setSelected(memory); setEditing(false); setForgetId(null); } };
  const more = () => run(async () => {
    if (!page?.nextCursor) return; const request = ++revision.current; const next = await services.memory.query(owner, filter, page.nextCursor);
    if (!mounted.current || request !== revision.current) return;
    setPage(current => current ? { ...next, memories: [...new Map([...current.memories, ...next.memories].map(memory => [memory.memoryId, memory])).values()] } : next);
  }, false);
  return <section className="simple-module-panel memory-panel" aria-labelledby={`${moduleId}-title`}>
    <header className="module-content-header"><div><span>当前工作区与会话</span><h1 id={`${moduleId}-title`}>长期记忆</h1></div>
      <button type="button" disabled={action.pending} onClick={() => run(refresh, false)}>刷新</button></header>
    <p>只召回已审核并启用且未到期的记忆。Agent 提出的候选需要你审核。</p>
    <div className="productivity-inline"><SelectMenu<'all' | LongMemoryRecord['status']> ariaLabel="记忆状态筛选" value={filter} onChange={setFilter} disabled={action.pending || editing}
      options={[{ value: 'all', label: '全部记忆' }, { value: 'candidate', label: '待审核' }, { value: 'active', label: '已启用' }, { value: 'inactive', label: '已停用' }]} />
      <button type="button" disabled={action.pending || editing || loading || page === null} onClick={() => { setSelected(null); setEditingMemory(null); setEditing(true); setForgetId(null); }}>新增记忆</button></div>
    {loading && <p role="status">正在加载记忆…</p>}{loadError && <p role="alert">加载失败：{loadError}</p>}
    {action.error && <p role="alert">操作失败：{action.error}</p>}{action.pending && <p role="status">正在处理…</p>}
    <form className="productivity-inline" onSubmit={event => { event.preventDefault(); if (!query.trim() || action.pending) return;
      run(async () => { const result = await services.memory.recall(owner, query.trim()); if (mounted.current) setRecall(result); }, false); }}>
      <input aria-label="记忆召回关键词" maxLength={4_000} value={query} onChange={event => setQuery(event.target.value)} placeholder="查找相关记忆" />
      <button type="submit" disabled={action.pending || !query.trim() || page === null}>召回</button></form>
    {recall && <article className="productivity-card memory-recall" aria-label="记忆召回结果">
      <h2>召回结果</h2><p>{recall.embedding.provider === 'lexical' ? '词法近似匹配' : `本地语义模型：${recall.embedding.modelId}`} · {recall.embedding.dimension} 维</p>
      {recall.embedding.reason === 'lexical_approximation_not_semantic' && <p>当前使用词法近似，不代表神经语义理解。</p>}
      {recall.embedding.reason === 'model_unavailable' && <p role="status">本地模型不可用，当前仅显示词法证据。</p>}
      {recall.embedding.reason === 'index_rebuild_required' && <p role="status">记忆索引正在准备或重建，当前结果不完整。请稍后重试。</p>}
      {!recall.complete && <p role="status">本次召回未完整完成，可能还有相关记忆。请稍后重试或使用更具体的关键词。</p>}
      {recall.hits.length === 0 && <p>没有匹配的有效记忆。</p>}
      <ul className="memory-list">{recall.hits.map(hit => <li key={hit.memory.memoryId}><button type="button" disabled={action.pending || editing} onClick={() => select(hit.memory)}>{hit.memory.title}</button>
        <small>{Math.round(hit.score * 100)}% · {hit.reason === 'lexical' ? '词法' : hit.reason === 'semantic' ? '语义' : '混合'}</small></li>)}</ul>
    </article>}
    <ul className="memory-list" aria-label="记忆列表">{page?.memories.map(memory => <li key={memory.memoryId}>
      <button type="button" disabled={action.pending || editing} aria-pressed={selected?.memoryId === memory.memoryId} onClick={() => select(memory)}>{memory.title}</button>
      <small>{states[memory.status]} · {scopes[memory.scope]} · v{memory.version}{memory.expired ? ' · 已到期' : ''}</small></li>)}</ul>
    {page && page.memories.length === 0 && <p>当前筛选下没有记忆。</p>}
    {page?.nextCursor && <button type="button" disabled={action.pending} onClick={more}>加载更多记忆</button>}
    {editing ? <MemoryEditor key={editingMemory?.memoryId ?? 'new'} initialMemory={editingMemory} memory={selected} pending={action.pending} onSave={save} onCancel={() => setEditing(false)} />
      : selected && <article className="productivity-card memory-detail" aria-label="记忆详情">
        <h2>{selected.title}</h2><p className="memory-content">{selected.content}</p>
        <p>{states[selected.status]} · {scopes[selected.scope]} · v{selected.version} · 可信度 {selected.confidence}</p>
        <p>来源：{selected.provenance.kind === 'user' ? '用户' : selected.provenance.kind === 'agent' ? `Agent Run ${selected.provenance.runId}` : `旧记忆 ${selected.provenance.legacyMemoryId}`}</p>
        <p>更新时间：{new Date(selected.updatedAt).toLocaleString()} · 审核时间：{selected.reviewedAt ? new Date(selected.reviewedAt).toLocaleString() : '尚未审核'}</p>
        {selected.retentionUntil && <p>到期时间：{new Date(selected.retentionUntil).toLocaleString()}{selected.expired ? '（已到期，不参与召回）' : ''}</p>}
        <div className="productivity-inline"><button type="button" disabled={action.pending} onClick={() => { setEditingMemory(selected); setEditing(true); }}>编辑记忆</button>
          {selected.status !== 'active' && <button type="button" disabled={action.pending} onClick={() => run(() => services.memory.transition(owner, selected, 'activate'))}>审核并启用</button>}
          {selected.status === 'active' && <button type="button" disabled={action.pending} onClick={() => run(() => services.memory.transition(owner, selected, 'deactivate'))}>停用记忆</button>}
          {selected.status === 'candidate' && <button type="button" disabled={action.pending} onClick={() => run(() => services.memory.transition(owner, selected, 'reject'))}>拒绝候选</button>}
          <button type="button" disabled={action.pending} onClick={() => setForgetId(selected.memoryId)}>忘记记忆</button></div>
        {forgetId === selected.memoryId && <div><p>忘记会删除记忆正文及召回索引，无法恢复。历史会话、运行记录和离线备份中的内容仍会保留。</p><button type="button" disabled={action.pending} onClick={() => run(async () => {
          await services.memory.forget(owner, selected); if (mounted.current) { setSelected(null); setForgetId(null); }
        })}>确认忘记</button><button type="button" disabled={action.pending} onClick={() => setForgetId(null)}>取消忘记</button></div>}
      </article>}
  </section>;
}
