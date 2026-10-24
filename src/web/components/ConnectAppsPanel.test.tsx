// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage } from '../../shared/chatTypes.ts';
import type { ConnectedAppSummary } from '../../shared/connectedApps.ts';
import { GOOGLE_APPS, GOOGLE_GUIDE_URL } from '../../shared/googleApps.ts';
import { getBitwardenStatus, listConnectedApps, removeConnectedApp, startAppConnection, startAppSignIn } from '../apiClient.ts';
import { APP_CATALOG, APP_CATEGORIES } from '../appCatalog.ts';
import { APP_SIGN_IN_CHANNEL } from '../appReturn.ts';
import { APP_LOGOS } from '../appLogos.ts';
import { ConnectAppsPanel } from './ConnectAppsPanel.tsx';

vi.mock('../apiClient.ts', () => ({
    listConnectedApps: vi.fn(),
    removeConnectedApp: vi.fn(),
    startAppConnection: vi.fn(),
    startAppSignIn: vi.fn(),
    getBitwardenStatus: vi.fn(),
    saveBitwardenAccount: vi.fn(),
    forgetBitwardenAccount: vi.fn(),
    testBitwardenAccount: vi.fn(),
}));

const LINEAR: ConnectedAppSummary = { id: 'app-1', name: 'linear', url: 'https://mcp.linear.app/mcp', status: 'connected', toolCount: 4 };
const NOTION: ConnectedAppSummary = { id: 'app-2', name: 'notion', url: 'https://mcp.notion.com/mcp', status: 'needs_token', toolCount: 0 };
const CUSTOM: ConnectedAppSummary = { id: 'app-3', name: 'custom-example-com', url: 'https://mcp.example.com/mcp', status: 'failed', toolCount: 0, problem: 'Private details from the server.' };
const GOOGLE_CARD_NAMES = ['Gmail', 'Google Calendar', 'Google Drive', 'Google Docs', 'Google Sheets'];
const GMAIL_CONNECTED: ConnectedAppSummary = { id: 'google-gmail-id', name: 'google-gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1', status: 'connected', toolCount: 3 };
const NOTION_CONNECTED: ConnectedAppSummary = { ...NOTION, status: 'connected', toolCount: 3 };
const STARTED_MESSAGE: ChatMessage = {
    id: 'message-1',
    botId: 'bot-1',
    role: 'user',
    createdAt: 1,
    sequence: 1,
    body: { kind: 'text', text: 'Connect an app.' },
};

interface FakeSignInWindow {
    location: { href: string };
    closed: boolean;
    close: () => void;
}

function createSignInWindow(): FakeSignInWindow {
    return { location: { href: '' }, closed: true, close: vi.fn() };
}

const openWindow = vi.fn<() => Window | null>();
const NOTION_SIGN_IN = { status: 'redirect', authorizationUrl: 'https://mcp.notion.com/authorize?state=s1' } as const;

