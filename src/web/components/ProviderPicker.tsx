import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import type { BotProviderSummary, ProviderChoiceSummary } from '../../shared/providerTypes.ts';
import { readPermissionMode } from '../../shared/permissionModes.ts';
import type { PermissionMode } from '../../shared/permissionModes.ts';
import { getBotProvider, listProviders, savePermissionMode, saveProviderModel, startProviderConnect, switchBotProvider } from '../apiClient.ts';
import { Field } from './Field.tsx';
import { PopoverMenuSection } from './PopoverMenu.tsx';
import { Select } from './Select.tsx';
import { WorkPicker } from './WorkPicker.tsx';

interface ProviderPickerProps {
    botId: string;
    // True while the menu around the picker is open. Each open reads again, since a sign-in may have finished.
    isOpen: boolean;
    // Goes up when the bot's provider may have changed outside the picker, such as by a card in the chat.
    changeCount?: number;
    // The sign-in of a provider runs in the chat of this bot. The app shows that chat.
    onOpenSetupChat: (setupBotId: string) => void;
    // Closes the menu around the picker.
    onClose: () => void;
}

type ListState = 'loading' | 'ready' | 'failed';

const PERMISSION_NOTES: Record<PermissionMode, string> = {
    ask: 'The bot stops before tools, and each call is reviewed.',
    auto: 'The AI runs what it judges safe by itself. Your Block rules only see what it still asks about.',
    yolo: 'Nothing is checked and your Block rules do not apply. A web page or a message can make the bot delete, send or spend. You take that risk.',
};

