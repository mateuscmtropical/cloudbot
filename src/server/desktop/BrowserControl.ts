import { CdpConnection, CdpError } from './CdpConnection.ts';
import type { CdpSocketFactory } from './CdpConnection.ts';

interface BrowserControlOptions {
    // The DevTools HTTP address, such as http://127.0.0.1:9222. A function is asked on each action, so a browser
    // that starts later, or restarts on another port, is found. It returns undefined while no browser has a port.
    devtoolsUrl: string | (() => string | undefined);
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

interface ClickResult {
    // True when an input, a text area, a select or an editable element has the focus after the click.
    hasFocusedField: boolean;
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
const LOOPBACK_HOSTNAME = '127.0.0.1';
const NOT_RUNNING_MESSAGE = 'The browser is not running. Try again in a few seconds.';
const MAX_PAGE_TEXT_LENGTH = 20_000;
const LOAD_WAIT_MS = 15_000;
const DEVTOOLS_HTTP_TIMEOUT_MS = 5_000;
// Page.enable does not answer while a dialog is open, so a short wait tells the two apart.
const PAGE_ENABLE_TIMEOUT_MS = 3_000;
const MAX_DIALOG_TEXT_LENGTH = 300;
// The browser's proxy refuses private addresses, so a failed load may be one of them.
const PRIVATE_ADDRESS_HINT = 'If the address is private, the browser refuses it. Use browser_allow_host only when the owner asks.';
// Chromium reports a refusal by the gate with this code. The address is private, or nothing answered on it.
const GATE_REFUSED_ERROR = 'ERR_SOCKS_CONNECTION_FAILED';
const GATE_REFUSED_HINT = 'The browser refused this address because it is private or could not be reached. Ask the owner before using browser_allow_host.';
const DIALOG_BLOCKED_MESSAGE = 'The page is showing a dialog or does not answer. Use browser_open to load a page again.';
// A page that replaces itself while it loads destroys the context of the next evaluate. That is not a failure.
const CONTEXT_GONE_PATTERN = /context was destroyed|cannot find context|execution context/i;
const LOAD_POLL_MS = 250;
const CLICK_RETRY_DELAY_MS = 200;
const READ_PAGE_EXPRESSION = '({ title: document.title, url: location.href, text: document.body ? document.body.innerText : "" })';
const READY_STATE_EXPRESSION = 'document.readyState';
// Runs in an isolated world, so the page's own scripts cannot change what it reads.
const FOCUS_CHECK_EXPRESSION = '(() => { const field = document.activeElement; return { origin: location.origin, tag: field ? field.tagName : "", type: field && field.tagName === "INPUT" ? field.type : "", autocomplete: field && field.tagName === "INPUT" ? (field.autocomplete.trim().toLowerCase().split(/\\s+/).pop() || "") : "" }; })()';
// Reads what is under the point and what has the focus. It only reads, so the page cannot be changed by it.
// Only a text field is clicked again, because a second click would toggle a checkbox or press a button twice.
// The focus is followed into shadow roots and same-origin frames. A frame of another site counts as focused.
const NON_TEXT_INPUT_TYPES = '["checkbox","radio","button","submit","reset","file","image","color","range","hidden"]';
const CLICK_FOCUS_EXPRESSION = (pointX: number, pointY: number): string => `(() => {
    const isText = (element) => Boolean(element) && !element.disabled && !element.readOnly
        && (element.tagName === "TEXTAREA" || (element.tagName === "INPUT" && !${NON_TEXT_INPUT_TYPES}.includes(element.type)) || element.isContentEditable);
    const isField = (element) => isText(element) || (Boolean(element) && !element.disabled && element.tagName === "SELECT");
    const target = document.elementFromPoint(${String(pointX)}, ${String(pointY)});
    let active = document.activeElement;
    for (;;) {
        if (active && active.shadowRoot && active.shadowRoot.activeElement) { active = active.shadowRoot.activeElement; continue; }
        if (active && active.tagName === "IFRAME") {
            if (!active.contentDocument) { return { targetIsTextField: isText(target), focusedIsField: true }; }
            if (active.contentDocument.activeElement) { active = active.contentDocument.activeElement; continue; }
        }
        break;
    }
    return { targetIsTextField: isText(target), focusedIsField: isField(active) };
})()`;
const ISOLATED_WORLD_NAME = 'cloudbot-secret-check';
// Fields that are not password inputs but still take a secret. The last token of their autocomplete value says so,
// as in "billing cc-number".
const SECRET_AUTOCOMPLETE_VALUES = new Set(['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc']);
const ORIGIN_EXPRESSION = 'location.origin';
// A user name or a code in a plain field is not as risky as a password, but a search box or a checkbox is still refused.
const USERNAME_INPUT_TYPES = new Set(['text', 'email', 'tel']);
const CODE_INPUT_TYPES = new Set(['text', 'tel', 'number']);

type LoginField = 'username' | 'password' | 'totp';

// What the focused element must be for a value to go in. The tag, the input type and the last token of autocomplete.
interface FieldRule {
    isAllowed: (tag: string, type: string, autocomplete: string) => boolean;
    refusal: string;
}

function isSecretField(tag: string, type: string, autocomplete: string): boolean {
    return tag === 'INPUT' && (type === 'password' || SECRET_AUTOCOMPLETE_VALUES.has(autocomplete));
}

const SECRET_FIELD_RULE: FieldRule = {
    isAllowed: isSecretField,
    refusal: 'The focused field is not a password, one-time code or card field. Click that field first.',
};

const LOGIN_FIELD_RULES: Record<LoginField, FieldRule> = {
    username: {
        isAllowed: (tag, type) => tag === 'INPUT' && USERNAME_INPUT_TYPES.has(type),
        refusal: 'The focused field is not a user name or email field. Click that field first.',
    },
    password: {
        isAllowed: isSecretField,
        refusal: 'The focused field is not a password field. Click that field first.',
    },
    totp: {
        isAllowed: (tag, type, autocomplete) => isSecretField(tag, type, autocomplete) || (tag === 'INPUT' && CODE_INPUT_TYPES.has(type)),
        refusal: 'The focused field is not a one-time code field. Click that field first.',
    },
};

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

interface WithPageOptions {
    // Only a navigation can get past a dialog that was already open.
    canRecoverFromDialog?: boolean;
}

async function createIsolatedContext(page: CdpConnection): Promise<number> {
    const tree = await page.call('Page.getFrameTree');
    const frameTree: unknown = typeof tree === 'object' && tree !== null ? Reflect.get(tree, 'frameTree') : undefined;
    const frame: unknown = typeof frameTree === 'object' && frameTree !== null ? Reflect.get(frameTree, 'frame') : undefined;
    const frameId = readStringField(frame, 'id');
    const world = await page.call('Page.createIsolatedWorld', { frameId, worldName: ISOLATED_WORLD_NAME });
    const contextId: unknown = typeof world === 'object' && world !== null ? Reflect.get(world, 'executionContextId') : undefined;

    if (frameId === '' || typeof contextId !== 'number') {
        throw new BrowserError('The page could not be checked. Try again.');
    }

    return contextId;
}

async function readReadyState(page: CdpConnection): Promise<unknown> {
    try {
        const result = await page.call('Runtime.evaluate', { expression: READY_STATE_EXPRESSION, returnByValue: true });

        return readEvaluatedValue(result);
    } catch (error: unknown) {
        if (error instanceof CdpError && CONTEXT_GONE_PATTERN.test(error.message)) {
            return 'loading';
        }

        throw error;
    }
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
    private readonly devtoolsUrl: string | (() => string | undefined);
    // Set when the browser must not be used, such as when its gate check fails. Every action then reports it.
    private disabledReason: string | undefined;
    private readonly fetchFunction: typeof fetch;
    private readonly socketFactory: CdpSocketFactory | undefined;
    private readonly sleep: (delayMs: number) => Promise<void>;
    private dismissedDialogs: string[] = [];

    constructor(options: BrowserControlOptions) {
        this.devtoolsUrl = options.devtoolsUrl;
        this.fetchFunction = options.fetchFunction ?? fetch;
        this.socketFactory = options.socketFactory;
        this.sleep = options.sleep ?? defaultSleep;
    }

    // Turns the browser tools off. Each action then fails with the reason.
    disable(reason: string): void {
        this.disabledReason = reason;
    }

    // Turns the browser tools back on, after the gate check has passed.
    enable(): void {
        this.disabledReason = undefined;
    }

    async open(rawUrl: string): Promise<PageText> {
        const url = parseWebUrl(rawUrl);

        return this.withPage(async (page) => {
            const result = await page.call('Page.navigate', { url });
            const errorText = readStringField(result, 'errorText');

            // A failed load answers with errorText, not with an error, and leaves the old page or an error page.
            if (errorText !== '') {
                const hint = errorText.includes(GATE_REFUSED_ERROR) ? GATE_REFUSED_HINT : PRIVATE_ADDRESS_HINT;

                throw new BrowserError(`The page could not be opened: ${errorText}. ${hint}`);
            }

            await this.waitForLoad(page);

            return this.readPage(page);
        }, { canRecoverFromDialog: true });
    }

    // The text of the dialogs closed since the last call, so a tool can tell the model.
    takeDismissedDialogs(): string[] {
        const dialogs = this.dismissedDialogs;

        this.dismissedDialogs = [];

        return dialogs;
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

    // The first mouse events after a page loads can be lost, and the field then gets no focus.
    // So a click on a field that did not take the focus is repeated once, and the result tells the model.
    click(pointX: number, pointY: number): Promise<ClickResult> {
        const point = { x: pointX, y: pointY };

        return this.withPage(async (page) => {
            await this.dispatchClick(page, point);

            let focus = await this.readClickFocus(page, pointX, pointY);

            if (focus.targetIsTextField && !focus.focusedIsField) {
                await this.sleep(CLICK_RETRY_DELAY_MS);
                await this.dispatchClick(page, point);
                focus = await this.readClickFocus(page, pointX, pointY);
            }

            return { hasFocusedField: focus.focusedIsField };
        });
    }

    typeText(text: string): Promise<void> {
        return this.withPage(async (page) => {
            await page.call('Input.insertText', { text });
        });
    }

    // Types a saved secret, but only into a secret field of a page on its site. A text field such as
    // a search box would put the value in the address, on the screen or in a public post.
    // The value is never returned or logged.
    typeSecret(site: string, value: string): Promise<void> {
        return this.typeIntoFocusedField(site, value, SECRET_FIELD_RULE);
    }

    // The origin of the page on the screen, read in an isolated world so page scripts cannot change it.
    // The server decides from this origin, never from an address the model gives.
    readPageOrigin(): Promise<string> {
        return this.withPage(async (page) => {
            const contextId = await createIsolatedContext(page);
            const result = await page.call('Runtime.evaluate', { expression: ORIGIN_EXPRESSION, returnByValue: true, contextId });
            const origin = readEvaluatedValue(result);

            if (typeof origin !== 'string' || origin === '' || origin === 'null') {
                throw new BrowserError('The page has no site of its own. Open a web page first.');
            }

            return origin;
        });
    }

    // Types one part of a saved login, but only when the page is still on the origin the server checked and the focused
    // field fits the part. A user name goes into a plain text field, a password into a secret field.
    typeLogin(site: string, field: LoginField, value: string): Promise<void> {
        return this.typeIntoFocusedField(site, value, LOGIN_FIELD_RULES[field]);
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

    // A connection the caller keeps open, such as the live view of the screen. The caller closes it.
    async connectPage(): Promise<CdpConnection> {
        const socketUrl = await this.findPageSocketUrl();

        try {
            return await CdpConnection.open(socketUrl, this.socketFactory);
        } catch {
            throw new BrowserError('The browser is not running. Try again in a few seconds.');
        }
    }

    private typeIntoFocusedField(site: string, value: string, rule: FieldRule): Promise<void> {
        return this.withPage(async (page) => {
            const contextId = await createIsolatedContext(page);
            const result = await page.call('Runtime.evaluate', { expression: FOCUS_CHECK_EXPRESSION, returnByValue: true, contextId });
            const focus = readEvaluatedValue(result);
            const pageOrigin = readStringField(focus, 'origin');

            if (pageOrigin !== site) {
                throw new BrowserError(`This secret is only for ${site}, and the page is on ${pageOrigin || 'an unknown site'}. Open the right site first.`);
            }

            const focusedTag = readStringField(focus, 'tag');

            if (focusedTag === 'IFRAME') {
                throw new BrowserError('The focused field is inside a frame, which can belong to another site. Click a field on the page itself.');
            }

            const fieldType = readStringField(focus, 'type');
            const fieldAutocomplete = readStringField(focus, 'autocomplete');

            if (!rule.isAllowed(focusedTag, fieldType, fieldAutocomplete)) {
                throw new BrowserError(rule.refusal);
            }

            await page.call('Input.insertText', { text: value });
        });
    }

    private async dispatchClick(page: CdpConnection, point: { x: number; y: number }): Promise<void> {
        await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
        await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
        await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    }

    private async readClickFocus(page: CdpConnection, pointX: number, pointY: number): Promise<{ targetIsTextField: boolean; focusedIsField: boolean }> {
        let value: unknown;

        try {
            const result = await page.call('Runtime.evaluate', { expression: CLICK_FOCUS_EXPRESSION(pointX, pointY), returnByValue: true });

            value = readEvaluatedValue(result);
        } catch (error: unknown) {
            // The click may have started a navigation. That is not a failure, and nothing is clicked again.
            if (error instanceof CdpError && CONTEXT_GONE_PATTERN.test(error.message)) {
                return { targetIsTextField: false, focusedIsField: false };
            }

            throw error;
        }

        return {
            targetIsTextField: typeof value === 'object' && value !== null && Reflect.get(value, 'targetIsTextField') === true,
            focusedIsField: typeof value === 'object' && value !== null && Reflect.get(value, 'focusedIsField') === true,
        };
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
            const readyState = await readReadyState(page);

            if (readyState === 'complete') {
                return;
            }

            await this.sleep(LOAD_POLL_MS);
        }
    }

    private async withPage<T>(action: (page: CdpConnection) => Promise<T>, options: WithPageOptions = {}): Promise<T> {
        const socketUrl = await this.findPageSocketUrl();
        let page: CdpConnection;

        try {
            page = await CdpConnection.open(socketUrl, this.socketFactory);
        } catch {
            throw new BrowserError('The browser is not running. Try again in a few seconds.');
        }

        try {
            await this.watchDialogs(page, options.canRecoverFromDialog === true);

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

    // A dialog that opens during the action is closed with Cancel, or with Leave for a leave-page dialog. Its text is kept for the model.
    // A dialog that was already open blocks Page.enable. Only a navigation gets past it.
    private async watchDialogs(page: CdpConnection, canRecoverFromDialog: boolean): Promise<void> {
        page.onEvent((method, params) => {
            if (method !== 'Page.javascriptDialogOpening') {
                return;
            }

            const message = readStringField(params, 'message');

            const shortMessage = message.slice(0, MAX_DIALOG_TEXT_LENGTH);

            // Cancel on a leave-page dialog would keep the bot on the page, so that one is accepted.
            const shouldAccept = readStringField(params, 'type') === 'beforeunload';

            this.dismissedDialogs.push(shortMessage);
            page.call('Page.handleJavaScriptDialog', { accept: shouldAccept })
                .catch(() => {
                    // The dialog may already be gone, for example after a navigation.
                });
        });

        try {
            await page.call('Page.enable', {}, PAGE_ENABLE_TIMEOUT_MS);
        } catch {
            if (!canRecoverFromDialog) {
                throw new BrowserError(DIALOG_BLOCKED_MESSAGE);
            }
        }
    }

    private currentDevtoolsUrl(): string | undefined {
        return typeof this.devtoolsUrl === 'string' ? this.devtoolsUrl : this.devtoolsUrl();
    }

    private async findPageSocketUrl(): Promise<string> {
        if (this.disabledReason !== undefined) {
            throw new BrowserError(this.disabledReason);
        }

        const devtoolsUrl = this.currentDevtoolsUrl();

        if (devtoolsUrl === undefined) {
            throw new BrowserError(NOT_RUNNING_MESSAGE);
        }

        const devtoolsPort = new URL(devtoolsUrl).port;
        let targets: unknown;

        try {
            const signal = AbortSignal.timeout(DEVTOOLS_HTTP_TIMEOUT_MS);
            const response = await this.fetchFunction(`${devtoolsUrl}/json/list`, { signal });

            targets = await response.json();
        } catch {
            throw new BrowserError(NOT_RUNNING_MESSAGE);
        }

        const pages = Array.isArray(targets) ? (targets as PageTarget[]).filter(target => target.type === 'page') : [];
        const firstPage = pages[0];

        if (firstPage === undefined) {
            return this.openNewPage(devtoolsUrl, devtoolsPort);
        }

        return checkedSocketUrl(firstPage.webSocketDebuggerUrl, devtoolsPort);
    }

    // All tabs can be closed on the screen. Then a new tab opens on Google.
    private async openNewPage(devtoolsUrl: string, devtoolsPort: string): Promise<string> {
        let target: PageTarget | undefined;

        try {
            const signal = AbortSignal.timeout(DEVTOOLS_HTTP_TIMEOUT_MS);
            const response = await this.fetchFunction(`${devtoolsUrl}/json/new?https://www.google.com/`, { method: 'PUT', signal });

            target = await response.json() as PageTarget;
        } catch {
            // Falls through to the same error as a browser with no page.
        }

        if (target?.webSocketDebuggerUrl === undefined) {
            throw new BrowserError('The browser has no open page. Try again in a few seconds.');
        }

        return checkedSocketUrl(target.webSocketDebuggerUrl, devtoolsPort);
    }
}

// The socket of a page must be this browser's own: ws on loopback, on the DevTools port, under /devtools/.
// Anything else is refused, so a bad answer cannot send the bot's commands somewhere else.
function devtoolsSocketUrl(raw: unknown, devtoolsPort: string): string | undefined {
    if (typeof raw !== 'string') {
        return undefined;
    }

    let parsed: URL;

    try {
        parsed = new URL(raw);
    } catch {
        return undefined;
    }

    const isLoopbackHost = parsed.hostname === LOOPBACK_HOSTNAME || parsed.hostname === 'localhost';
    const isOwnPort = parsed.port === devtoolsPort;
    const isDevtoolsPath = parsed.pathname.startsWith('/devtools/');

    return parsed.protocol === 'ws:' && isLoopbackHost && isOwnPort && isDevtoolsPath ? parsed.href : undefined;
}

function checkedSocketUrl(raw: unknown, devtoolsPort: string): string {
    const socketUrl = devtoolsSocketUrl(raw, devtoolsPort);

    if (socketUrl === undefined) {
        throw new BrowserError('The browser gave an address that is not its own, so it was not used.');
    }

    return socketUrl;
}

export { BROWSER_KEYS, BrowserControl, BrowserError, DESKTOP_DEVTOOLS_URL, GATE_REFUSED_ERROR, KEY_DEFINITIONS, MAX_PAGE_TEXT_LENGTH, devtoolsSocketUrl, parseWebUrl };
export type { BrowserControlOptions, BrowserKey, ClickResult, LoginField, PageText };
