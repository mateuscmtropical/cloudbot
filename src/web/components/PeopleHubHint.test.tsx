// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PeopleHubHint } from './PeopleHubHint.tsx';

describe('PeopleHubHint', () => {
    afterEach(cleanup);

    it('tells the owner of a standalone CloudBot to install a hub and links the install guide', () => {
        render(<PeopleHubHint role="standalone" onClose={vi.fn()} />);

        expect(screen.getByText('This CloudBot runs on its own'))
            .toBeTruthy();
        expect(screen.getByRole('link', { name: 'Read the install guide' })
            .getAttribute('href'))
            .toContain('docs/INSTALL.md');
    });

    it('tells a person of a hub to ask the owner and hides the install command', () => {
        render(<PeopleHubHint role="member" onClose={vi.fn()} />);

        expect(screen.getByText('Only the owner of the hub adds people'))
            .toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Copy command' }))
            .toBeNull();
    });

    it('copies the install command', async () => {
        const writeText = vi.fn()
            .mockResolvedValue(undefined);

        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
        render(<PeopleHubHint role="standalone" onClose={vi.fn()} />);
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

        render(<PeopleHubHint role="standalone" onClose={onClose} />);
        fireEvent.click(screen.getByRole('button', { name: 'Close people panel' }));

        expect(onClose)
            .toHaveBeenCalledTimes(1);
    });
});
