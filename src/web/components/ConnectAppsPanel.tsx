import { useEffect, useState } from 'react';
import type { CSSProperties, ReactElement, SyntheticEvent } from 'react';

import type { ConnectedAppStatus, ConnectedAppSummary } from '../../shared/connectedApps.ts';
import { listConnectedApps, removeConnectedApp, startAppConnection, startAppSignIn } from '../apiClient.ts';
import { APP_CATALOG, APP_CATEGORIES } from '../appCatalog.ts';
import type { AppCategory, CatalogApp } from '../appCatalog.ts';
import { APP_SIGN_IN_CHANNEL, describeAppReturn, readAppReturnMessage } from '../appReturn.ts';
import { APP_LOGOS, getLogoGlyphColor } from '../appLogos.ts';
import { GoogleSetupForm } from './GoogleSetupForm.tsx';
import { ListGroup } from './ListGroup.tsx';
import { ListRow } from './ListRow.tsx';
import { CloseIcon, FilterIcon, SearchIcon } from './icons.tsx';
import { PillField } from './PillField.tsx';
import { RoundButton } from './RoundButton.tsx';

interface ConnectAppsPanelProps {
    onClose: () => void;
    selectedBotId: string | undefined;
    // What happened when the owner came back from an app's sign-in page, shown once at the top.
    notice?: string | undefined;
}

type LoadState = 'loading' | 'ready' | 'failed';
type CategoryFilter = AppCategory | 'All';

// The Google app the owner clicked before the Google client was saved, so the sign-in goes on after the save.
interface PendingGoogleApp {
    name: string;
    url: string;
}

interface AppIconProps {
    app: CatalogApp;
}

// The hue is the only part of the icon style that changes per app. The color rule lives in styles.css.
interface AppIconStyle extends CSSProperties {
    '--app-hue': number;
}

const ALL_CATEGORIES: CategoryFilter = 'All';
const CATEGORY_FILTERS: CategoryFilter[] = [ALL_CATEGORIES, ...APP_CATEGORIES];
// The server keeps a sign-in for ten minutes.
const SIGN_IN_WAIT_LIMIT_MS = 10 * 60 * 1000;
// The catalog file keeps its own order. The panel shows the apps alphabetically.
const SORTED_CATALOG = [...APP_CATALOG]
    .sort((first, second) => first.displayName.localeCompare(second.displayName, 'en', { sensitivity: 'base' }));

