import { useEffect, useState } from 'react';
import type { ReactElement, SyntheticEvent } from 'react';

import type { ConnectedAppStatus, ConnectedAppSummary } from '../../shared/connectedApps.ts';
import { listConnectedApps, removeConnectedApp, startAppConnection } from '../apiClient.ts';
import { CloseIcon } from './CloseIcon.tsx';

interface ConnectAppsPanelProps {
    onClose: () => void;
    selectedBotId: string | undefined;
}

type LoadState = 'loading' | 'ready' | 'failed';
type AppIconName = 'linear' | 'notion' | 'custom';

interface KnownApp {
    serverName: string;
    displayName: string;
    description: string;
    url: string;
    icon: AppIconName;
}

interface AppIconProps {
    name: AppIconName;
}

const KNOWN_APPS: KnownApp[] = [
    {
        serverName: 'linear',
        displayName: 'Linear',
        description: 'Find issues and update your team’s work.',
        url: 'https://mcp.linear.app/mcp',
        icon: 'linear',
    },
    {
        serverName: 'notion',
        displayName: 'Notion',
        description: 'Search your workspace and manage pages.',
        url: 'https://mcp.notion.com/mcp',
        icon: 'notion',
    },
];

function getStatusLabel(status: ConnectedAppStatus): string {
    if (status === 'needs_token') {
        return 'Sign-in needed. Finish in chat.';
    }

    if (status === 'failed') {
        return 'Could not connect. Open chat for details.';
    }

    return 'Connected.';
}

function getCustomAppName(address: string): string | undefined {
    try {
        const parsedAddress = new URL(address);

        if (parsedAddress.protocol !== 'http:' && parsedAddress.protocol !== 'https:') {
            return undefined;
        }

        if (parsedAddress.username !== '' || parsedAddress.password !== '' || parsedAddress.search !== '' || parsedAddress.hash !== '') {
            return undefined;
        }

        const hostnameSlug = parsedAddress.hostname.toLowerCase()
            .replaceAll(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 24)
            .replace(/-$/g, '');

        return hostnameSlug.length === 0 ? undefined : `custom-${hostnameSlug}`;
    } catch {
        return undefined;
    }
}

function getCustomDisplayName(app: ConnectedAppSummary): string {
    try {
        const parsedAddress = new URL(app.url);
        const hostnameLabels = parsedAddress.hostname.split('.');
        const displayLabels = hostnameLabels.filter(label => label.toLowerCase() !== 'mcp');
        const displayName = displayLabels.join('.');

        return displayName.length === 0 ? 'Custom app' : displayName;
    } catch {
        return 'Custom app';
    }
}

function AppIcon({ name }: AppIconProps): ReactElement {
    if (name === 'custom') {
        return (
            <span className="connect-app-icon connect-app-icon-custom" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                    <path d="M9.5 14.5 14.5 9.5M8 16l-1.5 1.5a4 4 0 0 1-5.7-5.7l4-4a4 4 0 0 1 5.7 0M16 8l1.5-1.5a4 4 0 0 1 5.7 5.7l-4 4a4 4 0 0 1-5.7 0" />
                </svg>
            </span>
        );
    }

    const initial = name === 'linear' ? 'L' : 'N';

    return <span className={`connect-app-icon connect-app-icon-${name}`} aria-hidden="true">{initial}</span>;
}

