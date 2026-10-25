import type { LongMemoryContent, LongMemoryRecord } from '@ariadne/protocol/public';
import { SelectMenu } from '@renderer/shared/ui/SelectMenu';
import { useRevisionDraft } from '@renderer/shared/ui/useRevisionDraft';
import { RevisionDraftConflict } from '@renderer/shared/ui/RevisionDraftConflict';

const types: readonly LongMemoryContent['memoryType'][] = ['preference','habit','decision','fact','lesson','project_note','recent_state','task_state','known_issue','tech_stack'];
const typeLabels = ['偏好','习惯','决定','事实','经验','项目笔记','近期状态','任务状态','已知问题','技术栈'];
export function MemoryEditor({ initialMemory, memory, pending, onSave, onCancel }: {
  initialMemory: LongMemoryRecord | null; memory: LongMemoryRecord | null; pending: boolean;
  onSave(content: LongMemoryContent, baseline: { memoryId: string | null; version: number | null }): void; onCancel(): void;
}): React.JSX.Element {
  const missing = initialMemory !== null && memory === null;
  const draft = useRevisionDraft(memoryFields(memory ?? initialMemory), memory ? String(memory.version) : initialMemory ? 'deleted' : 'new');
  const { scope, type, title, content, importance, confidence, sensitivity, retention } = draft.value;
  const expiry = retention ? new Date(retention) : null;
  const valid = !missing && !draft.conflict && title.trim().length > 0 && content.trim().length > 0 && title.trim().length <= 256 && content.trim().length <= 8_000
    && Number.isFinite(importance) && importance >= 0 && importance <= 1 && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
    && (expiry === null || Number.isFinite(expiry.getTime()));
  return <form className="memory-editor" onSubmit={event => { event.preventDefault(); if (valid && !pending) onSave({ scope, memoryType: type,
    title: title.trim(), content: content.trim(), importance, confidence, sensitivity, retentionUntil: expiry?.toISOString() ?? null },
    { memoryId: initialMemory?.memoryId ?? null, version: initialMemory ? Number(draft.revision) : null }); }}>
    <fieldset disabled={pending}>
      <legend>{initialMemory ? `编辑记忆 · 原版本 ${draft.revision}` : '新增记忆'}</legend>
      {missing && <p role="alert">此记忆已不在当前权威中，本地输入已保留供复制；不会自动创建另一条记忆。</p>}
      {draft.conflict && !missing && <><RevisionDraftConflict subject="记忆" changes={[
        `原标题：${draft.baseline.title}；当前标题：${memory?.title ?? ''}`,
        `原版本 ${draft.revision}；当前版本 ${memory?.version}`
      ]} reload={draft.reload} rebase={() => draft.rebase()} />
        <details><summary>比较原记忆与当前内容</summary><p>编辑前：{draft.baseline.content}</p><p>当前：{memory?.content}</p></details></>}
      <label>标题<input aria-label="记忆标题" maxLength={256} value={title} onChange={event => draft.edit({ ...draft.value, title: event.target.value })} /></label>
      <label>内容<textarea aria-label="记忆内容" maxLength={8_000} rows={6} value={content} onChange={event => draft.edit({ ...draft.value, content: event.target.value })} /></label>
      <label>作用域<SelectMenu<LongMemoryContent['scope']> ariaLabel="记忆作用域" value={scope} onChange={scope => draft.edit({ ...draft.value, scope })} disabled={pending || initialMemory !== null}
        options={[{ value: 'workspace', label: '当前工作区' }, { value: 'session', label: '当前会话' }, { value: 'global', label: '全局共享' }]} /></label>
      {scope === 'global' && <p>全局记忆会用于所有已授权工作区的会话。</p>}
      <label>类型<SelectMenu<LongMemoryContent['memoryType']> ariaLabel="记忆类型" value={type} onChange={type => draft.edit({ ...draft.value, type })} disabled={pending}
        options={types.map((value, index) => ({ value, label: typeLabels[index]! }))} /></label>
      <label>重要性<input aria-label="记忆重要性" type="number" step="0.1" min={0} max={1} value={importance} onChange={event => draft.edit({ ...draft.value, importance: Number(event.target.value) })} /></label>
      <label>可信度<input aria-label="记忆可信度" type="number" step="0.1" min={0} max={1} value={confidence} onChange={event => draft.edit({ ...draft.value, confidence: Number(event.target.value) })} /></label>
      <label>内容敏感性<SelectMenu<LongMemoryContent['sensitivity']> ariaLabel="记忆敏感性" value={sensitivity} onChange={sensitivity => draft.edit({ ...draft.value, sensitivity })} disabled={pending}
        options={[{ value: 'public', label: '公开' }, { value: 'workspace', label: '工作区' }, { value: 'sensitive', label: '敏感' }]} /></label>
      <label>到期时间（留空则长期保留）<input aria-label="记忆到期时间" type="datetime-local" value={retention} onChange={event => draft.edit({ ...draft.value, retention: event.target.value })} /></label>
      {memory?.status === 'candidate' && <p>保存后仍为候选，需要明确启用才会参与召回。</p>}
      {memory?.status === 'inactive' && <p>保存后仍为停用，需要明确启用才会参与召回。</p>}
      <div className="productivity-inline"><button type="submit" disabled={!valid}>保存记忆</button><button type="button" onClick={onCancel}>取消编辑</button></div>
    </fieldset>
  </form>;
}
function memoryFields(memory: LongMemoryRecord | null) {
  return { scope: memory?.scope ?? 'workspace', type: memory?.memoryType ?? 'fact', title: memory?.title ?? '', content: memory?.content ?? '',
    importance: memory?.importance ?? 0.8, confidence: memory?.confidence ?? 1, sensitivity: memory?.sensitivity ?? 'workspace', retention: toLocalDate(memory?.retentionUntil ?? null) };
}
function toLocalDate(value: string | null): string {
  if (value === null) return ''; const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
