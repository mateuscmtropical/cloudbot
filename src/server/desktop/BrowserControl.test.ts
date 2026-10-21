import { describe, expect, it } from 'vitest';

import { BrowserControl, BrowserError, MAX_PAGE_TEXT_LENGTH, parseWebUrl } from './BrowserControl.ts';
import { createFakeSocketFactory } from './testCdp.ts';
import type { CdpAnswer, SentCall } from './testCdp.ts';

interface FetchCall {
    url: string;
    method: string;
}

const PAGE_SOCKET_URL = 'ws://127.0.0.1:9222/devtools/page/one';

function createFetch(targets: unknown, newTarget: unknown = {}): { fetchFunction: typeof fetch; calls: FetchCall[] } {
    const calls: FetchCall[] = [];
    const fetchFunction = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = input instanceof Request ? input.url : input.toString();

        calls.push({ url, method: init?.method ?? 'GET' });

        const body = url.includes('/json/new') ? newTarget : targets;

        return Promise.resolve(Response.json(body));
    }) as typeof fetch;

    return { fetchFunction, calls };
}

function pageAnswer(pageValue: unknown): CdpAnswer {
    return (call: SentCall) => {
        if (call.method === 'Runtime.evaluate' && call.params.expression === 'document.readyState') {
            return { result: { result: { value: 'complete' } } };
        }

        if (call.method === 'Runtime.evaluate') {
            return { result: { result: { value: pageValue } } };
        }

        if (call.method === 'Page.captureScreenshot') {
            return { result: { data: 'iVBORw0KGgo=' } };
        }

        return { result: {} };
    };
}

interface BrowserHarness {
    browser: BrowserControl;
    sockets: ReturnType<typeof createFakeSocketFactory>;
    fetchCalls: ReturnType<typeof createFetch>;
}

