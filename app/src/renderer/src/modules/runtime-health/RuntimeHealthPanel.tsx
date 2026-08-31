import type { FeaturePanelProps } from '@renderer/core/modules/module-contract';
import { useFeatureSnapshot } from '@renderer/core/runtime/features/feature-snapshot-store';
import { formatRuntimeAvailability } from '@renderer/core/runtime/runtime-labels';

export function RuntimeHealthPanel({ moduleId, services }: FeaturePanelProps): React.JSX.Element {
  const diagnostics = useFeatureSnapshot(services.diagnostics.view);
  return <section className="agent-status-panel" aria-labelledby={`${moduleId}-title`}>
    <header className="module-header">
      <div><span className="eyebrow">UI component sample</span><h1 id={`${moduleId}-title`}>Runtime 健康</h1></div>
    </header>
    <dl className="agent-status-grid">
      <div><dt>Runtime</dt><dd>{formatRuntimeAvailability(diagnostics.status.availability)}</dd></div>
      <div><dt>Projection cursor</dt><dd>{diagnostics.projectionCursor}</dd></div>
      <div><dt>Profile</dt><dd>{services.applicationProfile.id}@{services.applicationProfile.revision}</dd></div>
      <div><dt>Integrity</dt><dd>{diagnostics.projectionIntegrityError ?? '正常'}</dd></div>
    </dl>
  </section>;
}
