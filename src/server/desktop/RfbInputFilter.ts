import { isValidDesktopSize } from '../../shared/desktopSize.ts';
import type { DesktopSize } from '../../shared/desktopSize.ts';

// Filters the bytes a VNC client sends to TigerVNC. While the bot holds the screen, key events,
// pointer events, clipboard text and desktop resize requests are dropped. Other messages pass.
// TigerVNC has no password, so the handshake is: 12 bytes of version, 1 byte of security type, 1 byte of ClientInit.
// Only RFB 3.8 is accepted. Older versions let the server pick the security type, so the framing below would shift by a byte.
const VERSION = Buffer.from('RFB 003.008\n');
const AFTER_VERSION_BYTES = 2;
const SET_PIXEL_FORMAT = 0;
const SET_ENCODINGS = 2;
const FRAMEBUFFER_UPDATE_REQUEST = 3;
const KEY_EVENT = 4;
const POINTER_EVENT = 5;
const CLIENT_CUT_TEXT = 6;
const SET_DESKTOP_SIZE = 251;
const SET_PIXEL_FORMAT_BYTES = 20;
const FRAMEBUFFER_UPDATE_REQUEST_BYTES = 10;
const KEY_EVENT_BYTES = 8;
const POINTER_EVENT_BYTES = 6;
const SET_DESKTOP_SIZE_BYTES = 24;
const SET_ENCODINGS_HEADER_BYTES = 4;
const ENCODING_BYTES = 4;
const CLIENT_CUT_TEXT_HEADER_BYTES = 8;
// A message larger than this is not a normal client. The connection ends instead of buffering it.
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

class RfbStreamError extends Error {}

type InputAllowed = () => boolean;
type DesktopResizeRequested = (size: DesktopSize) => void;

class RfbInputFilter {
    private readonly isInputAllowed: InputAllowed;
    private readonly onDesktopResize: DesktopResizeRequested | undefined;
    private pending: Buffer = Buffer.alloc(0);
    // The buttons x11vnc holds down, from the last pointer message that was forwarded.
    private forwardedButtons = 0;
    private isVersionRead = false;
    private handshakeBytesLeft = AFTER_VERSION_BYTES;
    private didForwardDesktopResize = false;

    constructor(isInputAllowed: InputAllowed, onDesktopResize?: DesktopResizeRequested) {
        this.isInputAllowed = isInputAllowed;
        this.onDesktopResize = onDesktopResize;
    }

    get hasRequestedDesktopResize(): boolean {
        return this.didForwardDesktopResize;
    }

    clearRequestedDesktopResize(): void {
        this.didForwardDesktopResize = false;
    }

    // Returns the bytes to forward. It throws RfbStreamError for a stream that does not follow the protocol.
    filter(chunk: Buffer): Buffer {
        this.pending = Buffer.concat([this.pending, chunk]);

        const forwarded = this.takeAll();

        if (this.pending.length > MAX_MESSAGE_BYTES) {
            throw new RfbStreamError('The message is too large.');
        }

        return Buffer.concat(forwarded);
    }

    // Takes every complete message from the pending bytes and returns the ones to forward.
    private takeAll(): Buffer[] {
        const message = this.takeMessage();

        if (message === undefined) {
            return [];
        }

        const rest = this.takeAll();

        return message.isForwarded ? [message.bytes, ...rest] : rest;
    }

    private takeMessage(): { bytes: Buffer; isForwarded: boolean } | undefined {
        if (this.pending.length === 0) {
            return undefined;
        }

        if (!this.isVersionRead) {
            if (this.pending.length < VERSION.length) {
                return undefined;
            }

            if (!this.pending.subarray(0, VERSION.length)
                .equals(VERSION)) {
                throw new RfbStreamError('Only RFB 3.8 is supported.');
            }

            this.isVersionRead = true;

            return { bytes: this.consume(VERSION.length), isForwarded: true };
        }

        if (this.handshakeBytesLeft > 0) {
            const size = Math.min(this.handshakeBytesLeft, this.pending.length);

            this.handshakeBytesLeft -= size;

            return { bytes: this.consume(size), isForwarded: true };
        }

        const size = this.messageSize();

        if (size === undefined || this.pending.length < size) {
            return undefined;
        }

        const type = this.pending[0];
        const isDesktopResize = type === SET_DESKTOP_SIZE;

        if (isDesktopResize && !this.isValidDesktopResize()) {
            throw new RfbStreamError('The desktop resize request is invalid.');
        }

        // A key release always passes, so a key held when the screen changes hands does not stay down.
        const isKeyRelease = type === KEY_EVENT && this.pending[1] === 0;
        const isInput = type === KEY_EVENT || type === POINTER_EVENT || type === CLIENT_CUT_TEXT || isDesktopResize;
        const buttons = type === POINTER_EVENT ? this.pending[1] ?? 0 : 0;
        const requestedSize = isDesktopResize
            ? { width: this.pending.readUInt16BE(2), height: this.pending.readUInt16BE(4) }
            : undefined;
        const bytes = this.consume(size);
        // A pointer message that only lets go of buttons passes too, so a button held when the screen changes hands does not stay down.
        const isButtonRelease = type === POINTER_EVENT && buttons !== this.forwardedButtons && (buttons & ~this.forwardedButtons) === 0;
        const isForwarded = !isInput || isKeyRelease || isButtonRelease || this.isInputAllowed();

        if (isForwarded && type === POINTER_EVENT) {
            this.forwardedButtons = buttons;
        }

        if (isForwarded && requestedSize !== undefined) {
            this.didForwardDesktopResize = true;
            this.onDesktopResize?.(requestedSize);
        }

        return { bytes, isForwarded };
    }

