// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as apiClient from '../apiClient.ts';
import { DesktopPanel, buildVncUrl } from './DesktopPanel.tsx';

vi.mock('../apiClient.ts', () => ({
    getScreenHolder: vi.fn(() => Promise.resolve('bot')),
    getScreenView: vi.fn(() => Promise.resolve('vnc')),
    takeScreen: vi.fn(() => Promise.resolve('person')),
    releaseScreen: vi.fn(() => Promise.resolve('bot')),
}));

interface FakeClient {
    target: HTMLElement;
    url: string;
    viewOnly: boolean;
    disconnected: boolean;
    listeners: Record<string, () => void>;
}

const clients: FakeClient[] = [];

function clientAt(index: number): FakeClient {
    const client = clients[index];

    if (client === undefined) {
        throw new Error('No client was created.');
    }

    return client;
}

function fireClientEvent(index: number, type: string): void {
    const listener = clientAt(index).listeners[type];

    if (listener === undefined) {
        throw new Error('No listener was added.');
    }

    listener();
}

vi.mock('@novnc/novnc', () => ({
    default: class FakeRfb {
        public viewOnly = false;
        public scaleViewport = false;
        public disconnected = false;
        public listeners: Record<string, () => void> = {};

        public constructor(public target: HTMLElement, public url: string) {
            clients.push(this);
        }

        public addEventListener(type: string, listener: () => void): void {
            this.listeners[type] = listener;
        }

        public disconnect(): void {
            this.disconnected = true;
        }
    },
}));

describe('DesktopPanel in local mode', () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it('shows the browser frames over the screencast socket instead of VNC', async () => {
        const socketUrls: string[] = [];

        class FakeSocket {
            public constructor(url: string) {
                socketUrls.push(url);
            }

            public addEventListener(): void {
                // The frames are not needed for this check.
            }

            public close(): void {
                // Nothing to close in the fake.
            }
        }

        vi.stubGlobal('WebSocket', FakeSocket);
        vi.mocked(apiClient.getScreenView)
            .mockResolvedValueOnce('screencast');
        clients.length = 0;
        render(<DesktopPanel onClose={() => undefined} />);
        await waitFor(() => {
            expect(socketUrls)
                .toHaveLength(1);
        });

        expect(socketUrls[0]?.endsWith('/api/desktop/screencast'))
            .toBe(true);
        expect(clients)
            .toHaveLength(0);
    });
});

describe('buildVncUrl', () => {
    it('uses wss on https and ws on http', () => {
        expect(buildVncUrl({ protocol: 'https:', host: 'bot.example' } as Location))
            .toBe('wss://bot.example/api/desktop/vnc');
        expect(buildVncUrl({ protocol: 'http:', host: 'localhost:3000' } as Location))
            .toBe('ws://localhost:3000/api/desktop/vnc');
    });
});

describe('DesktopPanel', () => {
    beforeEach(() => {
        clients.length = 0;
        vi.mocked(apiClient.getScreenHolder)
            .mockResolvedValue('bot');
    });

    afterEach(() => {
        cleanup();
    });

    it('connects in view only mode and shows a status until connected', async () => {
        render(<DesktopPanel onClose={() => undefined} />);
        await waitFor(() => {
            expect(clients)
                .toHaveLength(1);
        });

        expect(clientAt(0).viewOnly)
            .toBe(true);
        expect(screen.getByText('Connecting to the screen...'))
            .toBeTruthy();

        act(() => {
            fireClientEvent(0, 'connect');
        });

        expect(screen.queryByText('Connecting to the screen...'))
            .toBeNull();
    });

    it('offers a retry after a disconnect and connects again', async () => {
        render(<DesktopPanel onClose={() => undefined} />);
        await waitFor(() => {
            expect(clients)
                .toHaveLength(1);
        });
        act(() => {
            fireClientEvent(0, 'disconnect');
        });

        expect(screen.getByRole('alert'))
            .toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

        expect(clients)
            .toHaveLength(2);
        expect(clientAt(0).disconnected)
            .toBe(true);
    });

    it('takes the screen, allows input and gives it back', async () => {
        render(<DesktopPanel onClose={() => undefined} />);

        expect(await screen.findByText('The bot has the screen. You can watch.'))
            .toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: 'Take the screen' }));

        expect(await screen.findByText('You have the screen. The bot is paused.'))
            .toBeTruthy();
        expect(clientAt(0).viewOnly)
            .toBe(false);

        fireEvent.click(screen.getByRole('button', { name: 'Done, take over' }));

        expect(await screen.findByText('The bot has the screen. You can watch.'))
            .toBeTruthy();
        expect(clientAt(0).viewOnly)
            .toBe(true);
        expect(apiClient.takeScreen)
            .toHaveBeenCalled();
        expect(apiClient.releaseScreen)
            .toHaveBeenCalled();
    });

    it('opens as the owner when the bot already handed the screen over', async () => {
        vi.mocked(apiClient.getScreenHolder)
            .mockResolvedValue('person');
        render(<DesktopPanel onClose={() => undefined} />);

        expect(await screen.findByText('You have the screen. The bot is paused.'))
            .toBeTruthy();
        expect(clientAt(0).viewOnly)
            .toBe(false);
    });

    it('connects again with input enabled when the owner holds the screen', async () => {
        vi.mocked(apiClient.getScreenHolder)
            .mockResolvedValue('person');
        render(<DesktopPanel onClose={() => undefined} />);
        await screen.findByText('You have the screen. The bot is paused.');
        await waitFor(() => {
            expect(clients)
                .toHaveLength(1);
        });
        act(() => {
            fireClientEvent(0, 'disconnect');
        });
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

        expect(clients)
            .toHaveLength(2);
        expect(clientAt(1).viewOnly)
            .toBe(false);
    });

    it('keeps the screen and closes the panel on I will keep it', async () => {
        vi.mocked(apiClient.getScreenHolder)
            .mockResolvedValue('person');

        const onClose = vi.fn();

        render(<DesktopPanel onClose={onClose} />);
        fireEvent.click(await screen.findByRole('button', { name: 'I will keep it' }));

        expect(onClose)
            .toHaveBeenCalled();
        expect(apiClient.releaseScreen).not.toHaveBeenCalled();
    });

    it('shows a problem when the screen cannot change hands', async () => {
        vi.mocked(apiClient.takeScreen)
            .mockRejectedValueOnce(new Error('offline'));
        render(<DesktopPanel onClose={() => undefined} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Take the screen' }));

        expect(await screen.findByText('The screen could not change hands. Try again.'))
            .toBeTruthy();
    });

    it('disconnects when closed', async () => {
        const onClose = vi.fn();
        const { unmount } = render(<DesktopPanel onClose={onClose} />);

        await waitFor(() => {
            expect(clients)
                .toHaveLength(1);
        });
        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        unmount();

        expect(onClose)
            .toHaveBeenCalled();
        expect(clientAt(0).disconnected)
            .toBe(true);
    });
});
