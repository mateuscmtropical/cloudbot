import { CdpConnection, CdpError } from './CdpConnection.ts';
import type { CdpSocketFactory } from './CdpConnection.ts';

interface BrowserControlOptions {
    // The DevTools HTTP address, such as http://127.0.0.1:9222.
    devtoolsUrl: string;
    // Tests inject fakes here.
    fetchFunction?: typeof fetch;
    socketFactory?: CdpSocketFactory;
    sleep?: (delayMs: number) => Promise<void>;
}

interface PageTarget {
    type?: string;
    webSocketDebuggerUrl?: string;
}

interface PageText {
    title: string;
    url: string;
    text: string;
    isTruncated: boolean;
}

interface KeyDefinition {
    code: string;
    keyCode: number;
    text?: string;
}

type BrowserKey = 'Enter' | 'Tab' | 'Escape' | 'Backspace' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'PageUp' | 'PageDown';

const KEY_DEFINITIONS: Record<BrowserKey, KeyDefinition> = {
    Enter: { code: 'Enter', keyCode: 13, text: '\r' },
    Tab: { code: 'Tab', keyCode: 9 },
    Escape: { code: 'Escape', keyCode: 27 },
    Backspace: { code: 'Backspace', keyCode: 8 },
    ArrowUp: { code: 'ArrowUp', keyCode: 38 },
    ArrowDown: { code: 'ArrowDown', keyCode: 40 },
    ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
    ArrowRight: { code: 'ArrowRight', keyCode: 39 },
    PageUp: { code: 'PageUp', keyCode: 33 },
    PageDown: { code: 'PageDown', keyCode: 34 },
};
const BROWSER_KEYS = Object.keys(KEY_DEFINITIONS) as BrowserKey[];
// docker/cloudbot-desktop starts Chromium with this DevTools port, on localhost only.
const DESKTOP_DEVTOOLS_URL = 'http://127.0.0.1:9222';
const MAX_PAGE_TEXT_LENGTH = 20_000;
const LOAD_WAIT_MS = 15_000;
const LOAD_POLL_MS = 250;
const READ_PAGE_EXPRESSION = '({ title: document.title, url: location.href, text: document.body ? document.body.innerText : "" })';
const READY_STATE_EXPRESSION = 'document.readyState';

class BrowserError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BrowserError';
    }
}

function defaultSleep(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, delayMs);
    });
}

function readEvaluatedValue(result: unknown): unknown {
    if (typeof result !== 'object' || result === null) {
        return undefined;
    }

    const remoteObject: unknown = Reflect.get(result, 'result');

    if (typeof remoteObject !== 'object' || remoteObject === null) {
        return undefined;
    }

    return Reflect.get(remoteObject, 'value');
}

function readStringField(value: unknown, field: string): string {
    if (typeof value !== 'object' || value === null) {
        return '';
    }

    const fieldValue: unknown = Reflect.get(value, field);

    return typeof fieldValue === 'string' ? fieldValue : '';
}

// Only web pages. file:, chrome: and javascript: URLs could read the bot's files or the browser's settings pages.
function parseWebUrl(rawUrl: string): string {
    let parsedUrl: URL;

    try {
        parsedUrl = new URL(rawUrl);
    } catch {
        throw new BrowserError('That is not a valid URL. Use a full address that starts with https:// or http://.');
    }

    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
        throw new BrowserError('Only http and https addresses can be opened.');
    }

    return parsedUrl.href;
}

// Drives the page that is shown on the bot's screen. Each action opens its own
// connection, so a browser restart between two actions does not break the next one.
class BrowserControl {
    private readonly devtoolsUrl: string;
    private readonly fetchFunction: typeof fetch;
    private readonly socketFactory: CdpSocketFactory | undefined;
    private readonly sleep: (delayMs: number) => Promise<void>;

    constructor(options: BrowserControlOptions) {
        this.devtoolsUrl = options.devtoolsUrl;
        this.fetchFunction = options.fetchFunction ?? fetch;
        this.socketFactory = options.socketFactory;
        this.sleep = options.sleep ?? defaultSleep;
    }

    async open(rawUrl: string): Promise<PageText> {
        const url = parseWebUrl(rawUrl);

        return this.withPage(async (page) => {
            await page.call('Page.navigate', { url });
            await this.waitForLoad(page);

            return this.readPage(page);
        });
    }

    screenshot(): Promise<string> {
        return this.withPage(async (page) => {
            const result = await page.call('Page.captureScreenshot', { format: 'png' });
            const data = readStringField(result, 'data');

            if (data === '') {
                throw new BrowserError('The browser returned no screenshot.');
            }

            return data;
        });
    }