// The provider, model, effort and permissions of a bot. Every choice saves at once. The menu stays open, so the owner sees it land.
function ProviderPicker({ botId, isOpen, changeCount = 0, onOpenSetupChat, onClose }: ProviderPickerProps): ReactElement {
    const [summary, setSummary] = useState<BotProviderSummary | undefined>(undefined);
    const [summaryState, setSummaryState] = useState<ListState>('loading');
    const [providers, setProviders] = useState<ProviderChoiceSummary[]>([]);
    const [listState, setListState] = useState<ListState>('loading');
    const [problem, setProblem] = useState<string | undefined>(undefined);
    const lastChangeRef = useRef(0);

    const load = useCallback(() => {
        let isCurrent = true;

        getBotProvider(botId)
            .then((loaded) => {
                if (isCurrent) {
                    setSummary(loaded);
                    setSummaryState('ready');
                }
            })
            .catch(() => {
                if (isCurrent) {
                    setSummaryState('failed');
                }
            });

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
    }, [botId]);

    // The server needs a while for the first check of the sign-ins, so reading early lets the menu open with the list ready.
    useEffect(() => load(), [load, changeCount]);

    useEffect(() => (isOpen ? load() : undefined), [load, isOpen]);

    // Shows the choice at once and undoes it when the server refuses. Only the newest choice may touch the state.
    function applyChange(shown: BotProviderSummary, request: Promise<BotProviderSummary>, failure: string): void {
        const previous = summary;
        const changeNumber = lastChangeRef.current + 1;

        lastChangeRef.current = changeNumber;
        setProblem(undefined);
        setSummary(shown);

        request
            .then((saved) => {
                if (lastChangeRef.current === changeNumber) {
                    setSummary(saved);
                }
            })
            .catch(() => {
                if (lastChangeRef.current === changeNumber) {
                    setSummary(previous);
                    setProblem(failure);
                }
            });
    }

    function handleConnect(provider: ProviderChoiceSummary): void {
        setProblem(undefined);

        startProviderConnect(provider.id)
            .then((started) => {
                onClose();
                onOpenSetupChat(started.botId);
            })
            .catch(() => {
                setProblem('The sign-in could not be started.');
            });
    }

    if (summary === undefined) {
        return (
            <div className="provider-picker" role="group" aria-label="Model and provider">
                <p className="provider-note">{summaryState === 'failed' ? 'The settings could not be loaded.' : 'Loading...'}</p>
            </div>
        );
    }

    const current = summary;
    const connected = providers.filter(provider => provider.isConnected);
    const notConnected = providers.filter(provider => !provider.isConnected);
    const efforts = current.modelOptions.find(option => option.id === current.selectedModel)?.efforts ?? current.effortOptions;
    // A model the provider lists shows by its name, such as GPT-6 Luna. Any other shows as the provider reports it.
    const modelLabel = current.modelOptions.find(option => option.id === current.model)?.label ?? current.model;

    function handleSwitch(provider: ProviderChoiceSummary): void {
        if (provider.id === current.provider) {
            return;
        }

        const request = switchBotProvider(botId, provider.id);
        const shown = { ...current, provider: provider.id, label: provider.label, model: null, modelOptions: [], effortOptions: [], selectedModel: null, selectedEffort: null };

        applyChange(shown, request, 'The provider could not be changed.');
    }

    function handleModel(model: string | null): void {
        const options = current.modelOptions.find(option => option.id === model)?.efforts ?? current.effortOptions;
        const effort = current.selectedEffort !== null && options.includes(current.selectedEffort) ? current.selectedEffort : null;
        const request = saveProviderModel(botId, model, effort);

        applyChange({ ...current, selectedModel: model, selectedEffort: effort }, request, 'The model could not be changed.');
    }

    function handleEffort(effort: string | null): void {
        const request = saveProviderModel(botId, current.selectedModel, effort);

        applyChange({ ...current, selectedEffort: effort }, request, 'The effort could not be changed.');
    }

    function handlePermissionMode(mode: PermissionMode): void {
        const request = savePermissionMode(botId, mode);

        applyChange({ ...current, permissionMode: mode }, request, 'The permissions could not be changed.');
    }

    return (
        <div className="provider-picker" role="group" aria-label="Model and provider">
            <PopoverMenuSection title="Provider">
                {listState === 'loading' && providers.length === 0 ? <p className="provider-note">Loading...</p> : null}
                {listState === 'failed' && providers.length === 0 ? <p className="provider-note">The providers could not be loaded.</p> : null}
                {connected.map((provider) => {
                    const isCurrent = provider.id === current.provider;

                    return (
                        <button
                            key={provider.id}
                            type="button"
                            className="provider-row"
                            aria-pressed={isCurrent}
                            onClick={() => {
                                handleSwitch(provider);
                            }}
                        >
                            <span className="provider-radio" aria-hidden="true" />
                            <span className="provider-row-name">{provider.label}</span>
                            {isCurrent && modelLabel !== null ? <span className="provider-row-model">{modelLabel}</span> : null}
                        </button>
                    );
                })}
                {notConnected.map(provider => (
                    <button
                        key={provider.id}
                        type="button"
                        className="provider-row"
                        aria-label={`Connect ${provider.label}`}
                        onClick={() => {
                            handleConnect(provider);
                        }}
                    >
                        <span className="provider-radio" aria-hidden="true" />
                        <span className="provider-row-name">{provider.label}</span>
                        <span className="provider-row-connect">Connect</span>
                    </button>
                ))}
            </PopoverMenuSection>
            {current.modelOptions.length === 0
                ? null
                : (
                        <PopoverMenuSection title="Model and effort">
                            <Field label="Model" isInline>
                                <Select
                                    label="Model"
                                    value={current.selectedModel ?? ''}
                                    onChange={(event) => {
                                        handleModel(event.currentTarget.value || null);
                                    }}
                                >
                                    <option value="">Provider default</option>
                                    {current.modelOptions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                                </Select>
                            </Field>
                            {efforts.length === 0
                                ? null
                                : (
                                        <Field label="Effort" isInline>
                                            <Select
                                                label="Effort"
                                                value={current.selectedEffort ?? ''}
                                                onChange={(event) => {
                                                    handleEffort(event.currentTarget.value || null);
                                                }}
                                            >
                                                <option value="">Provider default</option>
                                                {efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
                                            </Select>
                                        </Field>
                                    )}
                        </PopoverMenuSection>
                    )}
            <WorkPicker botId={botId} providers={providers} refreshKey={[current.provider, changeCount, isOpen].join(':')} />
            <PopoverMenuSection title="Permissions">
                <Field label="Mode" isInline>
                    <Select
                        label="Permissions"
                        value={current.permissionMode}
                        onChange={(event) => {
                            const mode = readPermissionMode(event.currentTarget.value);

                            handlePermissionMode(mode);
                        }}
                    >
                        <option value="ask">Ask</option>
                        <option value="auto">Auto</option>
                        <option value="yolo">YOLO</option>
                    </Select>
                </Field>
                <p className={current.permissionMode === 'yolo' ? 'provider-note is-warning' : 'provider-note'}>{PERMISSION_NOTES[current.permissionMode]}</p>
            </PopoverMenuSection>
            {problem === undefined ? null : <p className="provider-problem" role="alert">{problem}</p>}
        </div>
    );
}

export { ProviderPicker };
export type { ProviderPickerProps };
