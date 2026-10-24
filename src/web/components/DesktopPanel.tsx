import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import RFB from '@novnc/novnc';

import { DEFAULT_DESKTOP_SIZE, MAX_DESKTOP_DIMENSION, MIN_DESKTOP_DIMENSION } from '../../shared/desktopSize.ts';
import type { DesktopSize } from '../../shared/desktopSize.ts';
import type { ScreenHolderName, ScreenViewName } from '../../shared/chatTypes.ts';
import { getScreenHolder, getScreenView, releaseScreen, takeScreen } from '../apiClient.ts';
import { hasTouchScreen, KEYSYMS, keysymOfCharacter } from '../softKeyboard.ts';
import type { ScreenKeyName } from '../softKeyboard.ts';
import { ScreencastView } from './ScreencastView.tsx';
import type { ConnectionState, ScreencastInputMessage } from './ScreencastView.tsx';
import { SoftKeyboardInput } from './SoftKeyboardInput.tsx';

interface DesktopPanelProps {
    onClose: () => void;
}

interface RfbScreenSize {
    w: number;
    h: number;
}

// The two methods of noVNC 1.7 that pick the size of a desktop resize request.
interface RfbResizeInternals {
    _screenSize?: () => RfbScreenSize;
    _requestRemoteResize?: () => void;
}

const VNC_PATH = '/api/desktop/vnc';
// The bot can hand over the screen while the panel is open, so the holder is read again from time to time.
const HOLDER_POLL_MS = 3000;
// Chromium keeps a normal browser window at least this wide.
const MIN_CHROMIUM_WINDOW_WIDTH = 500;
const AUTO_RETRY_MS = 3000;
const MAX_AUTO_RETRIES = 10;

function buildVncUrl(location: Location): string {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';

    return `${scheme}//${location.host}${VNC_PATH}`;
}

function shouldResizeDesktop(viewportWidth: number, isTouchScreen: boolean, isPortrait: boolean): boolean {
    return isTouchScreen && isPortrait && viewportWidth <= 720;
}

function buildVncViewportSize(width: number, height: number, shouldResize: boolean): DesktopSize {
    if (width <= 0 || height <= 0) {
        return DEFAULT_DESKTOP_SIZE;
    }

    const viewportWidth = Math.round(width);
    const viewportHeight = Math.round(height);
    const screenWidth = shouldResize && viewportWidth < MIN_CHROMIUM_WINDOW_WIDTH
        ? MIN_CHROMIUM_WINDOW_WIDTH
        : clamp(viewportWidth, MIN_DESKTOP_DIMENSION, MAX_DESKTOP_DIMENSION);
    const screenHeight = shouldResize
        ? Math.round(viewportHeight * screenWidth / viewportWidth)
        : viewportHeight;
    const boundedHeight = clamp(screenHeight, MIN_DESKTOP_DIMENSION, MAX_DESKTOP_DIMENSION);

    return { width: screenWidth, height: boundedHeight };
}

// noVNC asks for the size of its element and scales the picture into it. Chromium keeps its window at least 500
// pixels wide, so only the request asks for that wider desktop, with the shape of the panel. The picture then
// shrinks into the panel and a touch still lands under the finger.
// ponytail: patches two private methods of noVNC 1.7. Check them when noVNC is updated.
function requestChromiumSizedDesktop(client: RFB): void {
    const internals = client as unknown as RfbResizeInternals;
    const readScreenSize = internals._screenSize?.bind(client);
    const requestResize = internals._requestRemoteResize?.bind(client);

    if (readScreenSize === undefined || requestResize === undefined) {
        return;
    }

    const readDesktopSize = (): RfbScreenSize => {
        const panelSize = readScreenSize();
        const desktopSize = buildVncViewportSize(panelSize.w, panelSize.h, true);

        return { w: desktopSize.width, h: desktopSize.height };
    };

    internals._requestRemoteResize = () => {
        internals._screenSize = readDesktopSize;

        try {
            requestResize();
        } finally {
            internals._screenSize = readScreenSize;
        }
    };
}

function applyVncViewportSize(viewportElement: HTMLElement, targetElement: HTMLElement): void {
    const viewport = viewportElement.getBoundingClientRect();
    const size = buildVncViewportSize(viewport.width, viewport.height, false);
    const width = `${String(size.width)}px`;
    const height = `${String(size.height)}px`;

    targetElement.style.width = width;
    targetElement.style.height = height;
}

