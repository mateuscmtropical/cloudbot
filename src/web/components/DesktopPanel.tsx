import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import RFB from '@novnc/novnc';

interface DesktopPanelProps {
    onClose: () => void;
}

type ConnectionState = 'connecting' | 'connected' | 'disconnected';

const VNC_PATH = '/api/desktop/vnc';

function buildVncUrl(location: Location): string {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';

    return `${scheme}//${location.host}${VNC_PATH}`;
}

// The live screen of the bot. It is view only. The handoff will add control in a later change.
function DesktopPanel({ onClose }: DesktopPanelProps): ReactElement {
    const screenRef = useRef<HTMLDivElement>(null);
    const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
    // Bumped by the reconnect button.
    const [connectAttempt, setConnectAttempt] = useState(0);

    useEffect(() => {
        const screenElement = screenRef.current;

        if (screenElement === null) {
            return;
        }

        const vncUrl = buildVncUrl(window.location);
        const client = new RFB(screenElement, vncUrl);

        client.viewOnly = true;
        client.scaleViewport = true;
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
            client.disconnect();
        };
    }, [connectAttempt]);

    return (
        <section className="desktop-panel" aria-label="Bot screen">
            <div className="desktop-header">
                <h2>Screen</h2>
                <button type="button" onClick={onClose}>Close</button>
            </div>
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
