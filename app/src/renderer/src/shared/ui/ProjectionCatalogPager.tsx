import type { ProjectionCatalogWindow } from '@renderer/core/runtime/projection/projection-catalog-repository';
import { usePanelAction } from './usePanelAction';

export function ProjectionCatalogPager({ window, navigate, label }: {
  window: ProjectionCatalogWindow | null;
  navigate(direction: 'next' | 'previous'): Promise<void>;
  label: string;
}): React.JSX.Element | null {
  const action = usePanelAction();
  if (window === null) return null;
  const page = window.page;
  return <div className="projection-catalog-pager" aria-label={`${label}分页`}>
    <span>{label} {page.totalRows} 项 · 第 {page.pageIndex + 1} 页</span>
    <button type="button" disabled={action.pending || page.pageIndex === 0}
      onClick={() => void action.execute(() => navigate('previous'))}>上一页</button>
    <button type="button" disabled={action.pending || !page.hasMore}
      onClick={() => void action.execute(() => navigate('next'))}>下一页</button>
    {action.error && <p role="alert">{action.error}</p>}
  </div>;
}
