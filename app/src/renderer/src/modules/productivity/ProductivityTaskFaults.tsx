import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProductivityTaskFault, ProductivityTaskFaultFeatureStore, ProductivityTaskFaultPage } from '@renderer/core/runtime/features/productivity-task-fault-feature-store';

const codeText: Record<ProductivityTaskFault['code'], string> = {
  submission_identity_conflict: '提交身份不一致', task_authority_conflict: '任务权威状态不一致',
  result_authority_conflict: '结果证据不一致', cancellation_rejected: '取消请求未获确认'
};
const kindText = { workflow: '工作流', goal: '目标', schedule: '调度' };
const stateText = { quarantined: '已隔离', reconciling: '核对中', resolved: '已恢复' };
export function ProductivityTaskFaults({ faults, workspaceId, sessionId, refreshToken, onReconciled, openSession }: {
  faults: ProductivityTaskFaultFeatureStore; workspaceId: string; sessionId: string; refreshToken: number;
  onReconciled(): void; openSession(id: string): Promise<void>;
}): React.JSX.Element {
  const [page, setPage] = useState<ProductivityTaskFaultPage | null>(null);
  const [after, setAfter] = useState<string | undefined>();
  const [loading, setLoading] = useState(false), [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const generation = useRef(0), mounted = useRef(false), busy = useRef(false);
  const refresh = useCallback(async () => {
    const revision = ++generation.current; setLoading(true);
    try {
      const next = await faults.query(workspaceId, sessionId, after);
      if (mounted.current && generation.current === revision) { setPage(next); setError(null); }
    } catch {
      if (mounted.current && generation.current === revision) { setPage(null); setError('隔离记录暂不可用，请刷新重试。'); }
    } finally { if (mounted.current && generation.current === revision) setLoading(false); }
  }, [faults, workspaceId, sessionId, after]);
  useEffect(() => {
    mounted.current = true; setPage(null); void refresh();
    return () => { mounted.current = false; generation.current++; };
  }, [refresh, refreshToken]);
  const reconcile = async (fault: ProductivityTaskFault) => {
    if (busy.current) return;
    busy.current = true; setPending(fault.faultId); setMessage(null); setError(null);
    const revision = generation.current;
    try {
      const result = await faults.reconcile(fault);
      if (!mounted.current || generation.current !== revision) return;
      setMessage(result.outcome === 'recovered' ? '原任务证据已核对，可以继续处理。'
        : result.outcome === 'superseded' ? '任务已被另一次恢复更新，请查看最新状态。' : '原任务证据尚不完整，继续保持隔离。');
      await refresh(); onReconciled();
    } catch {
      if (mounted.current && generation.current === revision) setError('恢复结果尚未确认。再次核对会使用原命令身份，不会重发任务。');
    } finally {
      busy.current = false; if (mounted.current) setPending(null);
    }
  };
  if (!loading && page?.faults.length === 0 && !page.nextFaultId && after === undefined && !error && !message) {
    return <details className="productivity-task-faults productivity-empty-faults"><summary>当前没有隔离任务</summary>
      <button type="button" onClick={() => { void refresh(); }}>刷新隔离记录</button>
    </details>;
  }
  return <article className="productivity-card productivity-task-faults" aria-label="任务隔离与恢复">
    <h2>任务隔离与恢复</h2>
    <p>核对原任务的持久化证据。证据完整才解除隔离；此操作不创建或重发任务。</p>
    {loading && <p role="status">正在读取隔离记录…</p>}
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
    <button type="button" disabled={loading || pending !== null} onClick={() => { void refresh(); }}>刷新隔离记录</button>
    {!loading && page?.faults.length === 0 && <p>本页没有隔离记录。</p>}
    <ul>{page?.faults.map(fault => <li key={fault.faultId} data-task-fault-id={fault.faultId}>
      <span>{kindText[fault.taskKind]} · {stateText[fault.state]} · {codeText[fault.code]}</span>
      <small>任务 {fault.taskId} · 更新于 {new Date(fault.updatedAt).toLocaleString()}</small>
      <button type="button" disabled={pending !== null || loading || fault.state === 'resolved'} onClick={() => { void reconcile(fault); }}>
        {pending === fault.faultId ? '正在核对…' : '核对并恢复'}</button>
      <button type="button" disabled={pending !== null} onClick={() => {
        void openSession(fault.sessionId).catch(() => { if (mounted.current) setError('所属会话暂时无法打开。'); });
      }}>打开所属会话</button>
    </li>)}</ul>
    <div className="productivity-inline">
      <button type="button" disabled={loading || pending !== null || after === undefined} onClick={() => { setPage(null); setAfter(undefined); }}>返回首页</button>
      <button type="button" disabled={loading || pending !== null || !page?.nextFaultId} onClick={() => {
        if (page?.nextFaultId) { setPage(null); setAfter(page.nextFaultId); }
      }}>下一页</button>
    </div>
  </article>;
}
