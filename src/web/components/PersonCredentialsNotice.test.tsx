// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PersonCredentialsNotice } from './PersonCredentialsNotice.tsx';

const originalClipboard = navigator.clipboard;

describe('PersonCredentialsNotice', () => {
    afterEach(() => {
        cleanup();
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard });
    });

    it('copies the address and password from the button', async () => {
        const writeText = vi.fn(() => Promise.resolve());
        const onHide = vi.fn();

        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
        render(<PersonCredentialsNotice name="maria" address="https://maria.example.test" password="one-time-secret" onHide={onHide} />);
        fireEvent.click(screen.getByRole('button', { name: 'Copy sign-in details' }));

        await waitFor(() => {
            expect(writeText)
                .toHaveBeenCalledWith('Address: https://maria.example.test\nPassword: one-time-secret');
        });
        expect(screen.getByRole('button', { name: 'Copied' }))
            .toBeDefined();
    });

    it('lets the owner hide the one-time details', () => {
        const onHide = vi.fn();

        render(<PersonCredentialsNotice name="maria" address="https://maria.example.test" password="one-time-secret" onHide={onHide} />);
        fireEvent.click(screen.getByRole('button', { name: 'Hide details' }));

        expect(onHide)
            .toHaveBeenCalledOnce();
    });
});
