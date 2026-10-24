import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrowserControl, BrowserError, MAX_PAGE_TEXT_LENGTH, devtoolsSocketUrl, parseWebUrl } from './BrowserControl.ts';
import { createFakeSocketFactory } from './testCdp.ts';
import type { FakeCdpSocket } from './testCdp.ts';
import type { CdpAnswer, SentCall } from './testCdp.ts';

interface FetchCall {
    url: string;
    method: string;
}

// Every action enables the Page domain first, to see dialogs. The tests look at the calls after it.
function actionCalls(socket: FakeCdpSocket | undefined): SentCall[] {
    return (socket?.sent ?? []).filter(call => call.method !== 'Page.enable');
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

describe('devtoolsSocketUrl', () => {
    it('accepts a ws socket on loopback, on the DevTools port, under /devtools/', () => {
        expect(devtoolsSocketUrl('ws://127.0.0.1:9222/devtools/page/one', '9222'))
            .toBe('ws://127.0.0.1:9222/devtools/page/one');
        expect(devtoolsSocketUrl('ws://localhost:9222/devtools/browser/x', '9222'))
            .toBe('ws://localhost:9222/devtools/browser/x');
    });

    it('refuses another host, another port, another scheme or path, and text that is not a URL', () => {
        expect(devtoolsSocketUrl('ws://192.168.1.5:9222/devtools/page/one', '9222'))
            .toBeUndefined();
        expect(devtoolsSocketUrl('ws://127.0.0.1:8080/devtools/page/one', '9222'))
            .toBeUndefined();
        expect(devtoolsSocketUrl('wss://127.0.0.1:9222/devtools/page/one', '9222'))
            .toBeUndefined();
        expect(devtoolsSocketUrl('ws://127.0.0.1:9222/json/list', '9222'))
            .toBeUndefined();
        expect(devtoolsSocketUrl('not a url', '9222'))
            .toBeUndefined();
        expect(devtoolsSocketUrl(undefined, '9222'))
            .toBeUndefined();
    });
});

describe('disable', () => {
    it('makes every action fail with the reason, without asking the browser', async () => {
        const { browser, fetchCalls } = createBrowser(pageAnswer({ title: 'Example', url: 'https://example.com/', text: 'Hello' }));

        browser.disable('The browser tools are off.');

        await expect(browser.read()).rejects.toThrow('The browser tools are off.');
        expect(fetchCalls.calls)
            .toEqual([]);
    });

    it('lets actions through again after enable, once the gate check has passed', async () => {
        const { browser, fetchCalls } = createBrowser(pageAnswer({ title: 'Example', url: 'https://example.com/', text: 'Hello' }));

        browser.disable('The browser tools are off.');
        browser.enable();

        await expect(browser.read()).resolves.toMatchObject({ title: 'Example' });
        expect(fetchCalls.calls)
            .not.toEqual([]);
    });
});

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

afterEach(() => {
    vi.useRealTimers();
});

describe('BrowserControl', () => {
    it('asks the DevTools port on each action, so a browser that starts later is found', async () => {
        const sockets = createFakeSocketFactory(pageAnswer({ title: 'Example', url: 'https://example.com/', text: 'Hello' }));
        const fetchCalls = createFetch([{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:51234/devtools/page/one' }], {});
        const devtools: { url: string | undefined } = { url: undefined };
        const browser = new BrowserControl({
            devtoolsUrl: () => devtools.url,
            fetchFunction: fetchCalls.fetchFunction,
            socketFactory: sockets.factory,
            sleep: async () => {},
        });

        await expect(browser.read()).rejects.toThrow('not running');
        expect(fetchCalls.calls)
            .toEqual([]);

        devtools.url = 'http://127.0.0.1:51234';
        await browser.read();
        expect(fetchCalls.calls[0])
            .toEqual({ url: 'http://127.0.0.1:51234/json/list', method: 'GET' });
    });

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
        expect(actionCalls(sockets.sockets[0])[0])
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

        const readyStateCalls = actionCalls(sockets.sockets[0])
            .filter(call => call.params.expression === 'document.readyState');

        expect(readyStateCalls.length)
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
        expect(actionCalls(sockets.sockets[0])[0])
            .toEqual({ id: 2, method: 'Page.captureScreenshot', params: { format: 'png' } });
    });

    it('clicks with a move, a press and a release at the point', async () => {
        const { browser, sockets } = createBrowser(pageAnswer({}));

        await expect(browser.click(10, 20)).resolves.toEqual({ hasFocusedField: false });

        const sentTypes = actionCalls(sockets.sockets[0])
            .filter(call => call.method === 'Input.dispatchMouseEvent')
            .map(call => [call.params.type, call.params.x, call.params.y]);

        expect(sentTypes)
            .toEqual([['mouseMoved', 10, 20], ['mousePressed', 10, 20], ['mouseReleased', 10, 20]]);
    });

    it('clicks a field again when the first click left it without the focus', async () => {
        const focusStates = [
            { targetIsTextField: true, focusedIsField: false },
            { targetIsTextField: true, focusedIsField: true },
        ];
        const { browser, sockets } = createBrowser(call => (call.method === 'Runtime.evaluate'
            ? { result: { result: { value: focusStates.shift() } } }
            : { result: {} }));

        await expect(browser.click(10, 20)).resolves.toEqual({ hasFocusedField: true });
        expect(actionCalls(sockets.sockets[0])
            .filter(call => call.params.type === 'mousePressed'))
            .toHaveLength(2);
    });

    it('clicks a field only twice and then reports that nothing has the focus', async () => {
        const { browser, sockets } = createBrowser(call => (call.method === 'Runtime.evaluate'
            ? { result: { result: { value: { targetIsTextField: true, focusedIsField: false } } } }
            : { result: {} }));

        await expect(browser.click(10, 20)).resolves.toEqual({ hasFocusedField: false });
        expect(actionCalls(sockets.sockets[0])
            .filter(call => call.params.type === 'mousePressed'))
            .toHaveLength(2);
    });

    it('does not fail or click again when the click started a navigation', async () => {
        const { browser, sockets } = createBrowser(call => (call.method === 'Runtime.evaluate'
            ? { error: { message: 'Execution context was destroyed.' } }
            : { result: {} }));

        await expect(browser.click(10, 20)).resolves.toEqual({ hasFocusedField: false });
        expect(actionCalls(sockets.sockets[0])
            .filter(call => call.params.type === 'mousePressed'))
            .toHaveLength(1);
    });

    it('does not repeat a click that landed on something that is not a field', async () => {
        const { browser, sockets } = createBrowser(pageAnswer({ targetIsTextField: false, focusedIsField: false }));

        await browser.click(10, 20);

        expect(actionCalls(sockets.sockets[0])
            .filter(call => call.params.type === 'mousePressed'))
            .toHaveLength(1);
    });

    it('types text and presses Enter with its key code and text', async () => {
        const { browser, sockets } = createBrowser(pageAnswer({}));

        await browser.typeText('hello');
        await browser.pressKey('Enter');

        expect(actionCalls(sockets.sockets[0])[0])
            .toMatchObject({ method: 'Input.insertText', params: { text: 'hello' } });
        expect(actionCalls(sockets.sockets[1])[0])
            .toMatchObject({
                method: 'Input.dispatchKeyEvent',
                params: { type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
            });
        expect(actionCalls(sockets.sockets[1])[1]?.params)
            .toEqual({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    });

    it('scrolls with a mouse wheel event', async () => {
        const { browser, sockets } = createBrowser(pageAnswer({}));

        await browser.scroll(640, 400, -300);

        expect(actionCalls(sockets.sockets[0])[0]?.params)
            .toEqual({ type: 'mouseWheel', x: 640, y: 400, deltaX: 0, deltaY: -300 });
    });

    it('opens a blank page when no page is open', async () => {
        const { browser, sockets, fetchCalls } = createBrowser(pageAnswer({}), [{ type: 'service_worker', webSocketDebuggerUrl: 'ws://worker' }]);

        await browser.screenshot();

        expect(fetchCalls.calls[1])
            .toEqual({ url: 'http://127.0.0.1:9222/json/new?https://www.google.com/', method: 'PUT' });
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

    it('reports a page that could not be opened instead of the old page', async () => {
        const { browser } = createBrowser((call) => {
            if (call.method === 'Page.navigate') {
                return { result: { frameId: 'main', errorText: 'net::ERR_NAME_NOT_RESOLVED' } };
            }

            return pageAnswer({ title: 'Old', url: 'https://old.example/', text: '' })(call);
        });

        await expect(browser.open('https://no-such-host.invalid'))
            .rejects.toThrow('The page could not be opened: net::ERR_NAME_NOT_RESOLVED');
    });

    it('tells the model to ask the owner when the gate refused the address', async () => {
        const { browser } = createBrowser((call) => {
            if (call.method === 'Page.navigate') {
                return { result: { frameId: 'main', errorText: 'net::ERR_SOCKS_CONNECTION_FAILED' } };
            }

            return pageAnswer({ title: 'Old', url: 'https://old.example/', text: '' })(call);
        });

        await expect(browser.open('https://intranet.test'))
            .rejects.toThrow('Ask the owner before using browser_allow_host.');
    });

    it('keeps waiting when the page replaces itself while it loads', async () => {
        const readyStates = ['gone', 'complete'];
        const { browser } = createBrowser((call) => {
            if (call.params.expression === 'document.readyState') {
                const next = readyStates.shift();

                return next === 'gone'
                    ? { error: { message: 'Execution context was destroyed.' } }
                    : { result: { result: { value: next } } };
            }

            return pageAnswer({ title: 'After redirect', url: 'https://new.example/', text: '' })(call);
        });

        await expect(browser.open('https://short.example'))
            .resolves.toMatchObject({ title: 'After redirect' });
    });

    it('closes a dialog that opens during an action and keeps its text', async () => {
        const { browser, sockets } = createBrowser((call) => {
            if (call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mouseReleased') {
                queueMicrotask(() => {
                    sockets.sockets[0]?.emit('message', {
                        data: JSON.stringify({ method: 'Page.javascriptDialogOpening', params: { message: 'Delete everything?', type: 'confirm' } }),
                    });
                });
            }

            return { result: {} };
        });

        await browser.click(5, 5);
        await new Promise(resolve => setImmediate(resolve));

        expect(browser.takeDismissedDialogs())
            .toEqual(['Delete everything?']);
        expect(browser.takeDismissedDialogs())
            .toEqual([]);
        expect(sockets.sockets[0]?.sent.some(call => call.method === 'Page.handleJavaScriptDialog' && call.params.accept === false))
            .toBe(true);
    });

    it('says a dialog blocks the page when Page.enable does not answer, and still lets open navigate', async () => {
        vi.useFakeTimers();

        const blockedAnswer: CdpAnswer = (call) => {
            if (call.method === 'Page.enable') {
                return undefined;
            }

            return pageAnswer({ title: 'Fresh', url: 'https://fresh.example/', text: '' })(call);
        };
        const { browser } = createBrowser(blockedAnswer);
        const reading = browser.read();
        const readExpectation = expect(reading).rejects.toThrow('The page is showing a dialog');

        await vi.advanceTimersByTimeAsync(3_000);
        await readExpectation;

        const opening = browser.open('https://fresh.example');

        await vi.advanceTimersByTimeAsync(3_000);
        await expect(opening).resolves.toMatchObject({ title: 'Fresh' });
    });

    it('accepts a leave-page dialog so the bot is not kept on the page', async () => {
        const { browser, sockets } = createBrowser((call) => {
            if (call.method === 'Input.insertText') {
                queueMicrotask(() => {
                    sockets.sockets[0]?.emit('message', {
                        data: JSON.stringify({ method: 'Page.javascriptDialogOpening', params: { message: '', type: 'beforeunload' } }),
                    });
                });
            }

            return { result: {} };
        });

        await browser.typeText('draft');
        await new Promise(resolve => setImmediate(resolve));

        expect(sockets.sockets[0]?.sent.find(call => call.method === 'Page.handleJavaScriptDialog')?.params)
            .toEqual({ accept: true });
    });

    it('types a secret only into a secret field of a page on its site, checked in an isolated world', async () => {
        const focusAnswer = (focus: unknown): CdpAnswer => (call) => {
            if (call.method === 'Page.getFrameTree') {
                return { result: { frameTree: { frame: { id: 'main' } } } };
            }

            if (call.method === 'Page.createIsolatedWorld') {
                return { result: { executionContextId: 7 } };
            }

            if (call.method === 'Runtime.evaluate') {
                return { result: { result: { value: focus } } };
            }

            return { result: {} };
        };
        const passwordField = createBrowser(focusAnswer({ origin: 'https://github.com', tag: 'INPUT', type: 'password', autocomplete: '' }));
        const codeField = createBrowser(focusAnswer({ origin: 'https://github.com', tag: 'INPUT', type: 'text', autocomplete: 'one-time-code' }));
        const refused = [
            [createBrowser(focusAnswer({ origin: 'https://evil.example', tag: 'INPUT', type: 'password', autocomplete: '' })), 'only for https://github.com, and the page is on https://evil.example'],
            [createBrowser(focusAnswer({ origin: 'https://github.com', tag: 'IFRAME', type: '', autocomplete: '' })), 'inside a frame'],
            [createBrowser(focusAnswer({ origin: 'https://github.com', tag: 'INPUT', type: 'search', autocomplete: '' })), 'not a password, one-time code or card field'],
            [createBrowser(focusAnswer({ origin: 'https://github.com', tag: 'TEXTAREA', type: '', autocomplete: '' })), 'not a password, one-time code or card field'],
        ] as const;

        await passwordField.browser.typeSecret('https://github.com', 'fake-password-1');
        await codeField.browser.typeSecret('https://github.com', '123456');

        const passwordCalls = actionCalls(passwordField.sockets.sockets[0]);

        expect(passwordCalls.find(call => call.method === 'Runtime.evaluate')?.params.contextId)
            .toBe(7);
        expect(passwordCalls.at(-1))
            .toMatchObject({ method: 'Input.insertText', params: { text: 'fake-password-1' } });
        expect(actionCalls(codeField.sockets.sockets[0])
            .at(-1))
            .toMatchObject({ method: 'Input.insertText', params: { text: '123456' } });
        await Promise.all(refused.map(async ([harness, message]) => {
            await expect(harness.browser.typeSecret('https://github.com', 'fake-password-1'))
                .rejects.toThrow(message);
            expect(actionCalls(harness.sockets.sockets[0])
                .some(call => call.method === 'Input.insertText'))
                .toBe(false);
        }));
    });

    it('reads the origin of the page in an isolated world and refuses a page without a site', async () => {
        const originAnswer = (origin: unknown): CdpAnswer => (call) => {
            if (call.method === 'Page.getFrameTree') {
                return { result: { frameTree: { frame: { id: 'main' } } } };
            }

            if (call.method === 'Page.createIsolatedWorld') {
                return { result: { executionContextId: 9 } };
            }

            if (call.method === 'Runtime.evaluate') {
                return { result: { result: { value: origin } } };
            }

            return { result: {} };
        };
        const real = createBrowser(originAnswer('https://github.com'));
        const blank = createBrowser(originAnswer('null'));

        await expect(real.browser.readPageOrigin())
            .resolves.toBe('https://github.com');
        expect(actionCalls(real.sockets.sockets[0])
            .find(call => call.method === 'Runtime.evaluate')?.params)
            .toMatchObject({ expression: 'location.origin', contextId: 9 });
        await expect(blank.browser.readPageOrigin())
            .rejects.toThrow('no site of its own');
    });

    it('types a login part only into a fitting field of the page the server checked', async () => {
        const focusAnswer = (focus: unknown): CdpAnswer => (call) => {
            if (call.method === 'Page.getFrameTree') {
                return { result: { frameTree: { frame: { id: 'main' } } } };
            }

            if (call.method === 'Page.createIsolatedWorld') {
                return { result: { executionContextId: 7 } };
            }

            if (call.method === 'Runtime.evaluate') {
                return { result: { result: { value: focus } } };
            }

            return { result: {} };
        };
        const emailField = createBrowser(focusAnswer({ origin: 'https://github.com', tag: 'INPUT', type: 'email', autocomplete: 'username' }));
        const passwordField = createBrowser(focusAnswer({ origin: 'https://github.com', tag: 'INPUT', type: 'password', autocomplete: '' }));
        const codeField = createBrowser(focusAnswer({ origin: 'https://github.com', tag: 'INPUT', type: 'text', autocomplete: '' }));
        const refused = [
            [createBrowser(focusAnswer({ origin: 'https://evil.example', tag: 'INPUT', type: 'email', autocomplete: '' })), 'username', 'only for https://github.com, and the page is on https://evil.example'],
            [createBrowser(focusAnswer({ origin: 'https://github.com', tag: 'INPUT', type: 'password', autocomplete: '' })), 'username', 'not a user name or email field'],
            [createBrowser(focusAnswer({ origin: 'https://github.com', tag: 'INPUT', type: 'text', autocomplete: '' })), 'password', 'not a password field'],
            [createBrowser(focusAnswer({ origin: 'https://github.com', tag: 'INPUT', type: 'search', autocomplete: '' })), 'totp', 'not a one-time code field'],
            [createBrowser(focusAnswer({ origin: 'https://github.com', tag: 'IFRAME', type: '', autocomplete: '' })), 'password', 'inside a frame'],
        ] as const;

        await emailField.browser.typeLogin('https://github.com', 'username', 'ana@example.com');
        await passwordField.browser.typeLogin('https://github.com', 'password', 'fake-password-1');
        await codeField.browser.typeLogin('https://github.com', 'totp', '123456');

        expect(actionCalls(emailField.sockets.sockets[0])
            .at(-1))
            .toMatchObject({ method: 'Input.insertText', params: { text: 'ana@example.com' } });
        expect(actionCalls(passwordField.sockets.sockets[0])
            .at(-1))
            .toMatchObject({ method: 'Input.insertText', params: { text: 'fake-password-1' } });
        expect(actionCalls(codeField.sockets.sockets[0])
            .at(-1))
            .toMatchObject({ method: 'Input.insertText', params: { text: '123456' } });
        await Promise.all(refused.map(async ([harness, part, message]) => {
            await expect(harness.browser.typeLogin('https://github.com', part, 'value'))
                .rejects.toThrow(message);
            expect(actionCalls(harness.sockets.sockets[0])
                .some(call => call.method === 'Input.insertText'))
                .toBe(false);
        }));
    });
});
