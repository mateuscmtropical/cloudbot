import { useEffect, useState } from 'react';
import type { ReactElement, SyntheticEvent } from 'react';

import type { ConnectedAppStatus, ConnectedAppSummary } from '../../shared/connectedApps.ts';
import { listConnectedApps, removeConnectedApp, startAppConnection } from '../apiClient.ts';
import { ListGroup } from './ListGroup.tsx';
import { ListRow } from './ListRow.tsx';
import { CloseIcon, FilterIcon, SearchIcon } from './icons.tsx';
import { PillField } from './PillField.tsx';
import { RoundButton } from './RoundButton.tsx';

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
        description: 'Find issues and update team projects.',
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
    const [searchQuery, setSearchQuery] = useState('');
    const [startingAppName, setStartingAppName] = useState<string | undefined>(undefined);
    const [removingIds, setRemovingIds] = useState<string[]>([]);
    const [isShowingInstalledOnly, setIsShowingInstalledOnly] = useState(false);
    const [isCustomFormOpen, setIsCustomFormOpen] = useState(false);

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

    function showAllApps(): void {
        setSearchQuery('');
        setIsShowingInstalledOnly(false);
    }

    const searchTerm = searchQuery.trim()
        .toLowerCase();
    const customApps = apps.filter(app => !KNOWN_APPS.some(knownApp => knownApp.serverName === app.name));
    const filteredKnownApps = KNOWN_APPS.filter((knownApp) => {
        const connectedApp = apps.find(app => app.name === knownApp.serverName);
        const matchesInstalledFilter = !isShowingInstalledOnly || connectedApp !== undefined;
        const knownAppName = knownApp.displayName.toLowerCase();
        const matchesSearch = searchTerm.length === 0 || knownAppName.includes(searchTerm);

        return matchesInstalledFilter && matchesSearch;
    });
    const filteredCustomApps = customApps.filter((app) => {
        const displayName = getCustomDisplayName(app);
        const normalizedDisplayName = displayName.toLowerCase();

        return searchTerm.length === 0 || normalizedDisplayName.includes(searchTerm);
    });
    const hasMatchingApps = filteredKnownApps.length > 0 || filteredCustomApps.length > 0;
    const installedCount = apps.length.toString();
    const installedCountAccessibleLabel = `${installedCount} installed apps`;
    const installedCountLabel = `${installedCount} installed`;

    return (
        <section aria-label="Connect apps" className="connect-apps-panel">
            <header className="connect-apps-header">
                <RoundButton label="Close connect apps" onClick={onClose}><CloseIcon /></RoundButton>
                <h1>Connect apps</h1>
                <span className="connect-app-installed-count" aria-label={installedCountAccessibleLabel}>
                    {installedCountLabel}
                </span>
            </header>
            <div className="connect-app-search-row">
                <PillField leftIcon={<SearchIcon />} className="connect-app-search-field">
                    <input
                        type="search"
                        aria-label="Search apps"
                        placeholder="Search apps"
                        value={searchQuery}
                        onChange={(event) => {
                            setSearchQuery(event.currentTarget.value);
                        }}
                    />
                </PillField>
                <RoundButton
                    label={isShowingInstalledOnly ? 'Show all apps' : 'Show installed apps'}
                    tone={isShowingInstalledOnly ? 'accent' : 'default'}
                    onClick={() => {
                        setIsShowingInstalledOnly(currentValue => !currentValue);
                    }}
                >
                    <FilterIcon />
                </RoundButton>
            </div>
            {selectedBotId === undefined ? <p className="connect-app-problem">Choose a bot before connecting an app.</p> : null}
            {loadState === 'loading' ? <p className="connect-app-message">Loading apps...</p> : null}
            {loadState === 'failed' ? <p className="connect-app-problem">The connected apps could not be loaded.</p> : null}
            {problem === undefined ? null : <p className="connect-app-problem" role="alert">{problem}</p>}
            {!hasMatchingApps && loadState === 'ready'
                ? <p className="connect-app-message">No apps match your search.</p>
                : null}
            <div className="connect-app-sections">
                <div className="connect-app-section">
                    <ListGroup label="Featured" className="connect-app-group">
                        {filteredKnownApps.map((knownApp) => {
                            const connectedApp = apps.find(app => app.name === knownApp.serverName);
                            const isStarting = startingAppName === knownApp.serverName;
                            const description = connectedApp === undefined ? knownApp.description : getStatusLabel(connectedApp.status);
                            const actionButton = connectedApp === undefined
                                ? (
                                        <button
                                            type="button"
                                            className="connect-app-action"
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
                                            className="connect-app-action"
                                            disabled={removingIds.includes(connectedApp.id)}
                                            aria-label={`Remove ${knownApp.displayName}`}
                                            onClick={() => {
                                                handleRemove(connectedApp.id);
                                            }}
                                        >
                                            Remove
                                        </button>
                                    );

                            return (
                                <ListRow
                                    key={knownApp.serverName}
                                    className="connect-app-row"
                                    title={knownApp.displayName}
                                    description={description}
                                    leadingIcon={<AppIcon name={knownApp.icon} />}
                                    trailingControl={actionButton}
                                />
                            );
                        })}
                    </ListGroup>
                    <button type="button" className="connect-app-see-all" aria-label="See all featured apps" onClick={showAllApps}>See all</button>
                </div>
                <div className="connect-app-section">
                    <ListGroup label="Custom" className="connect-app-group">
                        {filteredCustomApps.map((app) => {
                            const displayName = getCustomDisplayName(app);
                            const removeButton = (
                                <button
                                    type="button"
                                    className="connect-app-action"
                                    disabled={removingIds.includes(app.id)}
                                    aria-label={`Remove ${displayName}`}
                                    onClick={() => {
                                        handleRemove(app.id);
                                    }}
                                >
                                    Remove
                                </button>
                            );

                            return (
                                <ListRow
                                    key={app.id}
                                    className="connect-app-row"
                                    title={displayName}
                                    description={getStatusLabel(app.status)}
                                    leadingIcon={<AppIcon name="custom" />}
                                    trailingControl={removeButton}
                                />
                            );
                        })}
                        <ListRow
                            className="connect-app-row connect-app-add-row"
                            title="Add custom app"
                            description="Connect any app by its address."
                            leadingIcon={<AppIcon name="custom" />}
                            trailingControl={(
                                <button
                                    type="button"
                                    className="connect-app-action"
                                    aria-label="Add custom app"
                                    aria-expanded={isCustomFormOpen}
                                    onClick={() => {
                                        setIsCustomFormOpen(currentValue => !currentValue);
                                    }}
                                >
                                    {isCustomFormOpen ? 'Cancel' : 'Add'}
                                </button>
                            )}
                        />
                        {isCustomFormOpen
                            ? (
                                    <form className="connect-app-custom-form" onSubmit={handleCustomSubmit}>
                                        <AppIcon name="custom" />
                                        <div className="connect-app-custom-copy">
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
                                        <button
                                            type="submit"
                                            className="connect-app-action"
                                            aria-label="Connect custom app"
                                            disabled={selectedBotId === undefined || startingAppName !== undefined}
                                        >
                                            {startingAppName?.startsWith('custom-') ? 'Starting...' : 'Connect'}
                                        </button>
                                    </form>
                                )
                            : null}
                    </ListGroup>
                    <button type="button" className="connect-app-see-all" aria-label="See all custom apps" onClick={showAllApps}>See all</button>
                </div>
            </div>
        </section>
    );
}

export { ConnectAppsPanel };
export type { ConnectAppsPanelProps };
