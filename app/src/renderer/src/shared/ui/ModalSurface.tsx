import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import './modal-surface.css';

/** Native modality owns background inertness and Tab containment for every dialog. */
export function useModalDialog(
  dialogRef: RefObject<HTMLDialogElement | null>,
  open: boolean,
  initialFocusRef: RefObject<HTMLElement | null>
): void {
  useLayoutEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    initialFocusRef.current?.focus({ preventScroll: true });
    return () => {
      dialog.close();
      requestAnimationFrame(() => {
        if (!previousFocus?.isConnected || previousFocus.closest('[inert]')) return;
        const activeModals = Array.from(document.querySelectorAll<HTMLDialogElement>('dialog:modal'));
        const currentModal = activeModals.at(-1);
        // Restore a nested dialog's opener, but never steal focus from a replacement dialog.
        if (!currentModal || currentModal.contains(previousFocus)) previousFocus.focus({ preventScroll: true });
      });
    };
  }, [dialogRef, initialFocusRef, open]);
}

interface ModalSurfaceProps {
  open: boolean;
  onClose(): void;
  className: string;
  labelledBy: string;
  describedBy?: string;
  role?: 'dialog' | 'alertdialog';
  initialFocusRef: RefObject<HTMLElement | null>;
  closeOnBackdrop?: boolean;
  children: ReactNode;
}

export function ModalSurface({ open, onClose, className, labelledBy, describedBy, role = 'dialog', initialFocusRef, closeOnBackdrop = false, children }: ModalSurfaceProps): React.JSX.Element | null {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useModalDialog(dialogRef, open, initialFocusRef);
  if (!open) return null;
  return createPortal(
    <dialog
      ref={dialogRef}
      className={`modal-surface ${className}`}
      role={role}
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onCancel={event => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        onClose();
      }}
      onMouseDown={event => {
        if (closeOnBackdrop && event.target === event.currentTarget) onClose();
      }}
    >{children}</dialog>,
    document.body
  );
}
