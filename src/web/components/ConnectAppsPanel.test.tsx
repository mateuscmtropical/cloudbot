// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage } from '../../shared/chatTypes.ts';
import type { ConnectedAppSummary } from '../../shared/connectedApps.ts';
import { listConnectedApps, removeConnectedApp, startAppConnection, startAppSignIn } from '../apiClient.ts';
import { APP_CATALOG, APP_CATEGORIES } from '../appCatalog.ts';
import { ConnectAppsPanel } from './ConnectAppsPanel.tsx';

vi.mock('../apiClient.ts', () => ({
    listConnectedApps: vi.fn(),
    removeConnectedApp: vi.fn(),
    startAppConnection: vi.fn(),
    startAppSignIn: vi.fn(),
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
    beforeEach(() => {
        vi.mocked(startAppSignIn)
            .mockResolvedValue({ status: 'unsupported' });
    });

    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
    });

    it('shows the catalog with category chips, a search field and a custom app row', async () => {
        vi.mocked(listConnectedApps)
            .mockResolvedValue([]);

        const { container } = render(<ConnectAppsPanel selectedBotId="bot-1" onClose={() => {}} />);

        expect(await screen.findByRole('region', { name: 'All apps' }))
            .toBeTruthy();
        expect(screen.getByText('Linear'))
            .toBeTruthy();
        expect(screen.getByText('Find issues and update team projects.'))
            .toBeTruthy();
        expect(screen.getByText('Notion'))
            .toBeTruthy();
        expect(screen.getByRole('region', { name: 'Custom' }))
            .toBeTruthy();
        expect(screen.getByRole('searchbox', { name: 'Search apps' }))
            .toBeTruthy();
        expect(screen.getByRole('button', { name: 'Show installed apps' }))
            .toBeTruthy();
        expect(screen.getByRole('button', { name: 'Add custom app' }))
            .toBeTruthy();
        expect(container.querySelectorAll('.connect-app-icon-app'))
            .toHaveLength(APP_CATALOG.length);
        expect(container.querySelectorAll('.connect-app-icon-custom'))
            .toHaveLength(1);
        expect(screen.getByRole('button', { name: 'All', pressed: true }))
            .toBeTruthy();
        expect(screen.getByRole('button', { name: 'Connect Linear' }))
            .toBeTruthy();
        expect(screen.getByRole('button', { name: 'Connect Notion' }))
            .toBeTruthy();
        expect(container.textContent)
            .not.toMatch(/mcp/i);
        expect(container.textContent)
            .not.toContain('tools');
    });

    it('gives every category a chip and shows only its apps when pressed', async () => {
        vi.mocked(listConnectedApps)
            .mockResolvedValue([]);

        render(<ConnectAppsPanel selectedBotId="bot-1" onClose={() => {}} />);
        await screen.findByRole('region', { name: 'All apps' });
        APP_CATEGORIES.forEach((category) => {
            expect(screen.getByRole('button', { name: category, pressed: false }))
                .toBeTruthy();
        });

        fireEvent.click(screen.getByRole('button', { name: 'Finance' }));

        expect(screen.getByRole('region', { name: 'Finance' }))
            .toBeTruthy();
        expect(screen.getByRole('button', { name: 'Finance', pressed: true }))
            .toBeTruthy();
        expect(screen.getByText('Stripe'))
            .toBeTruthy();
        expect(screen.queryByText('Linear'))
            .toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'All' }));

        expect(screen.getByRole('region', { name: 'All apps' }))
            .toBeTruthy();
        expect(screen.getByText('Linear'))
            .toBeTruthy();
    });

    it('filters apps by name, description and category', async () => {
        vi.mocked(listConnectedApps)
            .mockResolvedValue([]);

        render(<ConnectAppsPanel selectedBotId="bot-1" onClose={() => {}} />);
        const searchInput = await screen.findByRole('searchbox', { name: 'Search apps' });

        fireEvent.change(searchInput, { target: { value: 'notion' } });
        expect(screen.getByText('Notion'))
            .toBeTruthy();
        expect(screen.queryByText('Linear'))
            .toBeNull();

        fireEvent.change(searchInput, { target: { value: 'scheduled meetings' } });
        expect(screen.getByText('Calendly'))
            .toBeTruthy();
        expect(screen.queryByText('Notion'))
            .toBeNull();

        fireEvent.change(searchInput, { target: { value: 'finance' } });
        expect(screen.getByText('Stripe'))
            .toBeTruthy();
        expect(screen.queryByText('Calendly'))
            .toBeNull();

        fireEvent.change(searchInput, { target: { value: 'missing app' } });
        expect(screen.getByText('No apps match your search.'))
            .toBeTruthy();
    });

    it('combines the search with the chosen category', async () => {
        vi.mocked(listConnectedApps)
            .mockResolvedValue([]);

        render(<ConnectAppsPanel selectedBotId="bot-1" onClose={() => {}} />);
        await screen.findByRole('region', { name: 'All apps' });
        fireEvent.click(screen.getByRole('button', { name: 'Finance' }));
        fireEvent.change(screen.getByRole('searchbox', { name: 'Search apps' }), { target: { value: 'linear' } });

        expect(screen.queryByText('Linear'))
            .toBeNull();
        expect(screen.getByText('No apps match your search.'))
            .toBeTruthy();
    });

    it('can show only installed apps, also inside a category', async () => {
        vi.mocked(listConnectedApps)
            .mockResolvedValue([LINEAR]);

        render(<ConnectAppsPanel selectedBotId="bot-1" onClose={() => {}} />);

        expect(await screen.findByText('1 installed'))
            .toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Show installed apps' }));

        expect(screen.getByText('Linear'))
            .toBeTruthy();
        expect(screen.queryByText('Notion'))
            .toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'Design' }));

        expect(screen.queryByText('Linear'))
            .toBeNull();
        expect(screen.getByText('No apps match your search.'))
            .toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: 'Productivity' }));

        expect(screen.getByText('Linear'))
            .toBeTruthy();
        expect(screen.queryByText('Notion'))
            .toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'Show all apps' }));

        expect(screen.getByText('Notion'))
            .toBeTruthy();
    });

    it('connects an app from the catalog with its own name and address', async () => {
        vi.mocked(listConnectedApps)
            .mockResolvedValue([]);

        render(<ConnectAppsPanel selectedBotId="bot-1" onClose={() => {}} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Connect Todoist' }));

        await waitFor(() => {
            expect(startAppSignIn)
                .toHaveBeenCalledWith('bot-1', 'todoist', 'https://ai.todoist.net/mcp');
        });
    });
    it('opens the sign-in page of the app when it has one', async () => {
        vi.mocked(listConnectedApps)
            .mockResolvedValue([]);
        vi.mocked(startAppSignIn)
            .mockResolvedValue({ status: 'redirect', authorizationUrl: 'https://mcp.notion.com/authorize?state=s1' });
        const assign = vi.fn();

        vi.stubGlobal('location', { assign });
        render(<ConnectAppsPanel selectedBotId="bot-1" onClose={() => {}} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Connect Notion' }));

        await waitFor(() => {
            expect(assign)
                .toHaveBeenCalledWith('https://mcp.notion.com/authorize?state=s1');
        });
        expect(startAppSignIn)
            .toHaveBeenCalledWith('bot-1', 'notion', 'https://mcp.notion.com/mcp');
        expect(startAppConnection)
            .not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it('says why the sign-in could not start, and stays on the list', async () => {
        vi.mocked(listConnectedApps)
            .mockResolvedValue([]);
        vi.mocked(startAppSignIn)
            .mockResolvedValue({ status: 'failed', problem: 'The app did not accept the sign-in. Try again later.' });
        const onClose = vi.fn();

        render(<ConnectAppsPanel selectedBotId="bot-1" onClose={onClose} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Connect Linear' }));

        expect(await screen.findByRole('alert'))
            .toBeTruthy();
        expect(screen.getByText('The app did not accept the sign-in. Try again later.'))
            .toBeTruthy();
        expect(onClose)
            .not.toHaveBeenCalled();
    });

    it('shows what happened when the owner came back from a sign-in page', async () => {
        vi.mocked(listConnectedApps)
            .mockResolvedValue([]);

        render(<ConnectAppsPanel selectedBotId="bot-1" onClose={() => {}} notice="Notion is connected." />);

        expect(await screen.findByRole('status'))
            .toBeTruthy();
        expect(screen.getByText('Notion is connected.'))
            .toBeTruthy();
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

    it('starts a custom app flow from the add row', async () => {
        vi.mocked(listConnectedApps)
            .mockResolvedValue([]);
        vi.mocked(startAppConnection)
            .mockResolvedValue(STARTED_MESSAGE);
        const onClose = vi.fn();

        render(<ConnectAppsPanel selectedBotId="bot-1" onClose={onClose} />);
        expect(screen.queryByLabelText('Connect any app by its address.'))
            .toBeNull();
        fireEvent.click(await screen.findByRole('button', { name: 'Add custom app' }));
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

        expect(await screen.findByText('3 installed'))
            .toBeTruthy();
        expect(screen.getByText('Connected.'))
            .toBeTruthy();
        expect(screen.getByText('Sign-in needed.'))
            .toBeTruthy();
        expect(screen.getByText('Could not connect.'))
            .toBeTruthy();
        expect(screen.getByRole('button', { name: 'Remove Linear' }))
            .toBeTruthy();
        expect(screen.getByRole('button', { name: 'Connect Notion' }))
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
