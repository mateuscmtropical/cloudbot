import type { Server } from 'node:http';

import type { WebSocket } from 'ws';

import type { SetupAccess } from '../access/SetupAccess.ts';
import type { BrowserControl } from './BrowserControl.ts';
import { ScreencastViewportCoordinator } from './ScreencastViewportCoordinator.ts';
import { attachSessionSocket } from './attachVncProxy.ts';
import type { ScreenHolder } from './ScreenHolder.ts';
import { ScreencastSession } from './screencast.ts';

interface ScreencastProxyOptions {
    server: Server;
    access: SetupAccess;
    hubSecret?: string | undefined;
    browser: BrowserControl;
    // Mouse and keyboard reach the page only while a person holds the screen.
    screen: ScreenHolder;
    // CLOUDBOT_PUBLIC_URL, when set. Its host may open the panel too.
    publicUrl?: string | undefined;
}

const SCREENCAST_PATH = '/api/desktop/screencast';

// The page is connected once the owner opens the panel. The session is kept until the panel closes,
// even when the panel closes before the page connects.
function bridgeToScreencast(webSocket: WebSocket, browser: BrowserControl, screen: ScreenHolder, viewportCoordinator: ScreencastViewportCoordinator): void {
    const viewportOwner = {};
    const sessionReady = browser.connectPage()
        .then(async (page) => {
            const session = new ScreencastSession({
                page,
                send: (message) => { webSocket.send(message); },
                isPersonHolding: () => screen.isPersonHolding,
                bufferedAmount: () => webSocket.bufferedAmount,
                requestViewport: size => viewportCoordinator.request(viewportOwner, page, size),
                restoreAllViewports: () => viewportCoordinator.restoreAll(),
                releaseViewport: () => viewportCoordinator.release(viewportOwner, page),
            });

            try {
                await session.start();
            } catch (error: unknown) {
                session.stop();

                throw error;
            }

            return session;
        });

    // When the screen goes to the bot, a button the owner still holds is released on the page.
    const stopListening = screen.onChange((isPersonHolding) => {
        if (!isPersonHolding) {
            sessionReady
                .then((session) => {
                    session.releaseHeldButton();
                    session.restoreViewport();
                })
                .catch(() => undefined);
        }
    });

    webSocket.on('message', (data: Buffer) => {
        const text = data.toString('utf8');

        sessionReady
            .then((session) => {
                session.handleInput(text);
            })
            .catch(() => undefined);
    });
    webSocket.on('close', () => {
        stopListening();
        sessionReady
            .then((session) => {
                session.stop();
            })
            .catch(() => undefined);
    });
    sessionReady.catch(() => {
        webSocket.close();
    });
}

// The live view of the bot's browser when there is no desktop, as in local mode.
function attachScreencast(options: ScreencastProxyOptions): void {
    const viewportCoordinator = new ScreencastViewportCoordinator();

    attachSessionSocket({
        server: options.server,
        access: options.access,
        hubSecret: options.hubSecret,
        path: SCREENCAST_PATH,
        publicUrl: options.publicUrl,
        accept: (webSocket) => {
            bridgeToScreencast(webSocket, options.browser, options.screen, viewportCoordinator);
        },
    });
}

export { SCREENCAST_PATH, attachScreencast };
export type { ScreencastProxyOptions };
