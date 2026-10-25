import { useEffect, useRef, useState } from 'react';
import type { ProjectionCollectionCoverage } from '@renderer/core/runtime/projection/projection-presentation';

export function RunCollectionControls({ label, coverage, owner, onRead }: {
  label: string; coverage: ProjectionCollectionCoverage; owner: string; onRead: (direction: 'first' | 'next') => Promise<void>;
}): React.JSX.Element {
  const current = useRef(owner); current.current = owner;
  const [loading, setLoading] = useState(false), [error, setError] = useState<string | null>(null);
  useEffect(() => { setLoading(false); setError(null); }, [owner]);
  const read = async (direction: 'first' | 'next') => {
    if (loading) return; const captured = owner; setLoading(true); setError(null);
    try { await onRead(direction); }
    catch (cause) { if (current.current === captured) setError(cause instanceof Error ? cause.message : '读取记录失败。'); }
    finally { if (current.current === captured) setLoading(false); }
  };
  return <div className="run-collection-controls" aria-label={`${label}范围`}>
    <span>{coverage.state === 'unloaded' ? `${label}未加载，共 ${coverage.total} 项`
      : coverage.total === 0 ? `${label}共 0 项`
        : `${label} ${coverage.startOrdinal + 1}–${coverage.startOrdinal + coverage.count} / ${coverage.total}`}</span>
    {coverage.state === 'partial' && <small>仅当前页</small>}
    <button type="button" disabled={loading || (coverage.state !== 'unloaded' && !coverage.hasEarlier)} onClick={() => { void read('first'); }}>
      {coverage.state === 'unloaded' ? '加载记录' : '第一页'}
    </button>
    <button type="button" disabled={loading || coverage.state === 'unloaded' || !coverage.hasMore} onClick={() => { void read('next'); }}>下一页</button>
    {loading && <small>读取中…</small>}{error !== null && <small role="alert">{error}</small>}
  </div>;
}
