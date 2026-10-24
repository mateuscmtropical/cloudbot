import { z } from 'zod/v4';

import type { DesktopSize } from '../../shared/desktopSize.ts';
import { MAX_DESKTOP_DIMENSION, MIN_DESKTOP_DIMENSION, isValidDesktopSize } from '../../shared/desktopSize.ts';
import type { CdpConnection } from './CdpConnection.ts';
import { BROWSER_KEYS, KEY_DEFINITIONS } from './BrowserControl.ts';

// The live view of the bot's browser in local mode. Chrome sends JPEG frames over DevTools, and the owner's
// mouse and keyboard go back to the same page. It is used only while the owner holds the screen.
type ScreencastPage = Pick<CdpConnection, 'call' | 'onEvent' | 'close'>;

interface ScreencastSessionOptions {
    page: ScreencastPage;
    // Sends one text message to the owner's panel.
    send: (message: string) => void;
    isPersonHolding: () => boolean;
    // Bytes the socket has not sent yet. Frames are dropped above a limit, so a slow panel cannot grow the queue.
    bufferedAmount: () => number;
    requestViewport?: (size: DesktopSize) => Promise<void>;
    restoreAllViewports?: () => Promise<void>;
    releaseViewport?: () => Promise<void>;
}

interface ScreencastFrameMessage {
    type: 'frame';
    data: string;
    width: number;
    height: number;
}

const JPEG_QUALITY = 60;
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_LENGTH = 1000;
const MAX_WHEEL_PIXELS = 5000;
// The panel scales its view to the page. A larger page than the frame still sends clicks in its own pixels.
const MAX_POINT_COORDINATE = 10000;

const mouseInputSchema = z.object({
    type: z.literal('mouse'),
    kind: z.enum(['move', 'down', 'up']),
    x: z.number()
        .min(0)
        .max(MAX_POINT_COORDINATE),
    y: z.number()
        .min(0)
        .max(MAX_POINT_COORDINATE),
});
const wheelInputSchema = z.object({
    type: z.literal('wheel'),
    x: z.number()
        .min(0)
        .max(MAX_POINT_COORDINATE),
    y: z.number()
        .min(0)
        .max(MAX_POINT_COORDINATE),
    deltaY: z.number()
        .min(-MAX_WHEEL_PIXELS)
        .max(MAX_WHEEL_PIXELS),
});
const textInputSchema = z.object({
    type: z.literal('text'),
    text: z.string()
        .min(1)
        .max(MAX_TEXT_LENGTH),
});
const keyInputSchema = z.object({
    type: z.literal('key'),
    key: z.enum(BROWSER_KEYS),
});
const resizeInputSchema = z.object({
    type: z.literal('resize'),
    width: z.number()
        .int()
        .min(MIN_DESKTOP_DIMENSION)
        .max(MAX_DESKTOP_DIMENSION),
    height: z.number()
        .int()
        .min(MIN_DESKTOP_DIMENSION)
        .max(MAX_DESKTOP_DIMENSION),
})
    .refine(size => isValidDesktopSize(size.width, size.height));
const inputSchema = z.discriminatedUnion('type', [mouseInputSchema, wheelInputSchema, textInputSchema, keyInputSchema, resizeInputSchema]);
const frameSchema = z.object({
    data: z.string(),
    sessionId: z.number(),
    metadata: z.object({
        deviceWidth: z.number(),
        deviceHeight: z.number(),
    }),
});

type ScreencastInput = z.infer<typeof inputSchema>;
type ScreencastMouseInput = Extract<ScreencastInput, { type: 'mouse' }>;

interface ScreencastPoint {
    x: number;
    y: number;
}

// Anything that is not one known input is dropped. The owner's panel is the only sender.
function parseScreencastInput(text: string): ScreencastInput | undefined {
    let value: unknown;

    try {
        value = JSON.parse(text);
    } catch {
        return undefined;
    }

    const parsed = inputSchema.safeParse(value);

    return parsed.success ? parsed.data : undefined;
}

// Maps one owner input to DevTools input events of the page.
async function dispatchScreencastInput(page: ScreencastPage, input: Exclude<ScreencastInput, { type: 'resize' }>): Promise<void> {
    if (input.type === 'mouse') {
        const point = { x: input.x, y: input.y };
        const isMove = input.kind === 'move';
        const eventType = input.kind === 'down' ? 'mousePressed' : 'mouseReleased';

        if (isMove) {
            await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });

            return;
        }

        await page.call('Input.dispatchMouseEvent', { type: eventType, ...point, button: 'left', clickCount: 1 });

        return;
    }

    if (input.type === 'wheel') {
        await page.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: input.x, y: input.y, deltaX: 0, deltaY: input.deltaY });

        return;
    }

    if (input.type === 'text') {
        await page.call('Input.insertText', { text: input.text });

        return;
    }

    const definition = KEY_DEFINITIONS[input.key];
    const textOption = definition.text === undefined ? {} : { text: definition.text };
    const keyFields = { key: input.key, code: definition.code, windowsVirtualKeyCode: definition.keyCode };

    await page.call('Input.dispatchKeyEvent', { type: 'keyDown', ...keyFields, ...textOption });
    await page.call('Input.dispatchKeyEvent', { type: 'keyUp', ...keyFields });
}

// One owner's view of one page. Frames are acknowledged at once, so Chrome keeps sending them.
// Inputs run one after another, so a press and its release keep their order.
class ScreencastSession {
    private readonly options: ScreencastSessionOptions;
    private inputQueue: Promise<void> = Promise.resolve();
    // The newest move that waits in the queue. A move only shows where the pointer is, so only the latest one is sent.
    private pendingMove: ScreencastMouseInput | undefined;
    private isMoveQueued = false;
    // The left button is down on the page, so it must be released when the owner gives up the screen.
    private isButtonDown = false;
    private lastPoint: ScreencastPoint = { x: 0, y: 0 };
    private isStopped = false;

