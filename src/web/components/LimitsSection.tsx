import { useEffect, useId, useState } from 'react';
import type { ReactElement, SyntheticEvent } from 'react';

import { RequestFailedError, getLimits, saveLimits } from '../apiClient.ts';
import type { LimitBound, LimitsResponse } from '../apiClient.ts';
import type { TurnLimit, TurnLimits } from '../../shared/limitTypes.ts';

interface LimitsSectionProps {
    botId: string;
}

interface LimitInputProps {
    // The visible label, such as "Steps".
    label: string;
    // The name a screen reader gets. It includes the group, so every input has its own name.
    accessibleName: string;
    value: number | null;
    bounds: LimitBound;
    onChange: (value: number | null) => void;
}

type LoadState = 'loading' | 'ready' | 'failed';
type LimitKind = keyof TurnLimit;
type LimitSlot = keyof TurnLimits;

interface LimitGroup {
    slot: LimitSlot;
    title: string;
}

interface LimitRow {
    kind: LimitKind;
    label: string;
}

const LIMIT_GROUPS: LimitGroup[] = [
    { slot: 'chat', title: 'Chat turns' },
    { slot: 'routines', title: 'Turns from routines, webhooks and watches' },
];

const LIMIT_ROWS: LimitRow[] = [
    { kind: 'minutes', label: 'Time (minutes)' },
    { kind: 'usd', label: 'Spending (USD, estimate)' },
    { kind: 'steps', label: 'Steps' },
];

const EMPTY_LIMITS: TurnLimits = {
    chat: { minutes: null, usd: null, steps: null },
    routines: { minutes: null, usd: null, steps: null },
};

function describeFailure(error: unknown): string {
    if (error instanceof RequestFailedError && error.serverMessage !== undefined) {
        return error.serverMessage;
    }

    return 'The limits could not be saved. Try again.';
}

// An empty box means no limit, so clearing it saves null.
function LimitInput({ label, accessibleName, value, bounds, onChange }: LimitInputProps): ReactElement {
    const inputId = useId();

    return (
        <div className="limit-row">
            <label htmlFor={inputId}>{label}</label>
            <input
                id={inputId}
                aria-label={accessibleName}
                type="number"
                min={bounds.min}
                max={bounds.max}
                step={bounds.isWhole ? 1 : 0.01}
                placeholder="No limit"
                value={value ?? ''}
                onChange={(event) => {
                    onChange(event.target.value === '' ? null : Number(event.target.value));
                }}
            />
        </div>
    );
}

// The limits of chat turns and of turns started by routines, webhooks and watches.
function LimitsSection({ botId }: LimitsSectionProps): ReactElement {
    const [loadState, setLoadState] = useState<LoadState>('loading');
    // Bumped by the retry button to load the limits again.
    const [loadAttempt, setLoadAttempt] = useState(0);
    const [bounds, setBounds] = useState<LimitsResponse['bounds'] | undefined>(undefined);
    const [draft, setDraft] = useState<TurnLimits>(EMPTY_LIMITS);
    const [isSaving, setIsSaving] = useState(false);
    const [isSaved, setIsSaved] = useState(false);
    const [problem, setProblem] = useState<string | undefined>(undefined);

    useEffect(() => {
        let isCurrent = true;

        getLimits(botId)
            .then((loaded) => {
                if (isCurrent) {
                    const { bounds: loadedBounds, ...limits } = loaded;

                    setDraft(limits);
                    setBounds(loadedBounds);
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

    function changeLimit(slot: LimitSlot, kind: LimitKind, value: number | null): void {
        setIsSaved(false);
        setDraft(currentDraft => ({
            ...currentDraft,
            [slot]: { ...currentDraft[slot], [kind]: value },
        }));
    }

    function handleSave(event: SyntheticEvent<HTMLFormElement>): void {
        event.preventDefault();

        if (isSaving) {
            return;
        }

        setIsSaving(true);
        setIsSaved(false);
        setProblem(undefined);
        saveLimits(botId, draft)
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
        <section className="limits-section" aria-label="Limits">
            <h3>Limits</h3>
            <p className="rules-help">
                A limit stops a turn when it runs too long, costs too much or takes too many steps. Leave a box empty for no limit. The agent and the review agent are each held to the spending limit, so a turn can spend up to twice the limit. The spending is an estimate, and a subscription is not billed by it.
            </p>
            {loadState === 'loading' ? <p>Loading...</p> : null}
            {loadState === 'failed'
                ? (
                        <p className="rules-problem">
                            The limits could not be loaded.
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
            {loadState !== 'ready' || bounds === undefined
                ? null
                : (
                        <form className="limits-form" onSubmit={handleSave}>
                            <fieldset className="plain-fieldset" disabled={isSaving}>
                                {LIMIT_GROUPS.map(group => (
                                    <div key={group.slot} className="limit-group" role="group" aria-label={group.title}>
                                        <h4 className="limit-group-title">{group.title}</h4>
                                        {LIMIT_ROWS.map(row => (
                                            <LimitInput
                                                key={row.kind}
                                                label={row.label}
                                                accessibleName={`${group.title}: ${row.label}`}
                                                value={draft[group.slot][row.kind]}
                                                bounds={bounds[row.kind]}
                                                onChange={(value) => {
                                                    changeLimit(group.slot, row.kind, value);
                                                }}
                                            />
                                        ))}
                                    </div>
                                ))}
                            </fieldset>
                            <button type="submit" disabled={isSaving}>
                                {isSaving ? 'Saving...' : 'Save limits'}
                            </button>
                            {isSaved ? <p className="rules-help" role="status">Limits saved.</p> : null}
                        </form>
                    )}
            {problem === undefined ? null : <p className="rules-problem" role="alert">{problem}</p>}
        </section>
    );
}

export { LimitsSection };
export type { LimitsSectionProps };