// The live screen of the bot. It is view only while the bot holds the screen. The server also drops input then.
function DesktopPanel({ onClose }: DesktopPanelProps): ReactElement {
    const screenViewportRef = useRef<HTMLDivElement>(null);
    const screenRef = useRef<HTMLDivElement>(null);
    const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
    // Bumped by the reconnect button and the automatic retries.
    const [connectAttempt, setConnectAttempt] = useState(0);
    const autoRetriesRef = useRef(0);
    // VNC on the Docker desktop, or the browser's frames in local mode. Unknown until the server answers.
    const [view, setView] = useState<ScreenViewName | undefined>(undefined);
    const clientRef = useRef<RFB | null>(null);
    const [holder, setHolder] = useState<ScreenHolderName>('bot');
    // The connect effect reads the holder from here, so a new client starts with the right mode.
    const holderRef = useRef<ScreenHolderName>('bot');
    // Counts the owner's handoff clicks. A poll that started before a click must not override the click's result.
    const handoffCountRef = useRef(0);
    const [handoffProblem, setHandoffProblem] = useState('');
    // Expanded fills the window so the screen is easier to use.
    const [isExpanded, setIsExpanded] = useState(false);
    const [resizeToViewport, setResizeToViewport] = useState(false);
    // The invisible field that opens the keyboard of a phone, and the way to type on the browser's frames in local mode.
    const keyboardInputRef = useRef<HTMLTextAreaElement>(null);
    const screencastSenderRef = useRef<((input: ScreencastInputMessage) => void) | undefined>(undefined);

    useEffect(() => {
        let isCurrent = true;

        function refreshHolder(): void {
            const handoffCountAtStart = handoffCountRef.current;

            getScreenHolder()
                .then((current) => {
                    if (isCurrent && handoffCountRef.current === handoffCountAtStart) {
                        holderRef.current = current;
                        setHolder(current);
                    }
                })
                .catch(() => undefined);
        }

        refreshHolder();

        const timer = setInterval(refreshHolder, HOLDER_POLL_MS);

        return () => {
            isCurrent = false;
            clearInterval(timer);
        };
    }, []);

    useEffect(() => {
        const orientationQuery = window.matchMedia('(orientation: portrait)');

        function updateViewportMode(): void {
            const isTouchScreen = hasTouchScreen();
            const shouldResize = shouldResizeDesktop(window.innerWidth, isTouchScreen, orientationQuery.matches);

            setResizeToViewport(shouldResize);
        }

        updateViewportMode();
        window.addEventListener('resize', updateViewportMode);
        orientationQuery.addEventListener('change', updateViewportMode);

        return () => {
            window.removeEventListener('resize', updateViewportMode);
            orientationQuery.removeEventListener('change', updateViewportMode);
        };
    }, []);

    useEffect(() => {
        if (view !== undefined) {
            return;
        }

        getScreenView()
            .then(setView)
            .catch(() => {
                setConnectionState('disconnected');
            });
    }, [connectAttempt, view]);

    // The desktop may still be starting, for example right after the bot wakes up. A lost screen is tried again on its own a few times.
    useEffect(() => {
        if (connectionState === 'connected') {
            autoRetriesRef.current = 0;

            return;
        }

        if (connectionState !== 'disconnected' || autoRetriesRef.current >= MAX_AUTO_RETRIES) {
            return;
        }

        const timer = setTimeout(() => {
            autoRetriesRef.current += 1;
            setConnectionState('connecting');
            setConnectAttempt(attempt => attempt + 1);
        }, AUTO_RETRY_MS);

        return () => {
            clearTimeout(timer);
        };
    }, [connectionState]);

    useEffect(() => {
        const viewportElement = screenViewportRef.current;
        const targetElement = screenRef.current;

        if (view !== 'vnc' || viewportElement === null || targetElement === null) {
            return;
        }

        const updateViewportSize = (): void => {
            applyVncViewportSize(viewportElement, targetElement);
        };

        updateViewportSize();

        if (typeof ResizeObserver === 'undefined') {
            return;
        }

        const observer = new ResizeObserver(updateViewportSize);

        observer.observe(viewportElement);

        return () => {
            observer.disconnect();
        };
    }, [view]);

    useEffect(() => {
        if (clientRef.current !== null) {
            clientRef.current.viewOnly = holder !== 'person';
            clientRef.current.resizeSession = holder === 'person' && resizeToViewport;
        }
    }, [holder, connectAttempt, resizeToViewport]);

    function changeHolder(change: () => Promise<ScreenHolderName>): void {
        setHandoffProblem('');
        handoffCountRef.current += 1;
        change()
            .then((current) => {
                holderRef.current = current;
                setHolder(current);
            })
            .catch(() => {
                setHandoffProblem('The screen could not change hands. Try again.');
            });
    }

    // Closing the panel ends the owner's turn on the screen. Otherwise the bot stays blocked with no sign of it on screen.
    // The call also goes out when the last poll says the bot has the screen, since the bot may have handed it over since.
    function handleClose(): void {
        handoffCountRef.current += 1;
        releaseScreen()
            .catch(() => undefined);
        onClose();
    }

    useEffect(() => {
        const screenElement = screenRef.current;
        const viewportElement = screenViewportRef.current;

        if (view !== 'vnc' || screenElement === null || viewportElement === null) {
            return;
        }

        applyVncViewportSize(viewportElement, screenElement);

        const vncUrl = buildVncUrl(window.location);
        const client = new RFB(screenElement, vncUrl);

        requestChromiumSizedDesktop(client);
        client.viewOnly = holderRef.current !== 'person';
        client.scaleViewport = true;
        client.resizeSession = holderRef.current === 'person' && resizeToViewport;
        clientRef.current = client;
        // A client that was cleaned up still reports its close. That must not change the state of its successor.
        let isCurrent = true;

        client.addEventListener('connect', () => {
            if (isCurrent) {
                setConnectionState('connected');
            }
        });
        client.addEventListener('disconnect', () => {
            if (isCurrent) {
                setConnectionState('disconnected');
            }
        });

        return () => {
            isCurrent = false;
            clientRef.current = null;
            client.disconnect();
        };
    }, [connectAttempt, resizeToViewport, view]);

    function typeText(text: string): void {
        if (view === 'screencast') {
            screencastSenderRef.current?.({ type: 'text', text });

            return;
        }

        const client = clientRef.current;

        Array.from(text)
            .forEach((character) => {
                const keysym = keysymOfCharacter(character);

                client?.sendKey(keysym, null);
            });
    }

    function pressKey(key: ScreenKeyName): void {
        if (view === 'screencast') {
            screencastSenderRef.current?.({ type: 'key', key });

            return;
        }

        const keysym = KEYSYMS[key];

        clientRef.current?.sendKey(keysym, null);
    }

    const panelClass = isExpanded ? 'desktop-panel is-expanded' : 'desktop-panel';
    const handoffLabel = holder === 'person' ? 'Done, take over' : 'Take the screen';
    const handoffChange = holder === 'person' ? releaseScreen : takeScreen;

    return (
        <section className={panelClass} aria-label="Bot screen" data-no-pull>
            <div className="desktop-stage">
                {view === 'screencast'
                    ? <ScreencastView holder={holder} attempt={connectAttempt} resizeToViewport={resizeToViewport} onStateChange={setConnectionState} inputSenderRef={screencastSenderRef} />
                    : (
                            <div className={holder === 'person' && resizeToViewport ? 'desktop-screen is-resizing' : 'desktop-screen'} ref={screenViewportRef} data-no-pull>
                                <div className="desktop-vnc-target" ref={screenRef} />
                            </div>
                        )}
                <SoftKeyboardInput inputRef={keyboardInputRef} onText={typeText} onKey={pressKey} />
            </div>
            <div className="desktop-side">
                <h2>Screen</h2>
                <p className="desktop-status">
                    {holder === 'person' ? 'You have the screen. The bot is paused.' : 'The bot has the screen. You can watch.'}
                </p>
                <div className="desktop-actions">
                    <button type="button" onClick={() => { changeHolder(handoffChange); }}>{handoffLabel}</button>
                    {holder === 'person' && hasTouchScreen()
                        ? <button type="button" onClick={() => { keyboardInputRef.current?.focus(); }}>Keyboard</button>
                        : null}
                    <button type="button" aria-pressed={isExpanded} onClick={() => { setIsExpanded(!isExpanded); }}>
                        {isExpanded ? 'Shrink' : 'Expand'}
                    </button>
                    <button type="button" onClick={handleClose}>Close</button>
                </div>
                {handoffProblem === '' ? null : <p className="desktop-status" role="alert">{handoffProblem}</p>}
                {connectionState === 'connecting' ? <p className="desktop-status">Connecting to the screen...</p> : null}
                {connectionState === 'disconnected'
                    ? (
                            <p className="desktop-status" role="alert">
                                The screen is not available. The desktop may be starting.
                                {' '}
                                <button
                                    type="button"
                                    onClick={() => {
                                        autoRetriesRef.current = 0;
                                        setConnectionState('connecting');
                                        setConnectAttempt(attempt => attempt + 1);
                                    }}
                                >
                                    Try again
                                </button>
                            </p>
                        )
                    : null}
            </div>
        </section>
    );
}
function clamp(value: number, lowest: number, highest: number): number {
    const valueAtLeastLowest = Math.max(value, lowest);

    return Math.min(valueAtLeastLowest, highest);
}

export { DesktopPanel, buildVncUrl, buildVncViewportSize, requestChromiumSizedDesktop, shouldResizeDesktop };