function getStatusLabel(status: ConnectedAppStatus): string {
    if (status === 'needs_token') {
        return 'Sign-in needed.';
    }

    if (status === 'failed') {
        return 'Could not connect.';
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

function refreshApps(onLoaded: (loadedApps: ConnectedAppSummary[]) => void): void {
    listConnectedApps()
        .then(onLoaded)
        .catch(() => undefined);
}

function getAppHue(serverName: string): number {
    const letters = Array.from(serverName);
    const hueSum = letters.reduce((sum, letter) => sum * 31 + (letter.codePointAt(0) ?? 0), 7);

    return hueSum % 360;
}

function CustomAppIcon(): ReactElement {
    return (
        <span className="connect-app-icon connect-app-icon-custom" aria-hidden="true">
            <svg viewBox="0 0 24 24">
                <path d="M9.5 14.5 14.5 9.5M8 16l-1.5 1.5a4 4 0 0 1-5.7-5.7l4-4a4 4 0 0 1 5.7 0M16 8l1.5-1.5a4 4 0 0 1 5.7 5.7l-4 4a4 4 0 0 1-5.7 0" />
            </svg>
        </span>
    );
}

function AppIcon({ app }: AppIconProps): ReactElement {
    const logo = APP_LOGOS[app.serverName];

    if (logo !== undefined) {
        return (
            <span className="connect-app-icon connect-app-icon-logo" aria-hidden="true">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d={logo.path} fill={getLogoGlyphColor(logo.color)} />
                </svg>
            </span>
        );
    }

    const iconStyle: AppIconStyle = { '--app-hue': getAppHue(app.serverName) };
    const initial = app.displayName.charAt(0)
        .toUpperCase();

    return <span className="connect-app-icon connect-app-icon-app" style={iconStyle} aria-hidden="true">{initial}</span>;
}

function ConnectAppsPanel({ onClose, selectedBotId, notice }: ConnectAppsPanelProps): ReactElement {
    const [apps, setApps] = useState<ConnectedAppSummary[]>([]);
    const [loadState, setLoadState] = useState<LoadState>('loading');
    const [problem, setProblem] = useState<string | undefined>(undefined);
    const [customAddress, setCustomAddress] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [startingAppName, setStartingAppName] = useState<string | undefined>(undefined);
    const [removingIds, setRemovingIds] = useState<string[]>([]);
    const [isShowingInstalledOnly, setIsShowingInstalledOnly] = useState(false);
    const [selectedCategory, setSelectedCategory] = useState<CategoryFilter>(ALL_CATEGORIES);
    const [isCustomFormOpen, setIsCustomFormOpen] = useState(false);
    // The name of the app whose sign-in window is open, and what the window held back from this one.
    const [signInLabel, setSignInLabel] = useState<string | undefined>(undefined);
    const [returnNotice, setReturnNotice] = useState<string | undefined>(undefined);
    const [isGoogleSetupOpen, setIsGoogleSetupOpen] = useState(false);
    const [pendingGoogleApp, setPendingGoogleApp] = useState<PendingGoogleApp | undefined>(undefined);

    function stopWaiting(): void {
        setSignInLabel(undefined);
        setStartingAppName(undefined);
        refreshApps(setApps);
    }

    // The window that comes back from the app tells this one on a channel. Only a panel that waits listens.
    // The panel cannot see whether the sign-in window is still open, so it also stops waiting when the server forgets the sign-in.
    useEffect(() => {
        if (signInLabel === undefined) {
            return undefined;
        }

        const timer = window.setTimeout(() => {
            setSignInLabel(undefined);
            setStartingAppName(undefined);
            refreshApps(setApps);
        }, SIGN_IN_WAIT_LIMIT_MS);
        const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel(APP_SIGN_IN_CHANNEL);

        if (channel !== undefined) {
            channel.onmessage = (event: MessageEvent<unknown>) => {
                const appReturn = readAppReturnMessage(event.data);

                if (appReturn === undefined) {
                    return;
                }

                const message = describeAppReturn(appReturn);

                setReturnNotice(message);
                setSignInLabel(undefined);
                setStartingAppName(undefined);
                refreshApps(setApps);
            };
        }

        return () => {
            window.clearTimeout(timer);
            channel?.close();
        };
    }, [signInLabel]);

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

    // The app's own sign-in page opens when it has one. Otherwise the bot asks in the chat, as before.
    function handleConnect(appName: string, appUrl: string): void {
        if (selectedBotId === undefined || startingAppName !== undefined) {
            return;
        }

        // The window opens on the click itself, before the request, so a popup blocker lets it through.
        // If it is blocked anyway, the sign-in page takes this window as before.
        const signInWindow = window.open('', '_blank');
        const catalogApp = APP_CATALOG.find(candidate => candidate.serverName === appName);

        // The app's page must not reach back to this window through window.opener.
        if (signInWindow !== null) {
            signInWindow.opener = null;
        }

        setReturnNotice(undefined);
        setProblem(undefined);
        setStartingAppName(appName);

        startAppSignIn(selectedBotId, appName, appUrl)
            .then((signIn) => {
                if (signIn.status === 'redirect') {
                    if (signInWindow === null) {
                        window.location.assign(signIn.authorizationUrl);
                    } else {
                        signInWindow.location.href = signIn.authorizationUrl;
                        setSignInLabel(catalogApp?.displayName ?? appName);
                    }

                    return undefined;
                }

                signInWindow?.close();

                if (signIn.status === 'needs_client') {
                    setPendingGoogleApp({ name: appName, url: appUrl });
                    setIsGoogleSetupOpen(true);
                    setStartingAppName(undefined);

                    return undefined;
                }

                if (signIn.status === 'failed') {
                    setProblem(signIn.problem);
                    setStartingAppName(undefined);

                    return undefined;
                }

                return startAppConnection(selectedBotId, appName, appUrl)
                    .then(() => {
                        onClose();
                    })
                    .finally(() => {
                        setStartingAppName(undefined);
                    });
            })
            .catch(() => {
                signInWindow?.close();
                setProblem('The connection could not be started. Try again.');
                setStartingAppName(undefined);
            });
    }

    // The Google client was saved. The sign-in the owner started goes on, if there was one.
    function handleGoogleSaved(): void {
        const googleApp = pendingGoogleApp;

        if (googleApp === undefined) {
            return;
        }

        setPendingGoogleApp(undefined);
        setIsGoogleSetupOpen(false);
        handleConnect(googleApp.name, googleApp.url);
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

    const searchTerm = searchQuery.trim()
        .toLowerCase();
    const customApps = apps.filter(app => !APP_CATALOG.some(catalogApp => catalogApp.serverName === app.name));
    const filteredCatalogApps = SORTED_CATALOG.filter((catalogApp) => {
        const connectedApp = apps.find(app => app.name === catalogApp.serverName);
        const matchesCategory = selectedCategory === ALL_CATEGORIES || catalogApp.category === selectedCategory;
        const matchesInstalledFilter = !isShowingInstalledOnly || connectedApp !== undefined;
        const searchableText = `${catalogApp.displayName} ${catalogApp.description} ${catalogApp.category}`.toLowerCase();
        const matchesSearch = searchTerm.length === 0 || searchableText.includes(searchTerm);

        return matchesCategory && matchesInstalledFilter && matchesSearch;
    });
    const filteredCustomApps = customApps.filter((app) => {
        const displayName = getCustomDisplayName(app);
        const normalizedDisplayName = displayName.toLowerCase();

        return searchTerm.length === 0 || normalizedDisplayName.includes(searchTerm);
    });
    const hasMatchingApps = filteredCatalogApps.length > 0 || filteredCustomApps.length > 0;
    const installedCount = apps.length.toString();
    const installedCountAccessibleLabel = `${installedCount} installed apps`;
    const installedCountLabel = `${installedCount} installed`;
    const groupLabel = selectedCategory === ALL_CATEGORIES ? 'All apps' : selectedCategory;
    const startingLabel = signInLabel === undefined ? 'Starting...' : 'Waiting...';

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
            <div className="connect-app-chips" role="group" aria-label="App categories">
                {CATEGORY_FILTERS.map(category => (
                    <button
                        key={category}
                        type="button"
                        className="connect-app-chip"
                        aria-pressed={category === selectedCategory}
                        onClick={() => {
                            setSelectedCategory(category);
                        }}
                    >
                        {category}
                    </button>
                ))}
            </div>
            {notice === undefined && returnNotice === undefined ? null : <p className="connect-app-message" role="status">{returnNotice ?? notice}</p>}
            {signInLabel === undefined
                ? null
                : (
                        <p className="connect-app-message" role="status">
                            {`Finish signing in to ${signInLabel} in the other window.`}
                            <button type="button" className="connect-app-action" aria-label="Cancel sign-in" onClick={stopWaiting}>Cancel</button>
                        </p>
                    )}
            {selectedBotId === undefined || isGoogleSetupOpen
                ? null
                : (
                        <button type="button" className="connect-app-action google-setup-open" onClick={() => { setIsGoogleSetupOpen(true); }}>Google setup</button>
                    )}
            {selectedBotId !== undefined && isGoogleSetupOpen
                ? (
                        <GoogleSetupForm
                            botId={selectedBotId}
                            onSaved={handleGoogleSaved}
                            onClose={() => {
                                setIsGoogleSetupOpen(false);
                                setPendingGoogleApp(undefined);
                            }}
                        />
                    )
                : null}
            {selectedBotId === undefined ? <p className="connect-app-problem">Choose a bot before connecting an app.</p> : null}
            {loadState === 'loading' ? <p className="connect-app-message">Loading apps...</p> : null}
            {loadState === 'failed' ? <p className="connect-app-problem">The connected apps could not be loaded.</p> : null}
            {problem === undefined ? null : <p className="connect-app-problem" role="alert">{problem}</p>}
            {!hasMatchingApps && loadState === 'ready'
                ? <p className="connect-app-message">No apps match your search.</p>
                : null}
            <div className="connect-app-sections">
                <div className="connect-app-section">
                    <ListGroup label={groupLabel} className="connect-app-group">
                        <div className="connect-app-grid">
                            {filteredCatalogApps.map((catalogApp) => {
                                const connectedApp = apps.find(app => app.name === catalogApp.serverName);
                                const isStarting = startingAppName === catalogApp.serverName;
                                const description = connectedApp === undefined ? catalogApp.description : getStatusLabel(connectedApp.status);
                                const actionButton = connectedApp?.status !== 'connected'
                                    ? (
                                            <button
                                                type="button"
                                                className="connect-app-action"
                                                disabled={selectedBotId === undefined || startingAppName !== undefined}
                                                aria-label={`Connect ${catalogApp.displayName}`}
                                                onClick={() => {
                                                    handleConnect(catalogApp.serverName, catalogApp.url);
                                                }}
                                            >
                                                {isStarting ? startingLabel : 'Connect'}
                                            </button>
                                        )
                                    : (
                                            <button
                                                type="button"
                                                className="connect-app-action"
                                                disabled={removingIds.includes(connectedApp.id)}
                                                aria-label={`Remove ${catalogApp.displayName}`}
                                                onClick={() => {
                                                    handleRemove(connectedApp.id);
                                                }}
                                            >
                                                Remove
                                            </button>
                                        );

                                return (
                                    <div key={catalogApp.serverName} className="connect-app-card">
                                        <AppIcon app={catalogApp} />
                                        <div className="connect-app-card-copy">
                                            <span className="connect-app-card-title">{catalogApp.displayName}</span>
                                            <span className="connect-app-card-description">{description}</span>
                                        </div>
                                        {actionButton}
                                    </div>
                                );
                            })}
                        </div>
                    </ListGroup>
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
                                    leadingIcon={<CustomAppIcon />}
                                    trailingControl={removeButton}
                                />
                            );
                        })}
                        <ListRow
                            className="connect-app-row connect-app-add-row"
                            title="Add custom app"
                            description="Connect any app by its address."
                            leadingIcon={<CustomAppIcon />}
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
                                        <CustomAppIcon />
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
                                            {startingAppName?.startsWith('custom-') ? startingLabel : 'Connect'}
                                        </button>
                                    </form>
                                )
                            : null}
                    </ListGroup>
                </div>
            </div>
        </section>
    );
}

export { ConnectAppsPanel };
export type { ConnectAppsPanelProps };
