import { useEffect, useId, useState } from 'react';
import type { ReactElement, SyntheticEvent } from 'react';

import { RequestFailedError, getModelSettings, saveModelSettings } from '../apiClient.ts';
import type { ModelSettings } from '../apiClient.ts';

interface ModelsPanelProps {
    botId: string;
    botName: string;
    onClose: () => void;
}

type LoadState = 'loading' | 'ready' | 'failed';
type ModelKind = keyof ModelSettings;

interface KindRow {
    kind: ModelKind;
    label: string;
    noneText: string;
}

interface ModelSelectProps {
    label: string;
    noneText: string;
    value: string | null;
    aliases: string[];
    onChange: (value: string | null) => void;
}

// One row per kind of work. Helpers are off by default, so their empty choice says no helper.
const KIND_ROWS: KindRow[] = [
    { kind: 'chat', label: 'Chat', noneText: 'Default' },
    { kind: 'routines', label: 'Routines', noneText: 'Default' },
    { kind: 'review', label: 'Review agent', noneText: 'Default' },
    { kind: 'browsing', label: 'Browsing helper', noneText: 'No helper' },
    { kind: 'documents', label: 'Documents helper', noneText: 'No helper' },
];

const EMPTY_SETTINGS: ModelSettings = { chat: null, routines: null, review: null, browsing: null, documents: null };

function describeFailure(error: unknown): string {
    if (error instanceof RequestFailedError && error.serverMessage !== undefined) {
        return error.serverMessage;
    }

    return 'The models could not be saved. Try again.';
}

// A stored full model id is shown as its own option, so saving the panel does not drop it.
function ModelSelect({ label, noneText, value, aliases, onChange }: ModelSelectProps): ReactElement {
    const selectId = useId();

    return (
        <>
            <label htmlFor={selectId}>{label}</label>
            <select
                id={selectId}
                value={value ?? ''}
                onChange={(event) => {
                    onChange(event.target.value === '' ? null : event.target.value);
                }}
            >
                <option value="">{noneText}</option>
                {aliases.map(alias => (
                    <option key={alias} value={alias}>{alias}</option>
                ))}
                {value !== null && !aliases.includes(value) ? <option value={value}>{value}</option> : null}
            </select>
        </>
    );
}

// The model of each kind of work for one bot. Saving sends all five choices.
function ModelsPanel({ botId, botName, onClose }: ModelsPanelProps): ReactElement {
    const [loadState, setLoadState] = useState<LoadState>('loading');
    // Bumped by the retry button to load the choices again.
    const [loadAttempt, setLoadAttempt] = useState(0);
    const [aliases, setAliases] = useState<string[]>([]);
    const [draft, setDraft] = useState<ModelSettings>(EMPTY_SETTINGS);
    const [isSaving, setIsSaving] = useState(false);
    const [isSaved, setIsSaved] = useState(false);
    const [problem, setProblem] = useState<string | undefined>(undefined);

    useEffect(() => {
        // The panel is mounted for one bot, so the first state is already loading.
        let isCurrent = true;

        getModelSettings(botId)
            .then((loaded) => {
                if (isCurrent) {
                    const { aliases: loadedAliases, ...settings } = loaded;

                    setDraft(settings);
                    setAliases(loadedAliases);
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
    }, [botId, loadAttempt]);

    function changeKind(kind: ModelKind, value: string | null): void {
        setIsSaved(false);
        setDraft(currentDraft => ({ ...currentDraft, [kind]: value }));
    }

    function handleSave(event: SyntheticEvent<HTMLFormElement>): void {
        event.preventDefault();

        if (isSaving) {
            return;
        }

        setIsSaving(true);
        setIsSaved(false);
        setProblem(undefined);
        saveModelSettings(botId, draft)
            .then((saved) => {
                setDraft(saved);
                setIsSaved(true);
            })
            .catch((error: unknown) => {
                const failureText = describeFailure(error);

                setProblem(failureText);
            })
            .finally(() => {
                setIsSaving(false);
            });
    }

    return (
        <div className="rules-panel" role="dialog" aria-label={`Models for ${botName}`}>
            <div className="rules-header">
                <h2>{`Models for ${botName}`}</h2>
                <button type="button" className="icon-button" aria-label="Close models" onClick={onClose}>
                    &#10005;
                </button>
            </div>
            <p className="rules-help">
                Smaller models cost less usage. Helpers are optional: a helper does its work only when you pick a model for it.
            </p>
            {loadState === 'loading' ? <p>Loading...</p> : null}
            {loadState === 'failed'
                ? (
                        <p className="rules-problem">
                            The models could not be loaded.
                            {' '}
                            <button
                                type="button"
                                onClick={() => {
                                    setLoadState('loading');
                                    setLoadAttempt(attempt => attempt + 1);
                                }}
                            >
                                Try again
                            </button>
                        </p>
                    )
                : null}
            {loadState !== 'ready'
                ? null
                : (
                        <form className="models-form" onSubmit={handleSave}>
                            {/* A change made while a save is on its way would be replaced by the saved copy, so the fields wait. */}
                            <fieldset className="plain-fieldset" disabled={isSaving}>
                                {KIND_ROWS.map(row => (
                                    <ModelSelect
                                        key={row.kind}
                                        label={row.label}
                                        noneText={row.noneText}
                                        value={draft[row.kind]}
                                        aliases={aliases}
                                        onChange={(value) => {
                                            changeKind(row.kind, value);
                                        }}
                                    />
                                ))}
                            </fieldset>
                            <button type="submit" disabled={isSaving}>
                                {isSaving ? 'Saving...' : 'Save models'}
                            </button>
                            {isSaved ? <p className="rules-help" role="status">Saved.</p> : null}
                        </form>
                    )}
            {problem === undefined ? null : <p className="rules-problem" role="alert">{problem}</p>}
        </div>
    );
}

export { ModelsPanel };
export type { ModelsPanelProps };
