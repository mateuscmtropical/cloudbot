import { useEffect, useId, useRef } from 'react';
import type { ReactElement } from 'react';

import { Button } from './Button.tsx';
import { Modal } from './Modal.tsx';

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
    const titleId = useId();
    const messageId = useId();

    useEffect(() => {
        cancelButtonRef.current?.focus();
    }, []);

    return (
        <Modal className="confirm-dialog" role="alertdialog" labelledBy={titleId} describedBy={messageId} onClose={onCancel}>
            <h2 id={titleId}>{title}</h2>
            <p id={messageId}>{message}</p>
            {error === undefined ? null : <p className="confirm-dialog-error" role="alert">{error}</p>}
            <div className="confirm-dialog-actions">
                <Button ref={cancelButtonRef} disabled={isBusy} onClick={onCancel}>{cancelLabel}</Button>
                <Button tone="danger" disabled={isBusy} onClick={onConfirm}>{isBusy ? 'Deleting…' : confirmLabel}</Button>
            </div>
        </Modal>
    );
}

export { ConfirmDialog };
export type { ConfirmDialogProps };
