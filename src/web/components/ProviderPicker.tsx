import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import type { BotProviderSummary, ProviderChoiceSummary } from '../../shared/providerTypes.ts';
import { getBotProvider, listProviders, startProviderConnect, switchBotProvider } from '../apiClient.ts';

interface ProviderPickerProps {
    botId: string;
    // Goes up when the bot's provider may have changed outside the picker, such as by a card in the chat.
    changeCount?: number;
    // The sign-in of a provider runs in the chat of this bot. The app shows that chat.
    onOpenSetupChat: (setupBotId: string) => void;
}

type ListState = 'loading' | 'ready' | 'failed';

// Shows the provider and the model of the bot in the header. A tap opens the providers of the server.
// A connected one switches the bot at once. One that is not connected starts its sign-in in the setup chat.
function ProviderPicker({ botId, changeCount = 0, onOpenSetupChat }: ProviderPickerProps): ReactElement | null {
    const [summary, setSummary] = useState<BotProviderSummary | undefined>(undefined);
    const [providers, setProviders] = useState<ProviderChoiceSummary[]>([]);
    const [listState, setListState] = useState<ListState>('loading');
    const [isOpen, setIsOpen] = useState(false);
    const [problem, setProblem] = useState<string | undefined>(undefined);
    const [shownBotId, setShownBotId] = useState(botId);
    const containerRef = useRef<HTMLDivElement>(null);

    // React's pattern for state that follows a prop: another bot starts with a closed menu.
    if (shownBotId !== botId) {
        setShownBotId(botId);
        setIsOpen(false);
        setProblem(undefined);
    }

    // The label follows the bot and the changes made elsewhere. A failure leaves the header without it.
    useEffect(() => {
        let isCurrent = true;

        getBotProvider(botId)
            .then((loaded) => {
                if (isCurrent) {
                    setSummary(loaded);
                }
            })
            .catch(() => {
                if (isCurrent) {
                    setSummary(undefined);
                }
            });

        return () => {
            isCurrent = false;
        };
    }, [botId, changeCount]);

    // The list is read when the header shows and each time the menu opens, since a sign-in may have finished since the last time.
    // The server needs a while for the first check of the sign-ins, so reading early lets the menu open with the list ready.
    useEffect(() => {
        let isCurrent = true;

        listProviders()
            .then((loaded) => {
                if (isCurrent) {
                    setProviders(loaded);
                    setListState('ready');
                }
            })
            .catch(() => {
                if (isCurrent) {
                    setListState('failed');
                }
            });

        return () => {
            isCurrent = false;
        };
    }, [isOpen]);

    // A tap outside the menu, or Escape, closes it.
    useEffect(() => {
        if (!isOpen) {
            return undefined;
        }

        function closeOnOutsideTap(event: PointerEvent): void {
            if (event.target instanceof Node && containerRef.current?.contains(event.target) !== true) {
                setIsOpen(false);
            }
        }

        function closeOnEscape(event: KeyboardEvent): void {
            if (event.key === 'Escape') {
                setIsOpen(false);
            }
        }

        document.addEventListener('pointerdown', closeOnOutsideTap);
        document.addEventListener('keydown', closeOnEscape);

        return () => {
            document.removeEventListener('pointerdown', closeOnOutsideTap);
            document.removeEventListener('keydown', closeOnEscape);
        };
    }, [isOpen]);

    function handleSwitch(providerId: string): void {
        setProblem(undefined);

        switchBotProvider(botId, providerId)
            .then((switched) => {
                setSummary(switched);
                setIsOpen(false);
            })
            .catch(() => {
                setProblem('The provider could not be changed.');
            });
    }

    function handleConnect(): void {
        setProblem(undefined);

        startProviderConnect()
            .then((started) => {
                setIsOpen(false);
                onOpenSetupChat(started.botId);
            })
            .catch(() => {
                setProblem('The sign-in could not be started.');
            });
    }

    if (summary === undefined) {
        return null;
    }

    return (
        <div className="provider-picker" ref={containerRef}>
            <button
                type="button"
                className="provider-picker-button"
                aria-label="AI provider"
                aria-expanded={isOpen}
                onClick={() => {
                    setIsOpen(current => !current);
                }}
            >
                <span>{summary.label}</span>
                {summary.model === null ? null : <span className="provider-picker-model">{summary.model}</span>}
            </button>
            {isOpen
                ? (
                        <div className="provider-menu" role="menu" aria-label="AI providers">
                            {listState === 'loading' && providers.length === 0 ? <p className="provider-menu-note">Loading...</p> : null}
                            {listState === 'failed' && providers.length === 0 ? <p className="provider-menu-note">The providers could not be loaded.</p> : null}
                            {providers.map(provider => (
                                <div key={provider.id} className="provider-menu-row">
                                    {provider.isConnected
                                        ? (
                                                <button
                                                    type="button"
                                                    role="menuitemradio"
                                                    aria-checked={provider.id === summary.provider}
                                                    className="provider-menu-item"
                                                    onClick={() => {
                                                        handleSwitch(provider.id);
                                                    }}
                                                >
                                                    {provider.label}
                                                </button>
                                            )
                                        : (
                                                <>
                                                    <span className="provider-menu-item is-off">{provider.label}</span>
                                                    <button type="button" role="menuitem" className="provider-menu-connect" aria-label={`Connect ${provider.label}`} onClick={handleConnect}>
                                                        Connect
                                                    </button>
                                                </>
                                            )}
                                </div>
                            ))}
                            {problem === undefined ? null : <p className="provider-menu-note">{problem}</p>}
                        </div>
                    )
                : null}
        </div>
    );
}

export { ProviderPicker };
export type { ProviderPickerProps };