describe('ConnectAppsPanel', () => {
    beforeEach(() => {
        vi.mocked(startAppSignIn)
            .mockResolvedValue({ status: 'unsupported' });
        openWindow.mockImplementation(() => createSignInWindow() as unknown as Window);
        vi.stubGlobal('open', openWindow);
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
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
        const logoCount = Object.keys(APP_LOGOS).length;

        expect(container.querySelectorAll('.connect-app-icon-logo'))
            .toHaveLength(logoCount);
        expect(container.querySelectorAll('.connect-app-icon-app'))
            .toHaveLength(APP_CATALOG.length - logoCount);
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

    it('shows the logo of an app that has one and the initial of an app that does not', async () => {
        vi.mocked(listConnectedApps)
            .mockResolvedValue([]);

        render(<ConnectAppsPanel selectedBotId="bot-1" onClose={() => {}} />);
        await screen.findByRole('region', { name: 'All apps' });

        const linearRow = screen.getByText('Linear')
            .closest('.connect-app-card');
        const granolaRow = screen.getByText('Granola')
            .closest('.connect-app-card');
        const linearIcon = linearRow?.querySelector('.connect-app-icon');
        const granolaIcon = granolaRow?.querySelector('.connect-app-icon');

        expect(linearIcon?.querySelector('svg path')
            ?.getAttribute('d'))
            .toBe(APP_LOGOS.linear?.path);
        expect(linearIcon?.textContent)
            .toBe('');
        expect(granolaIcon?.querySelector('svg'))
            .toBeNull();
        expect(granolaIcon?.textContent)
            .toBe('G');
    });
    it('lists the catalog apps alphabetically by name', async () => {
        vi.mocked(listConnectedApps)
            .mockResolvedValue([]);

        const { container } = render(<ConnectAppsPanel selectedBotId="bot-1" onClose={() => {}} />);

        await screen.findByRole('region', { name: 'All apps' });

        const cardTitles = Array.from(container.querySelectorAll('.connect-app-card-title'))
            .map(title => title.textContent);
        const sortedTitles = [...cardTitles]
            .sort((first, second) => first.localeCompare(second, 'en', { sensitivity: 'base' }));

        expect(cardTitles)
            .toHaveLength(APP_CATALOG.length);
        expect(cardTitles)
            .toEqual(sortedTitles);
        expect(cardTitles[0])
            .toBe('Airtable');
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

    it('opens a window on the click and sends it to the sign-in page of the app', async () => {
        const signInWindow = createSignInWindow();
        let resolveSignIn: (value: typeof NOTION_SIGN_IN) => void = () => undefined;

        vi.mocked(listConnectedApps)
            .mockResolvedValue([]);
        openWindow
            .mockReturnValue(signInWindow as unknown as Window);
        vi.mocked(startAppSignIn)
            .mockReturnValue(new Promise((resolve) => {
                resolveSignIn = resolve;
            }));
        const assign = vi.fn();

        vi.stubGlobal('location', { assign });
        render(<ConnectAppsPanel selectedBotId="bot-1" onClose={() => {}} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Connect Notion' }));

        expect(openWindow)
            .toHaveBeenCalledWith('', '_blank');
        expect(signInWindow.location.href)
            .toBe('');

        await act(async () => {
            resolveSignIn(NOTION_SIGN_IN);
            await Promise.resolve();
        });

        expect(signInWindow.location.href)
            .toBe('https://mcp.notion.com/authorize?state=s1');
        expect(assign)
            .not.toHaveBeenCalled();
        expect(startAppSignIn)
            .toHaveBeenCalledWith('bot-1', 'notion', 'https://mcp.notion.com/mcp');
        expect(startAppConnection)
            .not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it('shows that it waits for the other window and keeps the button disabled', async () => {
        vi.mocked(listConnectedApps)
            .mockResolvedValue([]);
        vi.mocked(startAppSignIn)
            .mockResolvedValue(NOTION_SIGN_IN);

        render(<ConnectAppsPanel selectedBotId="bot-1" onClose={() => {}} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Connect Notion' }));

        expect(await screen.findByText('Finish signing in to Notion in the other window.'))
            .toBeTruthy();
        const waitingButton = screen.getByRole('button', { name: 'Connect Notion' });

        expect(waitingButton.textContent)
            .toBe('Waiting...');
        expect((waitingButton as HTMLButtonElement).disabled)
            .toBe(true);
    });

    it('signs in on this window when the browser blocks the new one', async () => {
        vi.mocked(listConnectedApps)
            .mockResolvedValue([]);
        openWindow
            .mockReturnValue(null);
        vi.mocked(startAppSignIn)
            .mockResolvedValue(NOTION_SIGN_IN);
        const assign = vi.fn();

        vi.stubGlobal('location', { assign });
        render(<ConnectAppsPanel selectedBotId="bot-1" onClose={() => {}} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Connect Notion' }));

        await waitFor(() => {
            expect(assign)
                .toHaveBeenCalledWith('https://mcp.notion.com/authorize?state=s1');
        });
        vi.unstubAllGlobals();
    });

    it('closes the new window when the sign-in cannot start', async () => {
        const signInWindow = createSignInWindow();

        vi.mocked(listConnectedApps)
            .mockResolvedValue([]);
        openWindow
            .mockReturnValue(signInWindow as unknown as Window);
        vi.mocked(startAppSignIn)
            .mockResolvedValue({ status: 'failed', problem: 'The app did not accept the sign-in. Try again later.' });

        render(<ConnectAppsPanel selectedBotId="bot-1" onClose={() => {}} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Connect Linear' }));

        expect(await screen.findByRole('alert'))
            .toBeTruthy();
        expect(signInWindow.close)
            .toHaveBeenCalledTimes(1);
    });

    it('closes the new window before the chat fallback when the app has no sign-in page', async () => {
        const signInWindow = createSignInWindow();

        vi.mocked(listConnectedApps)
            .mockResolvedValue([]);
        openWindow
            .mockReturnValue(signInWindow as unknown as Window);
        vi.mocked(startAppConnection)
            .mockResolvedValue(STARTED_MESSAGE);

        render(<ConnectAppsPanel selectedBotId="bot-1" onClose={() => {}} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Connect Linear' }));

        await waitFor(() => {
            expect(startAppConnection)
                .toHaveBeenCalledTimes(1);
        });
        expect(signInWindow.close)
            .toHaveBeenCalledTimes(1);
    });

    it('closes the new window when the request throws', async () => {
        const signInWindow = createSignInWindow();

        vi.mocked(listConnectedApps)
            .mockResolvedValue([]);
        openWindow
            .mockReturnValue(signInWindow as unknown as Window);
        vi.mocked(startAppSignIn)
            .mockRejectedValue(new Error('offline'));

        render(<ConnectAppsPanel selectedBotId="bot-1" onClose={() => {}} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Connect Linear' }));

        expect(await screen.findByText('The connection could not be started. Try again.'))
            .toBeTruthy();
        expect(signInWindow.close)
            .toHaveBeenCalledTimes(1);
    });

    it('cancels the wait, enables Connect again and reloads the list', async () => {
        vi.mocked(listConnectedApps)
            .mockResolvedValue([]);
        vi.mocked(startAppSignIn)
            .mockResolvedValue(NOTION_SIGN_IN);

        render(<ConnectAppsPanel selectedBotId="bot-1" onClose={() => {}} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Connect Notion' }));
        await screen.findByText('Finish signing in to Notion in the other window.');
        expect(listConnectedApps)
            .toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));

        expect(screen.queryByText('Finish signing in to Notion in the other window.'))
            .toBeNull();
        const connectButton = screen.getByRole('button', { name: 'Connect Notion' });

        expect(connectButton.textContent)
            .toBe('Connect');
        expect((connectButton as HTMLButtonElement).disabled)
            .toBe(false);
        await waitFor(() => {
            expect(listConnectedApps)
                .toHaveBeenCalledTimes(2);
        });
    });

    it('stops waiting after ten minutes, when the server has forgotten the sign-in', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.mocked(listConnectedApps)
            .mockResolvedValue([]);
        vi.mocked(startAppSignIn)
            .mockResolvedValue(NOTION_SIGN_IN);

        try {
            render(<ConnectAppsPanel selectedBotId="bot-1" onClose={() => {}} />);
            fireEvent.click(await screen.findByRole('button', { name: 'Connect Notion' }));
            await screen.findByText('Finish signing in to Notion in the other window.');

            await act(async () => {
                await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
            });
            expect(screen.getByText('Finish signing in to Notion in the other window.'))
                .toBeTruthy();

            await act(async () => {
                await vi.advanceTimersByTimeAsync(60 * 1000);
            });
            expect(screen.queryByText('Finish signing in to Notion in the other window.'))
                .toBeNull();
            expect(screen.getByRole('button', { name: 'Connect Notion' }).textContent)
                .toBe('Connect');
            expect(listConnectedApps)
                .toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('reloads the list and shows what happened when the other window reports back', async () => {
        vi.mocked(listConnectedApps)
            .mockResolvedValueOnce([])
            .mockResolvedValue([NOTION_CONNECTED]);
        vi.mocked(startAppSignIn)
            .mockResolvedValue(NOTION_SIGN_IN);

        render(<ConnectAppsPanel selectedBotId="bot-1" onClose={() => {}} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Connect Notion' }));
        await screen.findByText('Finish signing in to Notion in the other window.');

        const channel = new BroadcastChannel(APP_SIGN_IN_CHANNEL);

        channel.postMessage({ apps: 'connected', app: 'notion', bot: 'bot-1' });
        channel.close();

        expect(await screen.findByText('Notion is connected.'))
            .toBeTruthy();
        expect(screen.queryByText('Finish signing in to Notion in the other window.'))
            .toBeNull();
        expect(await screen.findByRole('button', { name: 'Remove Notion' }))
            .toBeTruthy();
    });

    it('ignores the channel when it is not waiting for a sign-in', async () => {
        vi.mocked(listConnectedApps)
            .mockResolvedValue([]);

        render(<ConnectAppsPanel selectedBotId="bot-1" onClose={() => {}} />);
        await screen.findByRole('button', { name: 'Connect Notion' });

        const channel = new BroadcastChannel(APP_SIGN_IN_CHANNEL);

        channel.postMessage({ apps: 'connected', app: 'notion', bot: 'bot-1' });
        await new Promise((resolve) => {
            setTimeout(resolve, 50);
        });
        channel.close();

        expect(screen.queryByText('Notion is connected.'))
            .toBeNull();
        expect(listConnectedApps)
            .toHaveBeenCalledTimes(1);
    });

    it('shows a separate card for each Google app and no single Google card', async () => {
        vi.mocked(listConnectedApps)
            .mockResolvedValue([]);

        render(<ConnectAppsPanel selectedBotId="bot-1" onClose={() => {}} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Productivity' }));

        GOOGLE_CARD_NAMES.forEach((displayName) => {
            expect(screen.getByRole('button', { name: `Connect ${displayName}` }))
                .toBeTruthy();
        });
        GOOGLE_APPS.forEach((app) => {
            expect(screen.getByText(app.description))
                .toBeTruthy();
        });
        expect(screen.queryByRole('button', { name: 'Connect Google' }))
            .toBeNull();
        expect(screen.queryByRole('button', { name: 'Google setup' }))
            .toBeNull();
    });

    it('gives every Google card a logo', () => {
        GOOGLE_APPS.forEach((app) => {
            expect(APP_LOGOS[app.serverName]?.path.length)
                .toBeGreaterThan(0);
        });
    });

    it('opens the sign-in page right away for the Google card that was clicked, with no form', async () => {
        const signInWindow = createSignInWindow();

        vi.mocked(listConnectedApps)
            .mockResolvedValue([]);
        openWindow
            .mockReturnValue(signInWindow as unknown as Window);
        vi.mocked(startAppSignIn)
            .mockResolvedValue({ status: 'redirect', authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=s1' });

        render(<ConnectAppsPanel selectedBotId="bot-1" onClose={() => {}} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Connect Google Calendar' }));

        await waitFor(() => {
            expect(signInWindow.location.href)
                .toBe('https://accounts.google.com/o/oauth2/v2/auth?state=s1');
        });
        expect(startAppSignIn)
            .toHaveBeenCalledWith('bot-1', 'google-calendar', 'https://calendarmcp.googleapis.com/mcp/v1');
        expect(screen.queryByRole('region', { name: 'Google setup' }))
            .toBeNull();
        expect(screen.queryByText(/Google is not set up/))
            .toBeNull();
    });

    it('says Google is not set up, with the guide link, and closes the window when the server has no client', async () => {
        const signInWindow = createSignInWindow();

        vi.mocked(listConnectedApps)
            .mockResolvedValue([]);
        openWindow
            .mockReturnValue(signInWindow as unknown as Window);
        vi.mocked(startAppSignIn)
            .mockResolvedValue({ status: 'google_not_configured' });

        render(<ConnectAppsPanel selectedBotId="bot-1" onClose={() => {}} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Connect Gmail' }));

        const message = await screen.findByText(/Google is not set up on this server yet\. The admin adds a Google client once, see the/);
        const link = screen.getByRole('link', { name: 'Google guide' });

        expect(message.textContent)
            .toBe('Google is not set up on this server yet. The admin adds a Google client once, see the Google guide.');
        expect(link.getAttribute('href'))
            .toBe(GOOGLE_GUIDE_URL);
        expect(GOOGLE_GUIDE_URL)
            .toBe('https://github.com/mateuscmtropical/cloudbot/blob/main/docs/GOOGLE.md');
        expect(signInWindow.close)
            .toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('region', { name: 'Google setup' }))
            .toBeNull();
        expect(startAppConnection)
            .not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Connect Gmail' })
            .hasAttribute('disabled'))
            .toBe(false);
    });

    it('hides the not set up line again on the next attempt', async () => {
        vi.mocked(listConnectedApps)
            .mockResolvedValue([]);
        vi.mocked(startAppSignIn)
            .mockResolvedValueOnce({ status: 'google_not_configured' })
            .mockResolvedValue({ status: 'redirect', authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=s1' });

        render(<ConnectAppsPanel selectedBotId="bot-1" onClose={() => {}} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Connect Gmail' }));
        await screen.findByText(/Google is not set up/);
        fireEvent.click(screen.getByRole('button', { name: 'Connect Gmail' }));

        await waitFor(() => {
            expect(screen.queryByText(/Google is not set up/))
                .toBeNull();
        });
    });

    it('shows Connected and Remove on the Google card that is connected, and removes only that one', async () => {
        vi.mocked(listConnectedApps)
            .mockResolvedValue([GMAIL_CONNECTED]);
        vi.mocked(removeConnectedApp)
            .mockResolvedValue(undefined);

        render(<ConnectAppsPanel selectedBotId="bot-1" onClose={() => {}} />);

        expect(await screen.findByText('1 installed'))
            .toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Connect Gmail' }))
            .toBeNull();
        expect(screen.getByRole('button', { name: 'Connect Google Drive' }))
            .toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: 'Remove Gmail' }));

        expect(await screen.findByRole('button', { name: 'Connect Gmail' }))
            .toBeTruthy();
        expect(removeConnectedApp)
            .toHaveBeenCalledTimes(1);
        expect(removeConnectedApp)
            .toHaveBeenCalledWith('google-gmail-id');
        expect(screen.getByText('0 installed'))
            .toBeTruthy();
    });

    it('keeps the rows of the Google apps out of the Custom list', async () => {
        vi.mocked(listConnectedApps)
            .mockResolvedValue([GMAIL_CONNECTED, CUSTOM]);

        render(<ConnectAppsPanel selectedBotId="bot-1" onClose={() => {}} />);

        expect(await screen.findByRole('button', { name: 'Remove example.com' }))
            .toBeTruthy();
        expect(screen.getByText('2 installed'))
            .toBeTruthy();
        expect(screen.queryByRole('button', { name: /Remove gmailmcp/ }))
            .toBeNull();
    });
    it('shows a Bitwarden card that opens the setup form instead of a connection', async () => {
        vi.mocked(listConnectedApps)
            .mockResolvedValue([]);
        vi.mocked(getBitwardenStatus)
            .mockResolvedValue({ configured: false, serverUrl: '' });

        render(<ConnectAppsPanel selectedBotId="bot-1" onClose={() => {}} />);

        expect(await screen.findByText('Bitwarden'))
            .toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Connect Bitwarden' }))
            .toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'Set up Bitwarden' }));

        expect(await screen.findByRole('region', { name: 'Bitwarden setup' }))
            .toBeTruthy();
        expect(startAppSignIn)
            .not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: 'Close Bitwarden setup' }));

        expect(screen.queryByRole('region', { name: 'Bitwarden setup' }))
            .toBeNull();
    });

    it('turns the Bitwarden button off until a bot is chosen', async () => {
        vi.mocked(listConnectedApps)
            .mockResolvedValue([]);

        render(<ConnectAppsPanel selectedBotId={undefined} onClose={() => {}} />);

        const button = await screen.findByRole('button', { name: 'Set up Bitwarden' });

        expect((button as HTMLButtonElement).disabled)
            .toBe(true);
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
