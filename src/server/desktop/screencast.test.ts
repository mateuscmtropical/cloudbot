import { describe, expect, it } from 'vitest';

import type { CdpEventListener } from './CdpConnection.ts';
import { ScreencastSession, parseScreencastInput } from './screencast.ts';
import type { ScreencastPage } from './screencast.ts';

interface FakeCall {
    method: string;
    params: Record<string, unknown>;
}

interface FakePage extends ScreencastPage {
    calls: FakeCall[];
    emit: (method: string, params: unknown) => void;
    isClosed: () => boolean;
}

// Records each call. A call returns at once, so the order of the calls is the order they were sent.
function createFakePage(): FakePage {
    const calls: FakeCall[] = [];
    let listener: CdpEventListener | undefined;
    let isClosed = false;

    return {
        calls,
        call: (method: string, params?: Record<string, unknown>) => {
            calls.push({ method, params: params ?? {} });

            return Promise.resolve(undefined);
        },
        onEvent: (nextListener: CdpEventListener) => {
            listener = nextListener;
        },
        close: () => {
            isClosed = true;
        },
        emit: (method: string, params: unknown) => {
            listener?.(method, params);
        },
        isClosed: () => isClosed,
    };
}

// Lets the queued promises run, so the inputs have reached the fake page.
function settle(): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
}

function createSession(page: FakePage, options: { isPersonHolding?: boolean; bufferedAmount?: number } = {}): { session: ScreencastSession; sent: string[] } {
    const sent: string[] = [];
    const session = new ScreencastSession({
        page,
        send: (message: string) => {
            sent.push(message);
        },
        isPersonHolding: () => options.isPersonHolding ?? true,
        bufferedAmount: () => options.bufferedAmount ?? 0,
    });

    return { session, sent };
}

describe('parseScreencastInput', () => {
    it('reads a known input', () => {
        expect(parseScreencastInput(JSON.stringify({ type: 'mouse', kind: 'down', x: 10, y: 20 })))
            .toEqual({ type: 'mouse', kind: 'down', x: 10, y: 20 });
    });

    it('accepts bounded integer viewport sizes', () => {
        expect(parseScreencastInput(JSON.stringify({ type: 'resize', width: 400, height: 800 })))
            .toEqual({ type: 'resize', width: 400, height: 800 });
    });

    it('drops a viewport size outside the allowed bounds', () => {
        expect(parseScreencastInput(JSON.stringify({ type: 'resize', width: 400, height: 1921 })))
            .toBeUndefined();
        expect(parseScreencastInput(JSON.stringify({ type: 'resize', width: 400.5, height: 800 })))
            .toBeUndefined();
    });

    it('accepts a click on a page larger than the 1280 by 800 frame', () => {
        expect(parseScreencastInput(JSON.stringify({ type: 'mouse', kind: 'down', x: 1900, y: 1200 })))
            .toEqual({ type: 'mouse', kind: 'down', x: 1900, y: 1200 });
        expect(parseScreencastInput(JSON.stringify({ type: 'wheel', x: 1900, y: 1200, deltaY: 40 })))
            .toEqual({ type: 'wheel', x: 1900, y: 1200, deltaY: 40 });
    });

    it('drops a point outside the page limit, a negative point, or an unknown type', () => {
        expect(parseScreencastInput(JSON.stringify({ type: 'mouse', kind: 'down', x: 10001, y: 20 })))
            .toBeUndefined();
        expect(parseScreencastInput(JSON.stringify({ type: 'mouse', kind: 'down', x: -1, y: 20 })))
            .toBeUndefined();
        expect(parseScreencastInput(JSON.stringify({ type: 'key', key: 'F12' })))
            .toBeUndefined();
        expect(parseScreencastInput('not json'))
            .toBeUndefined();
    });
});

