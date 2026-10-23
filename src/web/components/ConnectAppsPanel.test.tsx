// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage } from '../../shared/chatTypes.ts';
import type { ConnectedAppSummary } from '../../shared/connectedApps.ts';
import { listConnectedApps, removeConnectedApp, startAppConnection } from '../apiClient.ts';
import { ConnectAppsPanel } from './ConnectAppsPanel.tsx';

vi.mock('../apiClient.ts', () => ({
    listConnectedApps: vi.fn(),
    removeConnectedApp: vi.fn(),
    startAppConnection: vi.fn(),
}));

const LINEAR: ConnectedAppSummary = { id: 'app-1', name: 'linear', url: 'https://mcp.linear.app/mcp', status: 'connected', toolCount: 4 };
const NOTION: ConnectedAppSummary = { id: 'app-2', name: 'notion', url: 'https://mcp.notion.com/mcp', status: 'needs_token', toolCount: 0 };
const CUSTOM: ConnectedAppSummary = { id: 'app-3', name: 'custom-example-com', url: 'https://mcp.example.com/mcp', status: 'failed', toolCount: 0, problem: 'Private details from the server.' };
const STARTED_MESSAGE: ChatMessage = {
    id: 'message-1',
    botId: 'bot-1',
    role: 'user',
    createdAt: 1,
    sequence: 1,
    body: { kind: 'text', text: 'Connect an app.' },
};

describe('ConnectAppsPanel', () => {
    afterEach(() => {
        cleanup();
    });

    it('shows the known apps with descriptions, icons, and connect buttons', async () => {
        vi.mocked(listConnectedApps)
            .mockResolvedValue([]);

        const { container } = render(<ConnectAppsPanel selectedBotId="bot-1" onClose={() => {}} />);

        expect(await screen.findByText('Linear'))
            .toBeTruthy();
        expect(screen.getByText('Find issues and update your team’s work.'))
            .toBeTruthy();
        expect(screen.getByText('Notion'))
            .toBeTruthy();
        expect(container.querySelectorAll('.connect-app-icon'))
            .toHaveLength(3);
        expect(screen.getByRole('button', { name: 'Connect Linear' }))
            .toBeTruthy();
        expect(screen.getByRole('button', { name: 'Connect Notion' }))
            .toBeTruthy();
        expect(container.textContent)
            .not.toMatch(/mcp/i);
        expect(container.textContent)
            .not.toContain('tools');
    });

    it('starts the selected app flow in the active bot chat', async () => {
        vi.mocked(listConnectedApps)
            .mockResolvedValue([]);
        vi.mocked(startAppConnection)
            .mockResolvedValue(STARTED_MESSAGE);
        const onClose = vi.fn();

        render(<ConnectAppsPanel selectedBotId="bot-1" onClose={onClose} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Connect Linear' }));

        await waitFor(() => {
            expect(startAppConnection)
                .toHaveBeenCalledWith('bot-1', 'linear', 'https://mcp.linear.app/mcp');
            expect(onClose)
                .toHaveBeenCalledTimes(1);
        });
    });

    it('starts a custom app flow from its address', async () => {
        vi.mocked(listConnectedApps)
            .mockResolvedValue([]);
        vi.mocked(startAppConnection)
            .mockResolvedValue(STARTED_MESSAGE);
        const onClose = vi.fn();

        render(<ConnectAppsPanel selectedBotId="bot-1" onClose={onClose} />);
        fireEvent.change(screen.getByLabelText('Connect any app by its address.'), { target: { value: 'https://example.com/mcp' } });
        fireEvent.click(screen.getByRole('button', { name: 'Connect custom app' }));

        await waitFor(() => {
            expect(startAppConnection)
                .toHaveBeenCalledWith('bot-1', 'custom-example-com', 'https://example.com/mcp');
            expect(onClose)
                .toHaveBeenCalledTimes(1);
        });
    });

    it('shows app state and remove buttons without exposing server details', async () => {
        vi.mocked(listConnectedApps)
            .mockResolvedValue([LINEAR, NOTION, CUSTOM]);

        const { container } = render(<ConnectAppsPanel selectedBotId="bot-1" onClose={() => {}} />);

        expect(await screen.findByText('Connected.'))
            .toBeTruthy();
        expect(screen.getByText('Sign-in needed. Finish in chat.'))
            .toBeTruthy();
        expect(screen.getByText('Could not connect. Open chat for details.'))
            .toBeTruthy();
        expect(screen.getByRole('button', { name: 'Remove Linear' }))
            .toBeTruthy();
        expect(screen.getByRole('button', { name: 'Remove Notion' }))
            .toBeTruthy();
        expect(screen.getByRole('button', { name: 'Remove example.com' }))
            .toBeTruthy();
        expect(container.textContent)
            .not.toMatch(/mcp/i);
        expect(container.textContent)
            .not.toContain('Private details from the server.');
        expect(container.textContent)
            .not.toContain('tools');
    });

    it('removes a connected app when the owner presses its remove button', async () => {
        vi.mocked(listConnectedApps)
            .mockResolvedValue([LINEAR]);
        vi.mocked(removeConnectedApp)
            .mockResolvedValue(undefined);

        render(<ConnectAppsPanel selectedBotId="bot-1" onClose={() => {}} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Remove Linear' }));

        await waitFor(() => {
            expect(screen.queryByText('Connected.'))
                .toBeNull();
        });
        expect(removeConnectedApp)
            .toHaveBeenCalledWith('app-1');
    });

    it('says when the connected apps cannot be loaded', async () => {
        vi.mocked(listConnectedApps)
            .mockRejectedValue(new Error('offline'));

        render(<ConnectAppsPanel selectedBotId="bot-1" onClose={() => {}} />);

        expect(await screen.findByText('The connected apps could not be loaded.'))
            .toBeTruthy();
    });

    it('calls onClose from the close button', () => {
        vi.mocked(listConnectedApps)
            .mockResolvedValue([]);
        const onClose = vi.fn();

        render(<ConnectAppsPanel selectedBotId="bot-1" onClose={onClose} />);
        fireEvent.click(screen.getByRole('button', { name: 'Close connect apps' }));

        expect(onClose)
            .toHaveBeenCalledTimes(1);
    });
});
