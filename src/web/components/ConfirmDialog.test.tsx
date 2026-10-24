// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from './ConfirmDialog.tsx';

describe('ConfirmDialog', () => {
    afterEach(cleanup);

    it('uses an alertdialog, focuses Cancel, and confirms deletion', () => {
        const onConfirm = vi.fn();
        const onCancel = vi.fn();

        render(<ConfirmDialog title="Delete Ana?" message="The bot data will be removed for good." onConfirm={onConfirm} onCancel={onCancel} />);

        const dialog = screen.getByRole('alertdialog', { name: 'Delete Ana?' });
        const cancelButton = screen.getByRole('button', { name: 'Cancel' });
        const message = screen.getByText('The bot data will be removed for good.');

        expect(dialog.getAttribute('aria-describedby'))
            .toBe(message.id);
        expect(document.activeElement)
            .toBe(cancelButton);

        fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
        expect(onConfirm)
            .toHaveBeenCalledTimes(1);
        expect(onCancel)
            .not.toHaveBeenCalled();
    });

    it('cancels on Escape and displays a server refusal in the dialog', () => {
        const onCancel = vi.fn();

        render(<ConfirmDialog title="Delete Ana?" message="The bot data will be removed for good." error="The last bot cannot be deleted." onConfirm={vi.fn()} onCancel={onCancel} />);

        const alertText = screen.getByRole('alert').textContent;

        expect(alertText)
            .toContain('The last bot cannot be deleted.');

        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onCancel)
            .toHaveBeenCalledTimes(1);
    });
});