function createBrowser(answer: CdpAnswer, targets: unknown = [{ type: 'page', webSocketDebuggerUrl: PAGE_SOCKET_URL }]): BrowserHarness {
    const sockets = createFakeSocketFactory(answer);
    const fetchCalls = createFetch(targets, { webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/new' });
    const browser = new BrowserControl({
        devtoolsUrl: 'http://127.0.0.1:9222',
        fetchFunction: fetchCalls.fetchFunction,
        socketFactory: sockets.factory,
        sleep: async () => {},
    });

    return { browser, sockets, fetchCalls };
}

describe('parseWebUrl', () => {
    it('accepts http and https addresses', () => {
        expect(parseWebUrl('https://example.com'))
            .toBe('https://example.com/');
        expect(parseWebUrl('http://localhost:8080/a'))
            .toBe('http://localhost:8080/a');
    });

    it('refuses other schemes and text that is not a URL', () => {
        expect(() => parseWebUrl('file:///etc/passwd'))
            .toThrow(BrowserError);
        expect(() => parseWebUrl('javascript:alert(1)'))
            .toThrow('Only http and https');
        expect(() => parseWebUrl('chrome://settings'))
            .toThrow('Only http and https');
        expect(() => parseWebUrl('example.com'))
            .toThrow('not a valid URL');
    });
});

describe('BrowserControl', () => {
    it('opens a page, waits for it to load and returns its text', async () => {
        const { browser, sockets, fetchCalls } = createBrowser(pageAnswer({ title: 'Example', url: 'https://example.com/', text: 'Hello' }));

        await expect(browser.open('https://example.com')).resolves.toEqual({
            title: 'Example',
            url: 'https://example.com/',
            text: 'Hello',
            isTruncated: false,
        });
        expect(fetchCalls.calls[0])
            .toEqual({ url: 'http://127.0.0.1:9222/json/list', method: 'GET' });
        expect(sockets.urls)
            .toEqual([PAGE_SOCKET_URL]);
        expect(sockets.sockets[0]?.sent[0])
            .toMatchObject({ method: 'Page.navigate', params: { url: 'https://example.com/' } });
        expect(sockets.sockets[0]?.isClosed)
            .toBe(true);
    });

    it('does not contact the browser for a refused URL', async () => {
        const { browser, fetchCalls } = createBrowser(pageAnswer({}));

        await expect(browser.open('file:///etc/passwd')).rejects.toThrow('Only http and https');
        expect(fetchCalls.calls)
            .toHaveLength(0);
    });

    it('stops waiting for a page that never finishes loading', async () => {
        const { browser, sockets } = createBrowser((call) => {
            if (call.method === 'Runtime.evaluate' && call.params.expression === 'document.readyState') {
                return { result: { result: { value: 'loading' } } };
            }

            return { result: { result: { value: { title: 'Slow', url: 'https://slow.example/', text: '' } } } };
        });

        await expect(browser.open('https://slow.example')).resolves.toMatchObject({ title: 'Slow' });

        const readyStateCalls = sockets.sockets[0]?.sent.filter(call => call.params.expression === 'document.readyState');

        expect(readyStateCalls?.length)
            .toBe(60);
    });

    it('cuts long page text', async () => {
        const longText = 'a'.repeat(MAX_PAGE_TEXT_LENGTH + 10);
        const { browser } = createBrowser(pageAnswer({ title: 'Long', url: 'https://long.example/', text: longText }));
        const page = await browser.read();

        expect(page.text)
            .toHaveLength(MAX_PAGE_TEXT_LENGTH);
        expect(page.isTruncated)
            .toBe(true);
    });

    it('returns the screenshot data', async () => {
        const { browser, sockets } = createBrowser(pageAnswer({}));

        await expect(browser.screenshot()).resolves.toBe('iVBORw0KGgo=');
        expect(sockets.sockets[0]?.sent[0])
            .toEqual({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } });
    });

    it('clicks with a move, a press and a release at the point', async () => {
        const { browser, sockets } = createBrowser(pageAnswer({}));

        await browser.click(10, 20);

        const sentTypes = sockets.sockets[0]?.sent.map(call => [call.params.type, call.params.x, call.params.y]);

        expect(sentTypes)
            .toEqual([['mouseMoved', 10, 20], ['mousePressed', 10, 20], ['mouseReleased', 10, 20]]);
    });

    it('types text and presses Enter with its key code and text', async () => {
        const { browser, sockets } = createBrowser(pageAnswer({}));

        await browser.typeText('hello');
        await browser.pressKey('Enter');

        expect(sockets.sockets[0]?.sent[0])
            .toMatchObject({ method: 'Input.insertText', params: { text: 'hello' } });
        expect(sockets.sockets[1]?.sent[0])
            .toMatchObject({
                method: 'Input.dispatchKeyEvent',
                params: { type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
            });
        expect(sockets.sockets[1]?.sent[1]?.params)
            .toEqual({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    });

    it('scrolls with a mouse wheel event', async () => {
        const { browser, sockets } = createBrowser(pageAnswer({}));

        await browser.scroll(640, 400, -300);

        expect(sockets.sockets[0]?.sent[0]?.params)
            .toEqual({ type: 'mouseWheel', x: 640, y: 400, deltaX: 0, deltaY: -300 });
    });

    it('opens a blank page when no page is open', async () => {
        const { browser, sockets, fetchCalls } = createBrowser(pageAnswer({}), [{ type: 'service_worker', webSocketDebuggerUrl: 'ws://worker' }]);

        await browser.screenshot();

        expect(fetchCalls.calls[1])
            .toEqual({ url: 'http://127.0.0.1:9222/json/new?about:blank', method: 'PUT' });
        expect(sockets.urls)
            .toEqual(['ws://127.0.0.1:9222/devtools/page/new']);
    });

    it('says the browser is not running when DevTools does not answer', async () => {
        const browser = new BrowserControl({
            devtoolsUrl: 'http://127.0.0.1:9222',
            fetchFunction: () => Promise.reject(new TypeError('fetch failed')),
        });

        await expect(browser.read()).rejects.toThrow('The browser is not running');
    });

    it('turns a browser error into a BrowserError and closes the connection', async () => {
        const { browser, sockets } = createBrowser(() => ({ error: { message: 'No node' } }));

        await expect(browser.click(1, 1)).rejects.toBeInstanceOf(BrowserError);
        expect(sockets.sockets[0]?.isClosed)
            .toBe(true);
    });
});
