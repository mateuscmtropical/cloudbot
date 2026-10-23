import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import type { BotProviderSummary, ProviderChoiceSummary } from '../../shared/providerTypes.ts';
import { getBotProvider, listProviders, saveProviderModel, startProviderConnect, switchBotProvider } from '../apiClient.ts';

interface ProviderPickerProps {
    botId: string;
    // Goes up when the bot's provider may have changed outside the picker, such as by a card in the chat.
    changeCount?: number;
    // A newly completed message can teach the server the provider's model list.
    refreshCount?: number;
    // The sign-in of a provider runs in the chat of this bot. The app shows that chat.
    onOpenSetupChat: (setupBotId: string) => void;
}

type ListState = 'loading' | 'ready' | 'failed';

// Shows the provider and the model of the bot in the header. A tap opens the providers of the server.
// A connected one switches the bot at once. One that is not connected starts its sign-in in the setup chat.
function ProviderPicker({ botId, changeCount = 0, refreshCount = 0, onOpenSetupChat }: ProviderPickerProps): ReactElement | null {
    const [summary, setSummary] = useState<BotProviderSummary | undefined>(undefined);
    const [providers, setProviders] = useState<ProviderChoiceSummary[]>([]);
    const [listState, setListState] = useState<ListState>('loading');
    const [isOpen, setIsOpen] = useState(false);
    const [problem, setProblem] = useState<string | undefined>(undefined);
    const [modelDraft, setModelDraft] = useState<string | null>(null);
    const [effortDraft, setEffortDraft] = useState<string | null>(null);
    const [isSavingModel, setIsSavingModel] = useState(false);
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
                    setModelDraft(loaded.selectedModel);
                    setEffortDraft(loaded.selectedEffort);
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
    }, [botId, changeCount, refreshCount]);

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
                setModelDraft(switched.selectedModel);
                setEffortDraft(switched.selectedEffort);
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

    function handleSaveModel(): void {
        setProblem(undefined);
        setIsSavingModel(true);

        saveProviderModel(botId, modelDraft, effortDraft)
            .then((saved) => {
                setSummary(saved);
                setModelDraft(saved.selectedModel);
                setEffortDraft(saved.selectedEffort);
            })
            .catch(() => {
                setProblem('The model could not be changed.');
            })
            .finally(() => {
                setIsSavingModel(false);
            });
    }

    if (summary === undefined) {
        return null;
    }

    // A model the provider lists shows by its name alone, such as GPT-6 Luna. Any other model shows after the provider.
    const modelOption = summary.modelOptions.find(option => option.id === summary.model);

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
                {modelOption === undefined
                    ? (
                            <>
                                <span>{summary.label}</span>
                                {summary.model === null ? null : <span className="provider-picker-model">{summary.model}</span>}
                            </>
                        )
                    : <span>{modelOption.label}</span>}
            </button>
            {isOpen
                ? (
                        <div className="provider-menu" role="dialog" aria-label="AI provider settings">
                            {listState === 'loading' && providers.length === 0 ? <p className="provider-menu-note">Loading...</p> : null}
                            {listState === 'failed' && providers.length === 0 ? <p className="provider-menu-note">The providers could not be loaded.</p> : null}
                            {providers.map(provider => (
                                <div key={provider.id} className="provider-menu-row">
                                    {provider.isConnected
                                        ? (
                                                <button
                                                    type="button"
                                                    aria-pressed={provider.id === summary.provider}
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
                                                    <button type="button" className="provider-menu-connect" aria-label={`Connect ${provider.label}`} onClick={handleConnect}>
                                                        Connect
                                                    </button>
                                                </>
                                            )}
                                </div>
                            ))}
                            {summary.modelOptions.length === 0
                                ? null
                                : (
                                        <div className="provider-model-settings" role="group" aria-label="Model settings">
                                            <label className="provider-model-field">
                                                <span>Model</span>
                                                <select
                                                    aria-label="Model"
                                                    value={modelDraft ?? ''}
                                                    onChange={(event) => {
                                                        const model = event.currentTarget.value || null;
                                                        const options = summary.modelOptions.find(option => option.id === model)?.efforts ?? summary.effortOptions;

                                                        setModelDraft(model);
                                                        setEffortDraft(current => current !== null && options.includes(current) ? current : null);
                                                    }}
                                                >
                                                    <option value="">Provider default</option>
                                                    {summary.modelOptions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                                                </select>
                                            </label>
                                            <label className="provider-model-field">
                                                <span>Effort</span>
                                                <select
                                                    aria-label="Effort"
                                                    value={effortDraft ?? ''}
                                                    onChange={(event) => {
                                                        setEffortDraft(event.currentTarget.value || null);
                                                    }}
                                                >
                                                    <option value="">Provider default</option>
                                                    {(summary.modelOptions.find(option => option.id === modelDraft)?.efforts ?? summary.effortOptions).map(effort => <option key={effort} value={effort}>{effort}</option>)}
                                                </select>
                                            </label>
                                            <button type="button" className="provider-model-save" disabled={isSavingModel} onClick={handleSaveModel}>
                                                {isSavingModel ? 'Saving...' : 'Save model'}
                                            </button>
                                        </div>
                                    )}
                            {problem === undefined ? null : <p className="provider-menu-note">{problem}</p>}
                        </div>
                    )
                : null}
        </div>
    );
}

export { ProviderPicker };
export type { ProviderPickerProps };
