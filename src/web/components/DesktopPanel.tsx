import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import RFB from '@novnc/novnc';

import type { ScreenHolderName } from '../../shared/chatTypes.ts';
import { getScreenHolder, releaseScreen, takeScreen } from '../apiClient.ts';

interface DesktopPanelProps {
    onClose: () => void;
}

type ConnectionState = 'connecting' | 'connected' | 'disconnected';

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
    const clientRef = useRef<RFB | null>(null);
    const [holder, setHolder] = useState<ScreenHolderName>('bot');
    const [handoffProblem, setHandoffProblem] = useState('');

    useEffect(() => {
        let isCurrent = true;

        function refreshHolder(): void {
            getScreenHolder()
                .then((current) => {
                    if (isCurrent) {
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
        if (clientRef.current !== null) {
            clientRef.current.viewOnly = holder !== 'person';
        }
    }, [holder, connectAttempt]);

    function changeHolder(change: () => Promise<ScreenHolderName>): void {
        setHandoffProblem('');
        change()
            .then(setHolder)
            .catch(() => {
                setHandoffProblem('The screen could not change hands. Try again.');
            });
    }

    useEffect(() => {
        const screenElement = screenRef.current;

        if (screenElement === null) {
            return;
        }

        const vncUrl = buildVncUrl(window.location);
        const client = new RFB(screenElement, vncUrl);

        client.viewOnly = true;
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
    }, [connectAttempt]);

    return (
        <section className="desktop-panel" aria-label="Bot screen">
            <div className="desktop-header">
                <h2>Screen</h2>
                <button type="button" onClick={onClose}>Close</button>
            </div>
            <p className="desktop-status">
                {holder === 'person' ? 'You have the screen. The bot is paused.' : 'The bot has the screen. You can watch.'}
            </p>
            <div className="desktop-actions">
                {holder === 'person'
                    ? (
                            <>
                                <button type="button" onClick={() => { changeHolder(releaseScreen); }}>Done, take over</button>
                                <button type="button" onClick={onClose}>I will keep it</button>
                            </>
                        )
                    : <button type="button" onClick={() => { changeHolder(takeScreen); }}>Take the screen</button>}
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
            <div className="desktop-screen" ref={screenRef} />
        </section>
    );
}

export { DesktopPanel, buildVncUrl };
