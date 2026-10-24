// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UpdateBanner } from './UpdateBanner.tsx';

afterEach(() => {
    cleanup();
});

describe('UpdateBanner', () => {
    it('shows an update action and a dismiss action', () => {
        const onApply = vi.fn();
        const onDismiss = vi.fn();

        render(<UpdateBanner canApplyUpdate onApply={onApply} onDismiss={onDismiss} />);

        expect(screen.getByRole('status').textContent)
            .toContain('A new version is ready');
        fireEvent.click(screen.getByRole('button', { name: 'Update' }));
        fireEvent.click(screen.getByRole('button', { name: 'Dismiss update' }));

        expect(onApply)
            .toHaveBeenCalledTimes(1);
        expect(onDismiss)
            .toHaveBeenCalledTimes(1);
    });

    it('disables the Update button when the reload guard cannot be saved', () => {
        const onApply = vi.fn();
        const onDismiss = vi.fn();

        render(<UpdateBanner canApplyUpdate={false} onApply={onApply} onDismiss={onDismiss} />);
        const updateButton = screen.getByRole('button', { name: 'Update' });

        expect(updateButton.hasAttribute('disabled'))
            .toBe(true);
        fireEvent.click(updateButton);

        expect(onApply)
            .not.toHaveBeenCalled();
    });
});
