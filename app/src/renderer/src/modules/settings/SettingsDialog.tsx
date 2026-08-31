import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Settings, X } from 'lucide-react';
import type { FeatureDialogProps } from '@renderer/core/modules/module-contract';
import { SettingsPanel } from './SettingsPanel';

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[href]',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

export function SettingsDialog({
  moduleId,
  open,
  services,
  onClose
}: FeatureDialogProps): React.JSX.Element | null {
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const appShell = document.querySelector<HTMLElement>('.app-shell');
    appShell?.setAttribute('inert', '');
    document.body.classList.add('has-settings-dialog');

    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []);
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      appShell?.removeAttribute('inert');
      document.body.classList.remove('has-settings-dialog');
      requestAnimationFrame(() => previousFocus?.focus());
    };
  }, [onClose, open]);

  if (!open) return null;
  return createPortal(
    <div className="settings-dialog-backdrop">
      <section
        ref={dialogRef}
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ariadne-settings-dialog-title"
        tabIndex={-1}
      >
        <header className="settings-dialog-titlebar">
          <div><Settings size={15} /><strong id="ariadne-settings-dialog-title">设置</strong></div>
          <button ref={closeButtonRef} type="button" aria-label="关闭设置" title="关闭设置" onClick={onClose}><X size={17} /></button>
        </header>
        <div className="settings-dialog-body">
          <SettingsPanel moduleId={moduleId} services={services} />
        </div>
      </section>
    </div>,
    document.body
  );
}
