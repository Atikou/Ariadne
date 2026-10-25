import { useCallback, useRef, useState } from 'react';
import type { RuntimeRun } from '@renderer/core/runtime/runtime-projection-presenter';
import type { RunFeatureStore } from '@renderer/core/runtime/features/run-feature-store';
import type { ProjectionInboxInput } from '@renderer/core/runtime/projection/projection-presentation';
import { RunCollectionControls } from '@renderer/shared/ui/RunCollectionControls';
import { ConversationBodyPlaceholder } from './ConversationBodyPlaceholder';

export function AgentInboxPanel({ run, reads }: { run: RuntimeRun; reads: RunFeatureStore }): React.JSX.Element {
  const [editing, setEditing] = useState<{ inputId: string; version: number; content: string } | null>(null);
  const [error, setError] = useState<string | null>(null), [saving, setSaving] = useState(false);
  const current = useRef(run); current.current = run;
  const queued = run.inbox.filter(input => input.state === 'queued' && input.source === undefined);
  const save = async () => {
    if (editing === null || saving || !editing.content.trim()) return;
    const draft = editing;
    if (!current.current.inbox.some(input => input.inputId === draft.inputId && input.version === draft.version && input.state === 'queued')) {
      setError('输入已更新或不在当前页。重新读取后再编辑。'); return;
    }
    setSaving(true); setError(null);
    try { await reads.replaceInput(run, draft.inputId, draft.version, draft.content); setEditing(previous => previous === draft ? null : previous); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '编辑输入失败，草稿已保留。'); }
    finally { setSaving(false); }
  };
  const remove = async (input: ProjectionInboxInput) => {
    setError(null);
    try { await reads.removeInput(run, input.inputId, input.version); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '移除输入失败。'); }
  };
  return <div className="agent-inbox" aria-label="Agent 输入队列">
    <RunCollectionControls label="输入" coverage={run.collections.inbox} owner={`${run.runId}:${run.documentToken}`}
      onRead={direction => reads.readCollection(run, 'inbox', direction)} />
    {queued.map(input => <div className="agent-inbox-row" key={input.inputId}>
      <span className="agent-inbox-mode">{input.delivery === 'next_step' ? '下一步' : '下一轮'}</span>
      {editing?.inputId === input.inputId ? <input className="agent-inbox-edit" aria-label="编辑排队消息" autoFocus value={editing.content}
        disabled={saving} onChange={event => setEditing({ ...editing, content: event.target.value })}
        onKeyDown={event => {
          if (event.key === 'Escape' && !saving) setEditing(null);
          if (event.key === 'Enter') { event.preventDefault(); void save(); }
        }} /> : <InboxContent run={run} input={input} reads={reads} />}
      <button type="button" disabled={saving || input.content === undefined} onClick={() => {
        if (input.content !== undefined) { setEditing({ inputId: input.inputId, version: input.version, content: input.content }); setError(null); }
      }}>编辑</button>
      <button type="button" disabled={saving} onClick={() => { void remove(input); }}>移除</button>
    </div>)}
    {run.collections.inbox.state === 'complete' && queued.length === 0 && <small>当前队列没有可编辑的用户输入。</small>}
    {error !== null && <small role="alert">{error}</small>}
  </div>;
}
function InboxContent({ run, input, reads }: { run: RuntimeRun; input: ProjectionInboxInput; reads: RunFeatureStore }): React.JSX.Element {
  const load = useCallback(() => run.sessionId === undefined ? Promise.reject(new Error('projection_inbox_session_required'))
    : reads.loadInboxBody(run.runId, run.sessionId, input.inputId, input.bodyReadToken), [run.runId, run.sessionId, input.inputId, input.bodyReadToken, reads]);
  return input.content === undefined ? <ConversationBodyPlaceholder onLoad={load} /> : <span className="agent-inbox-content">{input.content}</span>;
}