    click(pointX: number, pointY: number): Promise<void> {
        const point = { x: pointX, y: pointY };

        return this.withPage(async (page) => {
            await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
            await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
            await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
        });
    }

    typeText(text: string): Promise<void> {
        return this.withPage(async (page) => {
            await page.call('Input.insertText', { text });
        });
    }

    pressKey(key: BrowserKey): Promise<void> {
        const definition = KEY_DEFINITIONS[key];
        const textOption = definition.text === undefined ? {} : { text: definition.text };
        const keyFields = { key, code: definition.code, windowsVirtualKeyCode: definition.keyCode };

        return this.withPage(async (page) => {
            await page.call('Input.dispatchKeyEvent', { type: 'keyDown', ...keyFields, ...textOption });
            await page.call('Input.dispatchKeyEvent', { type: 'keyUp', ...keyFields });
        });
    }

    scroll(pointX: number, pointY: number, deltaY: number): Promise<void> {
        return this.withPage(async (page) => {
            await page.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: pointX, y: pointY, deltaX: 0, deltaY });
        });
    }

    read(): Promise<PageText> {
        return this.withPage(page => this.readPage(page));
    }

    private async readPage(page: CdpConnection): Promise<PageText> {
        const result = await page.call('Runtime.evaluate', { expression: READ_PAGE_EXPRESSION, returnByValue: true });
        const value = readEvaluatedValue(result);
        const fullText = readStringField(value, 'text');
        const isTruncated = fullText.length > MAX_PAGE_TEXT_LENGTH;

        return {
            title: readStringField(value, 'title'),
            url: readStringField(value, 'url'),
            text: fullText.slice(0, MAX_PAGE_TEXT_LENGTH),
            isTruncated,
        };
    }

    // Page.navigate returns before the page loads. The ready state is polled
    // instead of waiting for an event, so a page that never fires load still returns.
    private async waitForLoad(page: CdpConnection): Promise<void> {
        const attempts = Math.ceil(LOAD_WAIT_MS / LOAD_POLL_MS);

        // Each poll waits for the one before it, so an array method does not fit.
        // eslint-disable-next-line no-restricted-syntax
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            const result = await page.call('Runtime.evaluate', { expression: READY_STATE_EXPRESSION, returnByValue: true });

            if (readEvaluatedValue(result) === 'complete') {
                return;
            }

            await this.sleep(LOAD_POLL_MS);
        }
    }

    private async withPage<T>(action: (page: CdpConnection) => Promise<T>): Promise<T> {
        const socketUrl = await this.findPageSocketUrl();
        let page: CdpConnection;

        try {
            page = await CdpConnection.open(socketUrl, this.socketFactory);
        } catch {
            throw new BrowserError('The browser is not running. Try again in a few seconds.');
        }

        try {
            return await action(page);
        } catch (error: unknown) {
            if (error instanceof CdpError) {
                throw new BrowserError(error.message);
            }

            throw error;
        } finally {
            page.close();
        }
    }

    private async findPageSocketUrl(): Promise<string> {
        let targets: unknown;

        try {
            const response = await this.fetchFunction(`${this.devtoolsUrl}/json/list`);

            targets = await response.json();
        } catch {
            throw new BrowserError('The browser is not running. Try again in a few seconds.');
        }

        const pages = Array.isArray(targets) ? (targets as PageTarget[]).filter(target => target.type === 'page') : [];
        const socketUrl = pages[0]?.webSocketDebuggerUrl;

        if (socketUrl !== undefined) {
            return socketUrl;
        }

        return this.openNewPage();
    }

    // All tabs can be closed on the screen. Then a new blank tab is opened.
    private async openNewPage(): Promise<string> {
        try {
            const response = await this.fetchFunction(`${this.devtoolsUrl}/json/new?about:blank`, { method: 'PUT' });
            const target = await response.json() as PageTarget;

            if (target.webSocketDebuggerUrl !== undefined) {
                return target.webSocketDebuggerUrl;
            }
        } catch {
            // Falls through to the same error as a browser that is not running.
        }

        throw new BrowserError('The browser has no open page. Try again in a few seconds.');
    }
}

export { BROWSER_KEYS, BrowserControl, BrowserError, DESKTOP_DEVTOOLS_URL, MAX_PAGE_TEXT_LENGTH, parseWebUrl };
export type { BrowserControlOptions, BrowserKey, PageText };
