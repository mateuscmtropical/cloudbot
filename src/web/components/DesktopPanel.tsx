import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import RFB from '@novnc/novnc';

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

const VNC_PATH = '/api/desktop/vnc';
// The bot can hand over the screen while the panel is open, so the holder is read again from time to time.
const HOLDER_POLL_MS = 3000;

function buildVncUrl(location: Location): string {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';

    return `${scheme}//${location.host}${VNC_PATH}`;
}

// The live screen of the bot. It is view only while the bot holds the screen. The server also drops input then.
function DesktopPanel({ onClose }: DesktopPanelProps): ReactElement {
    const screenRef = useRef<HTMLDivElement>(null);
    const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
    // Bumped by the reconnect button.
    const [connectAttempt, setConnectAttempt] = useState(0);
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
        getScreenView()
            .then(setView)
            .catch(() => {
                setConnectionState('disconnected');
            });
    }, []);

    useEffect(() => {
        if (clientRef.current !== null) {
            clientRef.current.viewOnly = holder !== 'person';
        }
    }, [holder, connectAttempt]);

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

        if (view !== 'vnc' || screenElement === null) {
            return;
        }

        const vncUrl = buildVncUrl(window.location);
        const client = new RFB(screenElement, vncUrl);

        client.viewOnly = holderRef.current !== 'person';
        client.scaleViewport = true;
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
    }, [connectAttempt, view]);

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
        <section className={panelClass} aria-label="Bot screen">
            <div className="desktop-stage">
                {view === 'screencast'
                    ? <ScreencastView holder={holder} attempt={connectAttempt} onStateChange={setConnectionState} inputSenderRef={screencastSenderRef} />
                    : <div className="desktop-screen" ref={screenRef} />}
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
export { DesktopPanel, buildVncUrl };
