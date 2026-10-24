import { useCallback, useEffect, useRef } from 'react';
import type { KeyboardEvent, MouseEvent, ReactElement, RefObject, WheelEvent } from 'react';

import { DEFAULT_DESKTOP_SIZE, MAX_DESKTOP_DIMENSION, MIN_DESKTOP_DIMENSION } from '../../shared/desktopSize.ts';
import type { ScreenHolderName } from '../../shared/chatTypes.ts';

type ConnectionState = 'connecting' | 'connected' | 'disconnected';

interface ScreencastViewProps {
    holder: ScreenHolderName;
    // Bumped by the panel's retry button, so the socket opens again.
    attempt: number;
    resizeToViewport: boolean;
    onStateChange: (state: ConnectionState) => void;
    // The panel types on the screen through this, for the keyboard of a phone. The view fills it while it is shown.
    inputSenderRef: RefObject<((input: ScreencastInputMessage) => void) | undefined>;
}

interface ScreencastFrame {
    data: string;
    width: number;
    height: number;
}

interface ScreenRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

interface KeyModifiers {
    ctrlKey: boolean;
    altKey: boolean;
    metaKey: boolean;
    // AltGraph is the key that types a character on a layout that uses it.
    altGraph: boolean;
}

interface MouseInputMessage {
    type: 'mouse';
    kind: 'move' | 'down' | 'up';
    x: number;
    y: number;
}

interface WheelInputMessage {
    type: 'wheel';
    x: number;
    y: number;
    deltaY: number;
}

interface TextInputMessage {
    type: 'text';
    text: string;
}

interface KeyInputMessage {
    type: 'key';
    key: KeyName;
}

interface ResizeInputMessage {
    type: 'resize';
    width: number;
    height: number;
}

type ScreencastInputMessage = MouseInputMessage | WheelInputMessage | TextInputMessage | KeyInputMessage | ResizeInputMessage;
type KeyName = 'Enter' | 'Tab' | 'Escape' | 'Backspace' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'PageUp' | 'PageDown';
type PointerKind = MouseInputMessage['kind'];