    private consume(size: number): Buffer {
        const bytes = this.pending.subarray(0, size);

        this.pending = this.pending.subarray(size);

        return bytes;
    }

    // The extended clipboard of noVNC sends the length as a negative number. Its size is the absolute value.
    // Read as unsigned, that is almost 4 GB, and the filter would wait for it and hold back every later message.
    private readCutTextLength(): number {
        const length = this.pending.readInt32BE(4);

        return Math.abs(length);
    }

    // The size of the first pending message, or undefined when its header is not complete.
    private messageSize(): number | undefined {
        switch (this.pending[0]) {
            case SET_PIXEL_FORMAT:
                return SET_PIXEL_FORMAT_BYTES;
            case FRAMEBUFFER_UPDATE_REQUEST:
                return FRAMEBUFFER_UPDATE_REQUEST_BYTES;
            case KEY_EVENT:
                return KEY_EVENT_BYTES;
            case POINTER_EVENT:
                return POINTER_EVENT_BYTES;
            case SET_ENCODINGS:
                return this.pending.length < SET_ENCODINGS_HEADER_BYTES
                    ? undefined
                    : SET_ENCODINGS_HEADER_BYTES + (this.pending.readUInt16BE(2) * ENCODING_BYTES);
            case CLIENT_CUT_TEXT:
                return this.pending.length < CLIENT_CUT_TEXT_HEADER_BYTES
                    ? undefined
                    : CLIENT_CUT_TEXT_HEADER_BYTES + this.readCutTextLength();
            case SET_DESKTOP_SIZE:
                if (this.pending.length < 8) {
                    return undefined;
                }

                if (this.pending[6] !== 1) {
                    throw new RfbStreamError('Only one desktop screen is supported.');
                }

                return SET_DESKTOP_SIZE_BYTES;
            default:
                // An unknown type cannot be framed, and passing it on could hide input messages behind it.
                throw new RfbStreamError('The message type is not known.');
        }
    }

    private isValidDesktopResize(): boolean {
        const width = this.pending.readUInt16BE(2);
        const height = this.pending.readUInt16BE(4);
        // The screen id is not checked. noVNC sends back the id the server gave, and TigerVNC picks a random one.
        const screenX = this.pending.readUInt16BE(12);
        const screenY = this.pending.readUInt16BE(14);
        const screenWidth = this.pending.readUInt16BE(16);
        const screenHeight = this.pending.readUInt16BE(18);
        const screenFlags = this.pending.readUInt32BE(20);

        return isValidDesktopSize(width, height)
            && screenX === 0
            && screenY === 0
            && screenWidth === width
            && screenHeight === height
            && screenFlags === 0;
    }
}

function buildSetDesktopSizeMessage(size: DesktopSize): Buffer {
    const message = Buffer.alloc(SET_DESKTOP_SIZE_BYTES);

    message.writeUInt8(SET_DESKTOP_SIZE, 0);
    message.writeUInt8(0, 1);
    message.writeUInt16BE(size.width, 2);
    message.writeUInt16BE(size.height, 4);
    message.writeUInt8(1, 6);
    message.writeUInt8(0, 7);
    message.writeUInt32BE(0, 8);
    message.writeUInt16BE(0, 12);
    message.writeUInt16BE(0, 14);
    message.writeUInt16BE(size.width, 16);
    message.writeUInt16BE(size.height, 18);
    message.writeUInt32BE(0, 20);

    return message;
}

export { RfbInputFilter, RfbStreamError, buildSetDesktopSizeMessage };