function ConnectAppsPanel({ onClose, selectedBotId }: ConnectAppsPanelProps): ReactElement {
    const [apps, setApps] = useState<ConnectedAppSummary[]>([]);
    const [loadState, setLoadState] = useState<LoadState>('loading');
    const [problem, setProblem] = useState<string | undefined>(undefined);
    const [customAddress, setCustomAddress] = useState('');
    const [startingAppName, setStartingAppName] = useState<string | undefined>(undefined);
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

    function handleConnect(appName: string, appUrl: string): void {
        if (selectedBotId === undefined || startingAppName !== undefined) {
            return;
        }

        setProblem(undefined);
        setStartingAppName(appName);

        const connectionRequest = startAppConnection(selectedBotId, appName, appUrl);

        connectionRequest
            .then(() => {
                onClose();
            })
            .catch(() => {
                setProblem('The connection could not be started. Try again from chat.');
            })
            .finally(() => {
                setStartingAppName(undefined);
            });
    }

    function handleCustomSubmit(event: SyntheticEvent<HTMLFormElement>): void {
        event.preventDefault();

        const address = customAddress.trim();
        const appName = getCustomAppName(address);

        if (appName === undefined) {
            setProblem('Enter a full http or https address without a token.');

            return;
        }

        handleConnect(appName, address);
    }

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
                setProblem('The app could not be removed.');
            })
            .finally(() => {
                setRemovingIds(currentIds => currentIds.filter(id => id !== appId));
            });
    }

    const customApps = apps.filter(app => !KNOWN_APPS.some(knownApp => knownApp.serverName === app.name));

    return (
        <section aria-label="Connect apps" className="webhook-section connect-apps-panel">
            <header className="connect-apps-header">
                <h3>Connect apps</h3>
                <button type="button" className="icon-button" aria-label="Close connect apps" onClick={onClose}><CloseIcon /></button>
            </header>
            <p className="rules-help">Give your bot access to an app. Connect starts the sign-in flow in your chat.</p>
            {selectedBotId === undefined ? <p className="rules-problem">Choose a bot before connecting an app.</p> : null}
            {loadState === 'loading' ? <p>Loading apps...</p> : null}
            {loadState === 'failed' ? <p className="rules-problem">The connected apps could not be loaded.</p> : null}
            {problem === undefined ? null : <p className="rules-problem" role="alert">{problem}</p>}
            <ul className="connect-app-list">
                {KNOWN_APPS.map((knownApp) => {
                    const connectedApp = apps.find(app => app.name === knownApp.serverName);
                    const isStarting = startingAppName === knownApp.serverName;

                    return (
                        <li key={knownApp.serverName} className="connect-app-card">
                            <AppIcon name={knownApp.icon} />
                            <div className="connect-app-copy">
                                <strong>{knownApp.displayName}</strong>
                                {connectedApp === undefined ? <span>{knownApp.description}</span> : <span>{getStatusLabel(connectedApp.status)}</span>}
                            </div>
                            {connectedApp === undefined
                                ? (
                                        <button
                                            type="button"
                                            disabled={selectedBotId === undefined || startingAppName !== undefined}
                                            aria-label={`Connect ${knownApp.displayName}`}
                                            onClick={() => {
                                                handleConnect(knownApp.serverName, knownApp.url);
                                            }}
                                        >
                                            {isStarting ? 'Starting...' : 'Connect'}
                                        </button>
                                    )
                                : (
                                        <button
                                            type="button"
                                            disabled={removingIds.includes(connectedApp.id)}
                                            aria-label={`Remove ${knownApp.displayName}`}
                                            onClick={() => {
                                                handleRemove(connectedApp.id);
                                            }}
                                        >
                                            Remove
                                        </button>
                                    )}
                        </li>
                    );
                })}
                {customApps.map((app) => {
                    const displayName = getCustomDisplayName(app);

                    return (
                        <li key={app.id} className="connect-app-card">
                            <AppIcon name="custom" />
                            <div className="connect-app-copy">
                                <strong>{displayName}</strong>
                                <span>{getStatusLabel(app.status)}</span>
                            </div>
                            <button
                                type="button"
                                disabled={removingIds.includes(app.id)}
                                aria-label={`Remove ${displayName}`}
                                onClick={() => {
                                    handleRemove(app.id);
                                }}
                            >
                                Remove
                            </button>
                        </li>
                    );
                })}
            </ul>
            <form className="connect-app-custom" onSubmit={handleCustomSubmit}>
                <AppIcon name="custom" />
                <div className="connect-app-copy">
                    <strong>Custom app</strong>
                    <label htmlFor="custom-app-address">Connect any app by its address.</label>
                    <input
                        id="custom-app-address"
                        type="url"
                        placeholder="https://example.com/mcp"
                        value={customAddress}
                        onChange={(event) => {
                            setCustomAddress(event.currentTarget.value);
                        }}
                    />
                </div>
                <button type="submit" aria-label="Connect custom app" disabled={selectedBotId === undefined || startingAppName !== undefined}>
                    {startingAppName?.startsWith('custom-') ? 'Starting...' : 'Connect'}
                </button>
            </form>
        </section>
    );
}

export { ConnectAppsPanel };
export type { ConnectAppsPanelProps };
