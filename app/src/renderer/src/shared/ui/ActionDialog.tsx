import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { AlertTriangle, Pencil } from 'lucide-react';
import { ModalSurface } from './ModalSurface';

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
  const descriptionId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <ModalSurface open={open} onClose={onClose} className="action-dialog-backdrop" role="alertdialog" labelledBy={titleId} describedBy={descriptionId} initialFocusRef={cancelRef} closeOnBackdrop>
      <section className="action-dialog">
        <div className={`action-dialog-icon${danger ? ' is-danger' : ''}`}><AlertTriangle size={18} /></div>
        <div className="action-dialog-copy"><h2 id={titleId}>{title}</h2><p id={descriptionId}>{description}</p></div>
        <footer>
          <button ref={cancelRef} type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="button" className={danger ? 'danger-button' : 'primary-button'} onClick={onConfirm}>{confirmLabel}</button>
        </footer>
      </section>
    </ModalSurface>
  );
}

export function TextPromptDialog(props: TextPromptDialogProps): React.JSX.Element | null {
  if (!props.open) return null;
  return <TextPromptContent key={props.initialValue} {...props} />;
}

function TextPromptContent({
  open,
  title,
  description,
  initialValue,
  confirmLabel,
  onConfirm,
  onClose
}: TextPromptDialogProps): React.JSX.Element | null {
  const titleId = useId();
  const descriptionId = useId();
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed) onConfirm(trimmed);
  };

  return (
    <ModalSurface open={open} onClose={onClose} className="action-dialog-backdrop" labelledBy={titleId} describedBy={descriptionId} initialFocusRef={inputRef} closeOnBackdrop>
      <form className="action-dialog action-dialog--prompt" onSubmit={submit}>
        <div className="action-dialog-icon"><Pencil size={18} /></div>
        <div className="action-dialog-copy"><h2 id={titleId}>{title}</h2><p id={descriptionId}>{description}</p></div>
        <label className="action-dialog-field"><span>会话名称</span><input ref={inputRef} value={value} maxLength={80} onChange={(event) => setValue(event.target.value)} /></label>
        <footer>
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="submit" className="primary-button" disabled={!value.trim()}>{confirmLabel}</button>
        </footer>
      </form>
    </ModalSurface>
  );
}
