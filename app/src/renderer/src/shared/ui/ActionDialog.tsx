import { useEffect, useId, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Pencil } from 'lucide-react';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm(): void;
  onClose(): void;
}

interface TextPromptDialogProps {
  open: boolean;
  title: string;
  description: string;
  initialValue: string;
  confirmLabel: string;
  onConfirm(value: string): void;
  onClose(): void;
}

function useEscapeToClose(open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open]);
}

function closeFromBackdrop(event: MouseEvent<HTMLDivElement>, onClose: () => void): void {
  if (event.target === event.currentTarget) onClose();
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  danger = false,
  onConfirm,
  onClose
}: ConfirmDialogProps): React.JSX.Element | null {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEscapeToClose(open, onClose);

  useEffect(() => {
    if (open) requestAnimationFrame(() => cancelRef.current?.focus());
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="action-dialog-backdrop" onMouseDown={(event) => closeFromBackdrop(event, onClose)}>
      <section className="action-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId}>
        <div className={`action-dialog-icon${danger ? ' is-danger' : ''}`}><AlertTriangle size={18} /></div>
        <div className="action-dialog-copy"><h2 id={titleId}>{title}</h2><p>{description}</p></div>
        <footer>
          <button ref={cancelRef} type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="button" className={danger ? 'danger-button' : 'primary-button'} onClick={onConfirm}>{confirmLabel}</button>
        </footer>
      </section>
    </div>,
    document.body
  );
}

export function TextPromptDialog({
  open,
  title,
  description,
  initialValue,
  confirmLabel,
  onConfirm,
  onClose
}: TextPromptDialogProps): React.JSX.Element | null {
  const titleId = useId();
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  useEscapeToClose(open, onClose);

  useEffect(() => {
    if (!open) return;
    setValue(initialValue);
    requestAnimationFrame(() => inputRef.current?.select());
  }, [initialValue, open]);

  if (!open) return null;
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed) onConfirm(trimmed);
  };

  return createPortal(
    <div className="action-dialog-backdrop" onMouseDown={(event) => closeFromBackdrop(event, onClose)}>
      <form className="action-dialog action-dialog--prompt" role="dialog" aria-modal="true" aria-labelledby={titleId} onSubmit={submit}>
        <div className="action-dialog-icon"><Pencil size={18} /></div>
        <div className="action-dialog-copy"><h2 id={titleId}>{title}</h2><p>{description}</p></div>
        <label className="action-dialog-field"><span>会话名称</span><input ref={inputRef} value={value} maxLength={80} onChange={(event) => setValue(event.target.value)} /></label>
        <footer>
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="submit" className="primary-button" disabled={!value.trim()}>{confirmLabel}</button>
        </footer>
      </form>
    </div>,
    document.body
  );
}
