// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppUpdatePanel } from './AppUpdatePanel.tsx';

const COMMIT = '1234567aaaa';
const LATEST = '7654321bbbb';

function statusOf(state: string): Response {
    return Response.json({ state, commit: COMMIT, latest: LATEST, at: 'now' });
}

describe('AppUpdatePanel', () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it('shows both versions and starts an update only after the confirm', async () => {
        const fetchStub = vi.fn((_path: string, init?: RequestInit) => Promise.resolve(statusOf(init?.method === 'POST' ? 'running' : 'idle')));

        vi.stubGlobal('fetch', fetchStub);
        render(<AppUpdatePanel onClose={vi.fn()} pollMs={100000} />);

        expect(await screen.findByText('1234567'))
            .toBeTruthy();
        expect(screen.getByText('A new version is out.'))
            .toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: 'Update now' }));
        expect(fetchStub)
            .toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole('button', { name: 'Update' }));

        expect(await screen.findByText(/^Updating/))
            .toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Update now' }))
            .toBeNull();
    });

    it('keeps looking through a failed answer until the update ends', async () => {
        const answers = [
            () => Promise.resolve(statusOf('running')),
            () => Promise.reject(new Error('restarting')),
            () => Promise.resolve(statusOf('done')),
        ];
        const fetchStub = vi.fn(() => (answers.shift() ?? answers[0] ?? (() => Promise.resolve(statusOf('done'))))());

        vi.stubGlobal('fetch', fetchStub);
        render(<AppUpdatePanel onClose={vi.fn()} pollMs={5} />);

        expect(await screen.findByText('The last update finished.'))
            .toBeTruthy();
    });

    it('offers no update on a server without the service', async () => {
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(Response.json({ state: 'unavailable' }))));
        render(<AppUpdatePanel onClose={vi.fn()} />);

        await waitFor(() => {
            expect(screen.getByText(/cannot update from the web app/))
                .toBeTruthy();
        });
        expect(screen.queryByRole('button', { name: 'Update now' }))
            .toBeNull();
    });
});