// The same keys as the server accepts. Other keys are not sent.
const KEY_NAMES: KeyName[] = ['Enter', 'Tab', 'Escape', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'];
const MAX_WHEEL_PIXELS = 5000;
const DEFAULT_FRAME_WIDTH = 1280;
const DEFAULT_FRAME_HEIGHT = 800;

function buildSocketUrl(location: Location): string {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';

    return `${scheme}//${location.host}/api/desktop/screencast`;
}

// Reads a frame the server sent. Anything else is ignored.
function parseFrame(message: unknown): ScreencastFrame | undefined {
    if (typeof message !== 'string') {
        return undefined;
    }

    let value: unknown;

    try {
        value = JSON.parse(message);
    } catch {
        return undefined;
    }

    if (typeof value !== 'object' || value === null) {
        return undefined;
    }

    const fields = value as Record<string, unknown>;

    if (fields.type !== 'frame' || typeof fields.data !== 'string' || typeof fields.width !== 'number' || typeof fields.height !== 'number') {
        return undefined;
    }

    return { data: fields.data, width: fields.width, height: fields.height };
}

function isKeyName(key: string): key is KeyName {
    return KEY_NAMES.some(name => name === key);
}

// AltGr types a character. Windows sends it as Ctrl with Alt, and other systems as AltGraph.
// On macOS, Option types characters too, so Alt alone is a shortcut only off macOS.
function isShortcutHeld(modifiers: KeyModifiers, isMac: boolean): boolean {
    const isAltGr = modifiers.altGraph || (modifiers.ctrlKey && modifiers.altKey);
    const isAltShortcut = modifiers.altKey && !isMac;

    return modifiers.metaKey || (!isAltGr && (modifiers.ctrlKey || isAltShortcut));
}

function readKeyModifiers(event: KeyboardEvent<HTMLDivElement>): KeyModifiers {
    return {
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        altGraph: event.getModifierState('AltGraph'),
    };
}

function isMacPlatform(): boolean {
    return typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac');
}

// A named key is sent as a key. A printable character is sent as text, unless a shortcut key is held.
function buildKeyInput(key: string, hasShortcutModifier: boolean): ScreencastInputMessage | undefined {
    if (isKeyName(key)) {
        return { type: 'key', key };
    }

    if (key.length === 1 && !hasShortcutModifier) {
        return { type: 'text', text: key };
    }

    return undefined;
}

// Maps a pointer position on the picture to a point of the page, in the page's own pixels.
function buildPointerInput(kind: PointerKind, clientX: number, clientY: number, rect: ScreenRect, frame: ScreencastFrame): MouseInputMessage | undefined {
    if (rect.width <= 0 || rect.height <= 0) {
        return undefined;
    }

    const pageX = Math.round((clientX - rect.left) * frame.width / rect.width);
    const pageY = Math.round((clientY - rect.top) * frame.height / rect.height);
    const clampedX = clamp(pageX, 0, frame.width);
    const clampedY = clamp(pageY, 0, frame.height);

    return { type: 'mouse', kind, x: clampedX, y: clampedY };
}

function buildWheelInput(clientX: number, clientY: number, deltaY: number, rect: ScreenRect, frame: ScreencastFrame): WheelInputMessage | undefined {
    const pointer = buildPointerInput('move', clientX, clientY, rect, frame);

    if (pointer === undefined) {
        return undefined;
    }

    const roundedDelta = Math.round(deltaY);
    const clampedDelta = clamp(roundedDelta, -MAX_WHEEL_PIXELS, MAX_WHEEL_PIXELS);

    return { type: 'wheel', x: pointer.x, y: pointer.y, deltaY: clampedDelta };
}

// The part of the element that holds the picture. The image is shown contained, so bars can sit around it,
// and a click in a bar maps to the edge of the page.
function pictureRect(box: ScreenRect, frame: ScreencastFrame): ScreenRect {
    const scale = Math.min(box.width / frame.width, box.height / frame.height);
    const width = frame.width * scale;
    const height = frame.height * scale;

    return {
        left: box.left + (box.width - width) / 2,
        top: box.top + (box.height - height) / 2,
        width,
        height,
    };
}

function clamp(value: number, lowest: number, highest: number): number {
    const atLeastLowest = Math.max(value, lowest);

    return Math.min(atLeastLowest, highest);
}

function buildResizeInput(width: number, height: number, resizeToViewport: boolean): ResizeInputMessage | undefined {
    if (!resizeToViewport) {
        return { type: 'resize', width: DEFAULT_DESKTOP_SIZE.width, height: DEFAULT_DESKTOP_SIZE.height };
    }

    if (width <= 0 || height <= 0) {
        return undefined;
    }

    const roundedWidth = Math.round(width);
    const roundedHeight = Math.round(height);

    return {
        type: 'resize',
        width: clamp(roundedWidth, MIN_DESKTOP_DIMENSION, MAX_DESKTOP_DIMENSION),
        height: clamp(roundedHeight, MIN_DESKTOP_DIMENSION, MAX_DESKTOP_DIMENSION),
    };
}

// The live view of the bot's browser in local mode. Frames come as pictures, and the owner's input goes back
// only while the owner holds the screen. The server drops input otherwise.
function ScreencastView({ holder, attempt, resizeToViewport, onStateChange, inputSenderRef }: ScreencastViewProps): ReactElement {
    const imageRef = useRef<HTMLImageElement>(null);
    const wrapperRef = useRef<HTMLDivElement>(null);
    const socketRef = useRef<WebSocket | null>(null);
    const holderRef = useRef<ScreenHolderName>(holder);
    const frameRef = useRef<ScreencastFrame>({ data: '', width: DEFAULT_FRAME_WIDTH, height: DEFAULT_FRAME_HEIGHT });
    const lastSentResizeRef = useRef('');

    useEffect(() => {
        holderRef.current = holder;
    }, [holder]);

    const send = useCallback((input: ScreencastInputMessage): void => {
        const socket = socketRef.current;

        if (holderRef.current !== 'person' || socket === null || socket.readyState !== WebSocket.OPEN) {
            return;
        }

        const message = JSON.stringify(input);

        socket.send(message);
    }, []);

    const sendResize = useCallback((): void => {
        const wrapper = wrapperRef.current;
        const socket = socketRef.current;

        if (holderRef.current !== 'person' || wrapper === null || socket === null || socket.readyState !== WebSocket.OPEN) {
            return;
        }

        const bounds = wrapper.getBoundingClientRect();
        const input = buildResizeInput(bounds.width, bounds.height, resizeToViewport);

        if (input === undefined) {
            return;
        }

        const resizeKey = `${String(input.width)}x${String(input.height)}`;

        if (lastSentResizeRef.current === resizeKey) {
            return;
        }

        send(input);
        lastSentResizeRef.current = resizeKey;
    }, [resizeToViewport, send]);

    useEffect(() => {
        lastSentResizeRef.current = '';
        const socketUrl = buildSocketUrl(window.location);
        const socket = new WebSocket(socketUrl);

        socketRef.current = socket;
        function handleOpen(): void {
            onStateChange('connected');
            sendResize();
        }

        socket.addEventListener('open', handleOpen);
        socket.addEventListener('message', (event: MessageEvent<unknown>) => {
            const frame = parseFrame(event.data);

            if (frame === undefined) {
                return;
            }

            frameRef.current = frame;

            if (imageRef.current !== null) {
                imageRef.current.src = `data:image/jpeg;base64,${frame.data}`;
            }
        });
        socket.addEventListener('close', () => {
            if (socketRef.current === socket) {
                onStateChange('disconnected');
            }
        });

        return () => {
            socketRef.current = null;
            socket.close();
        };
    }, [attempt, onStateChange, sendResize]);

    useEffect(() => {
        if (holder === 'person') {
            sendResize();

            return;
        }

        lastSentResizeRef.current = '';
    }, [holder, resizeToViewport, sendResize]);

    useEffect(() => {
        const wrapper = wrapperRef.current;

        if (!resizeToViewport || holder !== 'person' || wrapper === null || typeof ResizeObserver === 'undefined') {
            return;
        }

        const observer = new ResizeObserver(sendResize);

        observer.observe(wrapper);

        return () => {
            observer.disconnect();
        };
    }, [holder, resizeToViewport, sendResize]);

    useEffect(() => {
        inputSenderRef.current = send;

        return () => {
            inputSenderRef.current = undefined;
        };
    });

    function pointerRect(): ScreenRect | undefined {
        const image = imageRef.current;

        if (image === null) {
            return undefined;
        }

        const box = image.getBoundingClientRect();
        const frame = frameRef.current;

        return pictureRect(box, frame);
    }

    function sendPointer(kind: PointerKind, event: MouseEvent<HTMLImageElement>): void {
        const rect = pointerRect();

        if (rect === undefined) {
            return;
        }

        const input = buildPointerInput(kind, event.clientX, event.clientY, rect, frameRef.current);

        if (input !== undefined) {
            send(input);
        }
    }

    function handleMouseDown(event: MouseEvent<HTMLImageElement>): void {
        wrapperRef.current?.focus();
        sendPointer('down', event);
    }

    function handleWheel(event: WheelEvent<HTMLImageElement>): void {
        const rect = pointerRect();

        if (rect === undefined) {
            return;
        }

        const input = buildWheelInput(event.clientX, event.clientY, event.deltaY, rect, frameRef.current);

        if (input !== undefined) {
            send(input);
        }
    }

    function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
        const modifiers = readKeyModifiers(event);
        const isMac = isMacPlatform();
        const shortcutHeld = isShortcutHeld(modifiers, isMac);
        const input = buildKeyInput(event.key, shortcutHeld);

        if (input === undefined || holderRef.current !== 'person') {
            return;
        }

        event.preventDefault();
        send(input);
    }

    const wrapperClassName = resizeToViewport ? 'desktop-screen screencast is-resizing' : 'desktop-screen screencast';

    return (
        <div className={wrapperClassName} ref={wrapperRef} tabIndex={0} onKeyDown={handleKeyDown} data-no-pull>
            <img
                ref={imageRef}
                alt="The bot's browser"
                draggable={false}
                onMouseDown={handleMouseDown}
                onMouseUp={(event) => { sendPointer('up', event); }}
                onMouseMove={(event) => { sendPointer('move', event); }}
                onWheel={handleWheel}
            />
        </div>
    );
}

export { ScreencastView, buildKeyInput, buildPointerInput, buildResizeInput, buildSocketUrl, buildWheelInput, isShortcutHeld, parseFrame, pictureRect };
export type { ConnectionState, ScreencastFrame, ScreencastInputMessage };