describe('ScreencastSession', () => {
    it('starts the screencast with room for the largest allowed viewport', async () => {
        const page = createFakePage();
        const { session } = createSession(page);

        await session.start();

        expect(page.calls.map(call => call.method))
            .toEqual(['Page.enable', 'Page.startScreencast']);
        expect(page.calls[1]?.params)
            .toMatchObject({ format: 'jpeg', maxWidth: 1920, maxHeight: 1920 });
    });

    it('sends each frame to the panel and acknowledges it', async () => {
        const page = createFakePage();
        const { session, sent } = createSession(page);

        await session.start();
        page.emit('Page.screencastFrame', { data: 'AAAA', sessionId: 7, metadata: { deviceWidth: 1280, deviceHeight: 800 } });
        await settle();

        expect(sent)
            .toEqual([JSON.stringify({ type: 'frame', data: 'AAAA', width: 1280, height: 800 })]);
        expect(page.calls.at(-1))
            .toEqual({ method: 'Page.screencastFrameAck', params: { sessionId: 7 } });
    });

    it('drops a frame, but still acknowledges it, while the panel is behind', async () => {
        const page = createFakePage();
        const { session, sent } = createSession(page, { bufferedAmount: 10_000_000 });

        await session.start();
        page.emit('Page.screencastFrame', { data: 'AAAA', sessionId: 1, metadata: { deviceWidth: 1280, deviceHeight: 800 } });
        await settle();

        expect(sent)
            .toEqual([]);
        expect(page.calls.at(-1)?.method)
            .toBe('Page.screencastFrameAck');
    });

    it('sends the owner input to the page, in order', async () => {
        const page = createFakePage();
        const { session } = createSession(page);

        await session.start();
        session.handleInput(JSON.stringify({ type: 'mouse', kind: 'down', x: 10, y: 20 }));
        session.handleInput(JSON.stringify({ type: 'mouse', kind: 'up', x: 10, y: 20 }));
        session.handleInput(JSON.stringify({ type: 'text', text: 'hi' }));
        await settle();

        const inputMethods = page.calls.slice(2)
            .map((call) => {
                const kind = call.params.type;

                return `${call.method}:${typeof kind === 'string' ? kind : ''}`;
            });

        expect(inputMethods)
            .toEqual([
                'Input.dispatchMouseEvent:mousePressed',
                'Input.dispatchMouseEvent:mouseReleased',
                'Input.insertText:',
            ]);
    });

    it('resizes the browser page only while the owner holds the screen', async () => {
        const page = createFakePage();
        const { session } = createSession(page);

        await session.start();
        session.handleInput(JSON.stringify({ type: 'resize', width: 400, height: 800 }));
        await settle();

        expect(page.calls.at(-1))
            .toEqual({
                method: 'Emulation.setDeviceMetricsOverride',
                params: { width: 400, height: 800, deviceScaleFactor: 1, mobile: false },
            });

        const botPage = createFakePage();
        const botSession = createSession(botPage, { isPersonHolding: false }).session;

        await botSession.start();
        botSession.handleInput(JSON.stringify({ type: 'resize', width: 400, height: 800 }));
        await settle();

        expect(botPage.calls.map(call => call.method))
            .toEqual(['Page.enable', 'Page.startScreencast']);
    });

    it('clears the viewport override when the owner gives the screen back', async () => {
        const page = createFakePage();
        const { session } = createSession(page);

        await session.start();
        session.restoreViewport();
        await settle();

        expect(page.calls.at(-1))
            .toEqual({ method: 'Emulation.clearDeviceMetricsOverride', params: {} });
    });

    it('drops input while the bot holds the screen', async () => {
        const page = createFakePage();
        const { session } = createSession(page, { isPersonHolding: false });

        await session.start();
        session.handleInput(JSON.stringify({ type: 'text', text: 'secret' }));
        await settle();

        expect(page.calls.map(call => call.method))
            .toEqual(['Page.enable', 'Page.startScreencast']);
    });

    it('stops the screencast and closes the page', async () => {
        const page = createFakePage();
        const { session } = createSession(page);

        await session.start();
        session.stop();
        await settle();

        expect(page.calls.at(-1)?.method)
            .toBe('Page.stopScreencast');
        expect(page.isClosed())
            .toBe(true);
    });

    it('sends only the latest of several moves that wait in the queue', async () => {
        const page = createFakePage();
        const { session } = createSession(page);

        await session.start();
        session.handleInput(JSON.stringify({ type: 'mouse', kind: 'move', x: 1, y: 1 }));
        session.handleInput(JSON.stringify({ type: 'mouse', kind: 'move', x: 2, y: 2 }));
        session.handleInput(JSON.stringify({ type: 'mouse', kind: 'move', x: 3, y: 3 }));
        await settle();

        const moves = page.calls.filter(call => call.params.type === 'mouseMoved');

        expect(moves)
            .toEqual([{ method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: 3, y: 3 } }]);
    });

    it('releases a button the owner still holds when the screen goes to the bot', async () => {
        const page = createFakePage();
        const { session } = createSession(page);

        await session.start();
        session.handleInput(JSON.stringify({ type: 'mouse', kind: 'down', x: 10, y: 20 }));
        await settle();
        session.releaseHeldButton();
        await settle();

        expect(page.calls.at(-1))
            .toEqual({ method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: 10, y: 20, button: 'left', clickCount: 1 } });
    });

    it('sends no release when no button is down', async () => {
        const page = createFakePage();
        const { session } = createSession(page);

        await session.start();
        session.handleInput(JSON.stringify({ type: 'mouse', kind: 'down', x: 10, y: 20 }));
        session.handleInput(JSON.stringify({ type: 'mouse', kind: 'up', x: 10, y: 20 }));
        await settle();
        const callsBefore = page.calls.length;

        session.releaseHeldButton();
        await settle();

        expect(page.calls)
            .toHaveLength(callsBefore);
    });

    it('releases a held button before the page is closed', async () => {
        const page = createFakePage();
        const { session } = createSession(page);

        await session.start();
        session.handleInput(JSON.stringify({ type: 'mouse', kind: 'down', x: 10, y: 20 }));
        await settle();
        session.stop();
        await settle();

        const methods = page.calls.slice(2)
            .map((call) => {
                const kind = call.params.type;

                return `${call.method}:${typeof kind === 'string' ? kind : ''}`;
            });

        expect(methods)
            .toEqual([
                'Input.dispatchMouseEvent:mousePressed',
                'Input.dispatchMouseEvent:mouseReleased',
                'Emulation.clearDeviceMetricsOverride:',
                'Page.stopScreencast:',
            ]);
        expect(page.isClosed())
            .toBe(true);
    });
});
