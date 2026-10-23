// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PeopleHubHint } from './PeopleHubHint.tsx';

describe('PeopleHubHint', () => {
    afterEach(cleanup);

    it('says that only the owner of a hub adds people and links the install guide', () => {
        render(<PeopleHubHint onClose={vi.fn()} />);

        expect(screen.getByText('Only the owner of a hub adds people'))
            .toBeTruthy();
        expect(screen.getByRole('link', { name: 'Read the install guide' })
            .getAttribute('href'))
            .toContain('docs/INSTALL.md');
    });

    it('copies the install command', async () => {
        const writeText = vi.fn()
            .mockResolvedValue(undefined);

        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
        render(<PeopleHubHint onClose={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Copy command' }));

        await waitFor(() => {
            expect(screen.getByRole('button', { name: 'Copied' }))
                .toBeTruthy();
        });
        expect(writeText)
            .toHaveBeenCalledWith(expect.stringContaining('docker/install.sh | sudo bash'));
    });

    it('closes from the button', () => {
        const onClose = vi.fn();

        render(<PeopleHubHint onClose={onClose} />);
        fireEvent.click(screen.getByRole('button', { name: 'Close people panel' }));

        expect(onClose)
            .toHaveBeenCalledTimes(1);
    });
});