    constructor(options: ScreencastSessionOptions) {
        this.options = options;
    }

    async start(): Promise<void> {
        this.options.page.onEvent((method, params) => {
            this.handleEvent(method, params);
        });
        await this.options.page.call('Page.enable');
        await this.options.page.call('Page.startScreencast', { format: 'jpeg', quality: JPEG_QUALITY, maxWidth: MAX_DESKTOP_DIMENSION, maxHeight: MAX_DESKTOP_DIMENSION, everyNthFrame: 1 });
    }

    // Inputs from the panel. They reach the page only while the owner holds the screen.
    handleInput(text: string): void {
        if (!this.options.isPersonHolding()) {
            return;
        }

        const input = parseScreencastInput(text);

        if (input === undefined) {
            return;
        }

        if (input.type === 'mouse' && input.kind === 'move') {
            this.queueMove(input);

            return;
        }

        this.enqueue(() => this.runInput(input));
    }

    // Releases a button the owner pressed, when the screen goes to the bot. The check on the holder does not apply here,
    // since the release is the change the holder asked for.
    releaseHeldButton(): void {
        this.enqueue(() => this.releaseIfHeld());
    }

    restoreViewport(): void {
        this.enqueue(async () => {
            await this.restoreAllViewports();
        });
    }

    stop(): void {
        this.isStopped = true;
        // The release goes first, so the page does not keep the button down after the panel closes.
        this.inputQueue
            .then(() => this.releaseIfHeld())
            .catch(() => {
                // A failed release is not retried. The page closes below.
            })
            .then(() => this.releaseViewport())
            .catch(() => {
                // The page may be gone already. Closing the connection stops the frames anyway.
            })
            .then(() => this.options.page.call('Page.stopScreencast'))
            .catch(() => {
                // The page may be gone already. Closing the connection stops the frames anyway.
            })
            .finally(() => {
                this.options.page.close();
            });
    }

    private enqueue(task: () => Promise<void>): void {
        this.inputQueue = this.inputQueue
            .then(task)
            .catch(() => {
                // A failed input is dropped. The next one still runs.
            });
    }

    // Moves replace the waiting one. One queued task sends whichever move is the latest when its turn comes.
    private queueMove(move: ScreencastMouseInput): void {
        this.pendingMove = move;

        if (this.isMoveQueued) {
            return;
        }

        this.isMoveQueued = true;
        this.enqueue(() => this.runPendingMove());
    }

    private runPendingMove(): Promise<void> {
        const move = this.pendingMove;

        this.isMoveQueued = false;
        this.pendingMove = undefined;

        if (move === undefined) {
            return Promise.resolve();
        }

        return this.runInput(move);
    }

    // The owner may have let go of the screen while the input waited, so the check runs again here.
    private runInput(input: ScreencastInput): Promise<void> {
        if (this.isStopped || !this.options.isPersonHolding()) {
            return Promise.resolve();
        }

        return this.dispatch(input);
    }

    private releaseIfHeld(): Promise<void> {
        if (!this.isButtonDown) {
            return Promise.resolve();
        }

        const release: ScreencastMouseInput = { type: 'mouse', kind: 'up', x: this.lastPoint.x, y: this.lastPoint.y };

        return this.dispatch(release);
    }

    private dispatch(input: ScreencastInput): Promise<void> {
        if (input.type === 'resize') {
            return this.requestViewport({ width: input.width, height: input.height });
        }

        if (input.type === 'mouse') {
            this.lastPoint = { x: input.x, y: input.y };
        }

        if (input.type === 'mouse' && input.kind === 'down') {
            this.isButtonDown = true;
        }

        if (input.type === 'mouse' && input.kind === 'up') {
            this.isButtonDown = false;
        }

        return dispatchScreencastInput(this.options.page, input);
    }

    private requestViewport(size: DesktopSize): Promise<void> {
        if (this.options.requestViewport !== undefined) {
            return this.options.requestViewport(size);
        }

        return this.options.page.call('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1, mobile: false })
            .then(() => undefined);
    }

    private restoreAllViewports(): Promise<void> {
        if (this.options.restoreAllViewports !== undefined) {
            return this.options.restoreAllViewports();
        }

        return this.clearViewportOverride();
    }

    private releaseViewport(): Promise<void> {
        if (this.options.releaseViewport !== undefined) {
            return this.options.releaseViewport();
        }

        return this.clearViewportOverride();
    }

    private async clearViewportOverride(): Promise<void> {
        await this.options.page.call('Emulation.clearDeviceMetricsOverride');
    }

    private handleEvent(method: string, params: unknown): void {
        if (method !== 'Page.screencastFrame') {
            return;
        }

        const parsed = frameSchema.safeParse(params);

        if (!parsed.success) {
            return;
        }

        const frame = parsed.data;

        this.options.page.call('Page.screencastFrameAck', { sessionId: frame.sessionId })
            .catch(() => {
                // The page may be gone. The socket closes after that.
            });

        if (this.options.bufferedAmount() > MAX_BUFFERED_BYTES) {
            return;
        }

        const message: ScreencastFrameMessage = {
            type: 'frame',
            data: frame.data,
            width: frame.metadata.deviceWidth,
            height: frame.metadata.deviceHeight,
        };

        const messageText = JSON.stringify(message);

        this.options.send(messageText);
    }
}

export { MAX_BUFFERED_BYTES, MAX_POINT_COORDINATE, ScreencastSession, dispatchScreencastInput, parseScreencastInput };
export type { ScreencastFrameMessage, ScreencastInput, ScreencastPage, ScreencastSessionOptions };
