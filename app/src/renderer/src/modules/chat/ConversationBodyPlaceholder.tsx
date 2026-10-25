import { useCallback, useEffect, useRef, useState } from 'react';
import './ConversationBodyPlaceholder.css';

/** Metadata is already verified. Visibility authorizes a separate complete
 * body read; failures leave this explicit unread state and a retry action. */
export function ConversationBodyPlaceholder({ onLoad }: { onLoad?: (() => Promise<void>) | undefined }): React.JSX.Element {
  const target = useRef<HTMLDivElement>(null), alive = useRef(true);
  const pending = useRef<{ owner: () => Promise<void>; ticket: symbol } | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (onLoad === undefined || pending.current?.owner === onLoad) return;
    const ticket = Symbol('body-read');
    pending.current = { owner: onLoad, ticket }; setLoading(true); setError(null);
    try { await onLoad(); }
    catch (cause) { if (alive.current && pending.current?.ticket === ticket) setError(cause instanceof Error ? cause.message : '读取正文失败。'); }
    finally {
      if (pending.current?.ticket === ticket) { pending.current = null; if (alive.current) setLoading(false); }
    }
  }, [onLoad]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (target.current === null || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); void load(); }
    }, { root: target.current.closest('.message-viewport') });
    observer.observe(target.current); return () => observer.disconnect();
  }, [load]);
  return <div ref={target} className="message-body-placeholder" role="status">
    <span>{loading ? '正在读取正文…' : '正文未加载'}</span>
    <button type="button" className="secondary-button" disabled={loading || onLoad === undefined} onClick={() => { void load(); }}>
      {loading ? '读取中…' : error === null ? '读取正文' : '重试读取正文'}
    </button>
    {error !== null && <small>{error}</small>}
  </div>;
}
