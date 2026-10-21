// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConnectedAppSummary } from '../../shared/connectedApps.ts';
import { listConnectedApps, removeConnectedApp } from '../apiClient.ts';
import { ConnectAppsPanel } from './ConnectAppsPanel.tsx';

vi.mock('../apiClient.ts', () => ({
    listConnectedApps: vi.fn(),
    removeConnectedApp: vi.fn(),
}));

const LINEAR: ConnectedAppSummary = { id: 'app-1', name: 'linear', url: 'https://mcp.linear.app/mcp', status: 'connected', toolCount: 4 };
const NOTION: ConnectedAppSummary = { id: 'app-2', name: 'notion', url: 'https://mcp.notion.com/mcp', status: 'needs_token', toolCount: 0 };

describe('ConnectAppsPanel', () => {
    afterEach(() => {
        cleanup();
    });

    it('lists each server with its status and tool count', async () => {
        vi.mocked(listConnectedApps)
            .mockResolvedValue([LINEAR, NOTION]);

        render(<ConnectAppsPanel onClose={() => {}} />);

        expect(await screen.findByText('linear'))
            .toBeTruthy();
        expect(screen.getByText('Connected. 4 tools.'))
            .toBeTruthy();
        expect(screen.getByText('Needs a token. 0 tools.'))
            .toBeTruthy();
    });

    it('removes a server when the owner presses its remove button', async () => {
        vi.mocked(listConnectedApps)
            .mockResolvedValue([LINEAR, NOTION]);
        vi.mocked(removeConnectedApp)
            .mockResolvedValue(undefined);

        render(<ConnectAppsPanel onClose={() => {}} />);

        fireEvent.click(await screen.findByRole('button', { name: 'Remove linear' }));

        await waitFor(() => {
            expect(screen.queryByText('linear'))
                .toBeNull();
        });
        expect(removeConnectedApp)
            .toHaveBeenCalledWith('app-1');
    });

    it('says when the servers cannot be loaded', async () => {
        vi.mocked(listConnectedApps)
            .mockRejectedValue(new Error('offline'));

        render(<ConnectAppsPanel onClose={() => {}} />);

        expect(await screen.findByText('The connected servers could not be loaded.'))
            .toBeTruthy();
    });

    it('calls onClose from the close button', () => {
        vi.mocked(listConnectedApps)
            .mockResolvedValue([]);
        const onClose = vi.fn();

        render(<ConnectAppsPanel onClose={onClose} />);
        fireEvent.click(screen.getByRole('button', { name: 'Close connect apps' }));

        expect(onClose)
            .toHaveBeenCalledTimes(1);
    });
});
