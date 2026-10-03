import { useId, useRef } from 'react';
import { Settings, X } from 'lucide-react';
import type { FeatureDialogProps } from '@renderer/core/modules/module-contract';
import { SettingsPanel } from './SettingsPanel';
import { ModalSurface } from '@renderer/shared/ui/ModalSurface';

export function SettingsDialog({
  moduleId,
  open,
  services,
  onClose
}: FeatureDialogProps): React.JSX.Element | null {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  if (!open) return null;
  return (
    <ModalSurface open={open} onClose={onClose} className="settings-dialog-backdrop" labelledBy={titleId} initialFocusRef={closeButtonRef}>
      <section className="settings-dialog">
        <header className="settings-dialog-titlebar">
          <div><Settings size={15} /><strong id={titleId}>设置</strong></div>
          <button ref={closeButtonRef} type="button" aria-label="关闭设置" title="关闭设置" onClick={onClose}><X size={17} /></button>
        </header>
        <div className="settings-dialog-body">
          <SettingsPanel moduleId={moduleId} services={services} />
        </div>
      </section>
    </ModalSurface>
  );
}
