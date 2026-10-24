// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as apiClient from '../apiClient.ts';
import { DesktopPanel, buildVncUrl, buildVncViewportSize, shouldResizeDesktop } from './DesktopPanel.tsx';

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
    resizeSession: boolean;
    scaleViewport: boolean;
    disconnected: boolean;
    listeners: Record<string, () => void>;
    keys: number[];
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
        public resizeSession = false;
        public disconnected = false;
        public listeners: Record<string, () => void> = {};
        public keys: number[] = [];

        public constructor(public target: HTMLElement, public url: string) {
            clients.push(this);
        }

        public addEventListener(type: string, listener: () => void): void {
            this.listeners[type] = listener;
        }

        public disconnect(): void {
            this.disconnected = true;
        }

        public sendKey(keysym: number): void {
            this.keys.push(keysym);
        }
    },
}));

describe('DesktopPanel in local mode', () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it('restores the phone viewport after the screencast reconnects', async () => {
        const sockets: Array<{ sent: string[]; open: () => void; disconnect: () => void; url: string }> = [];

        class FakeSocket {
            public readyState = 0;
            public sent: string[] = [];
            private readonly listeners: Record<string, Array<() => void>> = {};

            public constructor(public url: string) {
                sockets.push(this);
            }

            public addEventListener(type: string, listener: () => void): void {
                this.listeners[type] ??= [];
                this.listeners[type].push(listener);
            }

            public close(): void {
                this.readyState = 3;
            }

            public send(message: string): void {
                this.sent.push(message);
            }

            public open(): void {
                this.readyState = 1;
                this.listeners.open?.forEach((listener) => {
                    listener();
                });
            }

            public disconnect(): void {
                this.readyState = 3;
                this.listeners.close?.forEach((listener) => {
                    listener();
                });
            }
        }

        vi.stubGlobal('WebSocket', Object.assign(FakeSocket, { OPEN: 1 }));
        vi.mocked(apiClient.getScreenView)
            .mockResolvedValueOnce('screencast');
        vi.mocked(apiClient.getScreenHolder)
            .mockResolvedValueOnce('person');
        clients.length = 0;
        render(<DesktopPanel onClose={() => undefined} />);
        await waitFor(() => {
            expect(sockets)
                .toHaveLength(1);
        });
        await screen.findByText('You have the screen. The bot is paused.');

        expect(sockets[0]?.url.endsWith('/api/desktop/screencast'))
            .toBe(true);
        expect(clients)
            .toHaveLength(0);

        const firstSocket = sockets[0];

        if (firstSocket === undefined) {
            throw new Error('No screencast socket was opened.');
        }

        firstSocket.open();
        expect(firstSocket.sent)
            .toEqual([JSON.stringify({ type: 'resize', width: 1280, height: 800 })]);
        firstSocket.disconnect();
        fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
        await waitFor(() => {
            expect(sockets)
                .toHaveLength(2);
        });

        const secondSocket = sockets[1];

        if (secondSocket === undefined) {
            throw new Error('The screencast socket did not reconnect.');
        }

        secondSocket.open();

        expect(secondSocket.sent)
            .toEqual([JSON.stringify({ type: 'resize', width: 1280, height: 800 })]);
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

describe('shouldResizeDesktop', () => {
    it('resizes only on a touch screen in a narrow portrait viewport', () => {
        expect(shouldResizeDesktop(390, true, true))
            .toBe(true);
        expect(shouldResizeDesktop(800, true, true))
            .toBe(false);
        expect(shouldResizeDesktop(390, true, false))
            .toBe(false);
        expect(shouldResizeDesktop(390, false, true))
            .toBe(false);
    });
});

describe('buildVncViewportSize', () => {
    it('keeps a phone viewport portrait while meeting Chromium minimum window width', () => {
        expect(buildVncViewportSize(390, 590, true))
            .toEqual({ width: 500, height: 756 });
    });

    it('leaves wide and view-only viewport sizes unchanged', () => {
        expect(buildVncViewportSize(720, 590, true))
            .toEqual({ width: 720, height: 590 });
        expect(buildVncViewportSize(390, 590, false))
            .toEqual({ width: 390, height: 590 });
    });

    it('uses the default size before the panel has layout dimensions', () => {
        expect(buildVncViewportSize(0, 0, true))
            .toEqual({ width: 1280, height: 800 });
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
        vi.unstubAllGlobals();
    });

    it('opens the keyboard of a phone and types on the screen with it', async () => {
        vi.stubGlobal('matchMedia', (query: string) => ({
            matches: query === '(pointer: coarse)',
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        }));
        vi.mocked(apiClient.getScreenHolder)
            .mockResolvedValue('person');
        render(<DesktopPanel onClose={() => undefined} />);
        await waitFor(() => {
            expect(clients)
                .toHaveLength(1);
        });

        const field = screen.getByLabelText<HTMLTextAreaElement>('Type on the screen');

        fireEvent.click(await screen.findByRole('button', { name: 'Keyboard' }));

        expect(document.activeElement)
            .toBe(field);

        field.value = ' hi';
        fireEvent.input(field);
        field.value = '';
        fireEvent.input(field);

        expect(clientAt(0).keys)
            .toEqual([0x68, 0x69, 0xFF08]);
        expect(field.value)
            .toBe(' ');
    });

    it('offers no keyboard button without a touch screen', async () => {
        vi.mocked(apiClient.getScreenHolder)
            .mockResolvedValue('person');
        render(<DesktopPanel onClose={() => undefined} />);
        await screen.findByText('You have the screen. The bot is paused.');

        expect(screen.queryByRole('button', { name: 'Keyboard' }))
            .toBeNull();
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
        await waitFor(() => {
            expect(clientAt(0).viewOnly)
                .toBe(true);
        });
        expect(clientAt(0).scaleViewport)
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

    it('resizes the VNC desktop to a phone portrait viewport while the owner holds it', async () => {
        vi.stubGlobal('matchMedia', (query: string) => ({
            matches: query === '(pointer: coarse)' || query === '(orientation: portrait)',
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        }));
        vi.stubGlobal('innerWidth', 390);
        vi.mocked(apiClient.getScreenHolder)
            .mockResolvedValue('person');

        const { container } = render(<DesktopPanel onClose={() => undefined} />);
        const viewportElement = container.querySelector('.desktop-screen');

        if (viewportElement === null) {
            throw new Error('The VNC viewport was not rendered.');
        }

        vi.spyOn(viewportElement, 'getBoundingClientRect')
            .mockReturnValue(new DOMRect(0, 0, 390, 590));

        await waitFor(() => {
            expect(clientAt(0).resizeSession)
                .toBe(true);
        });

        const targetElement = container.querySelector<HTMLDivElement>('.desktop-vnc-target');

        expect(targetElement?.style.width)
            .toBe('500px');
        expect(targetElement?.style.height)
            .toBe('756px');
        expect(clientAt(0).scaleViewport)
            .toBe(false);
        expect(container.querySelector('.desktop-screen.is-resizing'))
            .not.toBeNull();
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

    it('gives the screen back to the bot when the panel is closed', async () => {
        vi.mocked(apiClient.getScreenHolder)
            .mockResolvedValue('person');
        vi.mocked(apiClient.releaseScreen)
            .mockClear();

        const onClose = vi.fn();

        render(<DesktopPanel onClose={onClose} />);
        await screen.findByText('You have the screen. The bot is paused.');
        fireEvent.click(screen.getByRole('button', { name: 'Close' }));

        expect(onClose)
            .toHaveBeenCalled();
        expect(apiClient.releaseScreen)
            .toHaveBeenCalledTimes(1);
    });

    it('expands to fill the window and shrinks back', async () => {
        const { container } = render(<DesktopPanel onClose={() => undefined} />);
        const expandButton = await screen.findByRole('button', { name: 'Expand' });

        fireEvent.click(expandButton);

        expect(container.querySelector('.desktop-panel.is-expanded'))
            .not.toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'Shrink' }));

        expect(container.querySelector('.desktop-panel.is-expanded'))
            .toBeNull();
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
