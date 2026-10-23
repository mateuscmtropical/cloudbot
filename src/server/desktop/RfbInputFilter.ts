// Filters the bytes a VNC client sends to x11vnc. While the bot holds the screen, key events,
// pointer events and clipboard text are dropped. All other messages pass.
// x11vnc runs with no password, so the handshake is: 12 bytes of version, 1 byte of security type, 1 byte of ClientInit.
// Only RFB 3.8 is accepted. Older versions let the server pick the security type, so the framing below would shift by a byte.
const VERSION = Buffer.from('RFB 003.008\n');
const AFTER_VERSION_BYTES = 2;
const SET_PIXEL_FORMAT = 0;
const SET_ENCODINGS = 2;
const FRAMEBUFFER_UPDATE_REQUEST = 3;
const KEY_EVENT = 4;
const POINTER_EVENT = 5;
const CLIENT_CUT_TEXT = 6;
const SET_PIXEL_FORMAT_BYTES = 20;
const FRAMEBUFFER_UPDATE_REQUEST_BYTES = 10;
const KEY_EVENT_BYTES = 8;
const POINTER_EVENT_BYTES = 6;
const SET_ENCODINGS_HEADER_BYTES = 4;
const ENCODING_BYTES = 4;
const CLIENT_CUT_TEXT_HEADER_BYTES = 8;
// A message larger than this is not a normal client. The connection ends instead of buffering it.
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

class RfbStreamError extends Error {}

type InputAllowed = () => boolean;

class RfbInputFilter {
    private readonly isInputAllowed: InputAllowed;
    private pending: Buffer = Buffer.alloc(0);
    // The buttons x11vnc holds down, from the last pointer message that was forwarded.
    private forwardedButtons = 0;
    private isVersionRead = false;
    private handshakeBytesLeft = AFTER_VERSION_BYTES;

    constructor(isInputAllowed: InputAllowed) {
        this.isInputAllowed = isInputAllowed;
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
        // A key release always passes, so a key held when the screen changes hands does not stay down.
        const isKeyRelease = type === KEY_EVENT && this.pending[1] === 0;
        const isInput = type === KEY_EVENT || type === POINTER_EVENT || type === CLIENT_CUT_TEXT;
        const buttons = type === POINTER_EVENT ? this.pending[1] ?? 0 : 0;
        const bytes = this.consume(size);
        // A pointer message that only lets go of buttons passes too, so a button held when the screen changes hands does not stay down.
        const isButtonRelease = type === POINTER_EVENT && buttons !== this.forwardedButtons && (buttons & ~this.forwardedButtons) === 0;
        const isForwarded = !isInput || isKeyRelease || isButtonRelease || this.isInputAllowed();

        if (isForwarded && type === POINTER_EVENT) {
            this.forwardedButtons = buttons;
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
            default:
                // An unknown type cannot be framed, and passing it on could hide input messages behind it.
                throw new RfbStreamError('The message type is not known.');
        }
    }
}

export { RfbInputFilter, RfbStreamError };
