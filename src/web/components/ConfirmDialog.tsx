import { useEffect, useId, useRef } from 'react';
import type { ReactElement } from 'react';

interface ConfirmDialogProps {
    title: string;
    message: string;
    onConfirm: () => void;
    onCancel: () => void;
    confirmLabel?: string;
    cancelLabel?: string;
    error?: string | undefined;
    isBusy?: boolean;
}

function ConfirmDialog({ title, message, onConfirm, onCancel, confirmLabel = 'Delete', cancelLabel = 'Cancel', error, isBusy = false }: ConfirmDialogProps): ReactElement {
    const cancelButtonRef = useRef<HTMLButtonElement>(null);
    const onCancelRef = useRef(onCancel);
    const titleId = useId();
    const messageId = useId();

    useEffect(() => {
        onCancelRef.current = onCancel;
    }, [onCancel]);

    useEffect(() => {
        cancelButtonRef.current?.focus();
    }, []);

    useEffect(() => {
        function cancelOnEscape(event: KeyboardEvent): void {
            if (event.key === 'Escape') {
                event.preventDefault();
                onCancelRef.current();
            }
        }

        document.addEventListener('keydown', cancelOnEscape);

        return () => {
            document.removeEventListener('keydown', cancelOnEscape);
        };
    }, []);

    return (
        <div className="confirm-dialog-backdrop">
            <section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={messageId}>
                <h2 id={titleId}>{title}</h2>
                <p id={messageId}>{message}</p>
                {error === undefined ? null : <p className="confirm-dialog-error" role="alert">{error}</p>}
                <div className="confirm-dialog-actions">
                    <button ref={cancelButtonRef} type="button" className="choice-button" disabled={isBusy} onClick={onCancel}>{cancelLabel}</button>
                    <button type="button" className="choice-button is-danger" disabled={isBusy} onClick={onConfirm}>{isBusy ? 'Deleting…' : confirmLabel}</button>
                </div>
            </section>
        </div>
    );
}

export { ConfirmDialog };
export type { ConfirmDialogProps };
