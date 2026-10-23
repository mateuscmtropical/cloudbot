// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AccountPanel } from './AccountPanel.tsx';

describe('AccountPanel', () => {
    afterEach(cleanup);

    it('leads to the password page, the passkeys page and the sign out of the hub', () => {
        render(<AccountPanel onClose={vi.fn()} />);

        expect(screen.getByRole('link', { name: 'Change password' })
            .getAttribute('href'))
            .toBe('/__hub/password');
        expect(screen.getByRole('link', { name: 'Manage passkeys' })
            .getAttribute('href'))
            .toBe('/__hub/passkeys');

        const signOutButton = screen.getByRole('button', { name: 'Sign out' });

        expect(signOutButton.closest('form')
            ?.getAttribute('action'))
            .toBe('/__hub/logout');
    });

    it('closes from the button', () => {
        const onClose = vi.fn();

        render(<AccountPanel onClose={onClose} />);
        fireEvent.click(screen.getByRole('button', { name: 'Close account panel' }));

        expect(onClose)
            .toHaveBeenCalledTimes(1);
    });
});
