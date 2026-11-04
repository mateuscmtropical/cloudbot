import { useEffect, useRef } from 'react';
import type { ReactElement, ReactNode } from 'react';

interface ModalProps {
    children: ReactNode;
    onClose: () => void;
    role?: 'dialog' | 'alertdialog';
    label?: string;
    labelledBy?: string;
    describedBy?: string;
    className?: string;
}

// A native dialog. The browser keeps focus inside, makes the page behind inert and gives focus back when it closes.
// The parent mounts it to open it and unmounts it to close it.
function Modal({ children, onClose, role = 'dialog', label, labelledBy, describedBy, className }: ModalProps): ReactElement {
    const dialogRef = useRef<HTMLDialogElement>(null);
    const dialogClass = className === undefined ? 'modal' : `modal ${className}`;

    useEffect(() => {
        const dialog = dialogRef.current;

        dialog?.showModal();

        return () => {
            dialog?.close();
        };
    }, []);

    return (
        <dialog
            ref={dialogRef}
            className={dialogClass}
            role={role}
            aria-label={label}
            aria-labelledby={labelledBy}
            aria-describedby={describedBy}
            onCancel={(event) => {
                event.preventDefault();
                onClose();
            }}
            // Chrome closes on a second Escape without asking. The check skips the close of the double mount in strict mode.
            onClose={() => {
                if (dialogRef.current?.open === false) {
                    onClose();
                }
            }}
            // The content fills the dialog, so only a click on the backdrop lands on the dialog itself.
            onClick={(event) => {
                if (event.target === event.currentTarget) {
                    onClose();
                }
            }}
        >
            <div className="modal-content">{children}</div>
        </dialog>
    );
}

export { Modal };
export type { ModalProps };
