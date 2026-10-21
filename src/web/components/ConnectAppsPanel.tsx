import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import type { ConnectedAppStatus, ConnectedAppSummary } from '../../shared/connectedApps.ts';
import { listConnectedApps, removeConnectedApp } from '../apiClient.ts';

interface ConnectAppsPanelProps {
    onClose: () => void;
}

type LoadState = 'loading' | 'ready' | 'failed';

const STATUS_LABELS: Record<ConnectedAppStatus, string> = {
    connected: 'Connected',
    needs_token: 'Needs a token',
    failed: 'Failed',
};

// The remote MCP servers the bot can use. The owner removes one here. The bot connects a server in the chat.
function ConnectAppsPanel({ onClose }: ConnectAppsPanelProps): ReactElement {
    const [apps, setApps] = useState<ConnectedAppSummary[]>([]);
    const [loadState, setLoadState] = useState<LoadState>('loading');
    const [problem, setProblem] = useState<string | undefined>(undefined);
    // Servers with a removal in progress, so a double click sends one request.
    const [removingIds, setRemovingIds] = useState<string[]>([]);

    useEffect(() => {
        let isCurrent = true;

        listConnectedApps()
            .then((loadedApps) => {
                if (isCurrent) {
                    setApps(loadedApps);
                    setLoadState('ready');
                }
            })
            .catch(() => {
                if (isCurrent) {
                    setLoadState('failed');
                }
            });

        return () => {
            isCurrent = false;
        };
    }, []);

    function handleRemove(appId: string): void {
        if (removingIds.includes(appId)) {
            return;
        }

        setProblem(undefined);
        setRemovingIds(currentIds => [...currentIds, appId]);

        removeConnectedApp(appId)
            .then(() => {
                setApps(currentApps => currentApps.filter(app => app.id !== appId));
            })
            .catch(() => {
                setProblem('The server could not be removed.');
            })
            .finally(() => {
                setRemovingIds(currentIds => currentIds.filter(id => id !== appId));
            });
    }

    return (
        <section aria-label="Connect apps" className="webhook-section connect-apps-panel">
            <header className="connect-apps-header">
                <h3>Connect apps</h3>
                <button type="button" className="icon-button" aria-label="Close connect apps" onClick={onClose}>×</button>
            </header>
            <p className="rules-help">
                Remote MCP servers the bot can use. Ask the bot in the chat to connect one by its address.
            </p>
            {loadState === 'loading' ? <p>Loading...</p> : null}
            {loadState === 'failed' ? <p className="rules-problem">The connected servers could not be loaded.</p> : null}
            {loadState === 'ready' && apps.length === 0 ? <p>No servers are connected.</p> : null}
            {problem === undefined ? null : <p className="rules-problem">{problem}</p>}
            <ul className="rules-list">
                {apps.map(app => (
                    <li key={app.id} className="rule-item">
                        <span className="rule-kind">{app.name}</span>
                        <span className="rule-tools">
                            {`${STATUS_LABELS[app.status]}. ${String(app.toolCount)} tools.${app.problem === undefined ? '' : ` ${app.problem}`}`}
                        </span>
                        <button
                            type="button"
                            disabled={removingIds.includes(app.id)}
                            aria-label={`Remove ${app.name}`}
                            onClick={() => {
                                handleRemove(app.id);
                            }}
                        >
                            Remove
                        </button>
                    </li>
                ))}
            </ul>
        </section>
    );
}

export { ConnectAppsPanel };
export type { ConnectAppsPanelProps };
