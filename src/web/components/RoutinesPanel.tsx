import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import type { ProviderChoiceSummary, ProviderModelOptionSummary, WorkKindSummary } from '../../shared/providerTypes.ts';
import type { BotRoutine } from '../../shared/routineTypes.ts';
import { getWorkSettings, listProviders, listRoutines, RequestFailedError, setRoutineWork } from '../apiClient.ts';
import type { WorkChoiceInput } from '../apiClient.ts';
import { Field } from './Field.tsx';
import { ListGroup } from './ListGroup.tsx';
import { ListRow } from './ListRow.tsx';
import { PanelHeader } from './PanelHeader.tsx';
import { Select } from './Select.tsx';

interface RoutinesPanelBot {
    id: string;
    name: string;
}

interface RoutinesPanelProps {
    bot: RoutinesPanelBot;
    onClose: () => void;
}

interface RoutinesData {
    routines: BotRoutine[];
    // The kind of work for routines. Its choosable providers and model lists are the ones a routine can use.
    routinesWork: WorkKindSummary | undefined;
    providers: ProviderChoiceSummary[];
}

// The models and efforts a routine can pick from. Empty when the server lists none for its provider.
interface RoutineChoices {
    modelOptions: ProviderModelOptionSummary[];
    // The efforts of the default model.
    defaultEfforts: string[];
}

interface RoutineCardProps {
    routine: BotRoutine;
    routinesWork: WorkKindSummary | undefined;
    providers: ProviderChoiceSummary[];
    isBusy: boolean;
    onSave: (choice: WorkChoiceInput) => void;
}

function errorText(error: unknown, fallback: string): string {
    return error instanceof RequestFailedError && error.serverMessage !== undefined ? error.serverMessage : fallback;
}

function providerLabel(providers: ProviderChoiceSummary[], providerId: string): string {
    return providers.find(provider => provider.id === providerId)?.label ?? providerId;
}

function describeRoutine(routine: BotRoutine, providers: ProviderChoiceSummary[]): string {
    if (routine.provider === null) {
        return 'Routines default';
    }

    const modelName = routine.model ?? 'Default model';

    return [providerLabel(providers, routine.provider), modelName].join(' · ');
}

// A routine on the routines default runs on the provider the routines use. The efforts of the default model
// are only known for that provider.
function choicesFor(routine: BotRoutine, routinesWork: WorkKindSummary | undefined): RoutineChoices {
    if (routinesWork === undefined) {
        return { modelOptions: [], defaultEfforts: [] };
    }

    const provider = routine.provider ?? routinesWork.usedProvider;
    const isUsedProvider = provider === routinesWork.usedProvider;

    return {
        modelOptions: routinesWork.providerModels[provider] ?? [],
        defaultEfforts: isUsedProvider ? routinesWork.effortOptions : [],
    };
}

function effortsFor(model: string | null, choices: RoutineChoices): string[] {
    if (model === null) {
        return choices.defaultEfforts;
    }

    const option = choices.modelOptions.find(known => known.id === model);

    return option?.efforts ?? [];
}

// One routine with its provider, model and effort. Each change saves at once.
function RoutineCard({ routine, routinesWork, providers, isBusy, onSave }: RoutineCardProps): ReactElement {
    const choices = choicesFor(routine, routinesWork);
    const choosable = routinesWork?.choosableProviders ?? [];
    const offered = providers.filter(provider => choosable.includes(provider.id));
    const efforts = effortsFor(routine.model, choices);

    return (
        <div className="settings-section">
            <ListGroup label={routine.name} ariaLabel={`Work of ${routine.name}`}>
                <ListRow title="Runs on" value={describeRoutine(routine, providers)} />
                <Field label="Provider" isInline>
                    <Select
                        label={`${routine.name} provider`}
                        value={routine.provider ?? ''}
                        disabled={isBusy}
                        onChange={(event) => {
                            onSave({ provider: event.currentTarget.value || null, model: null, effort: null });
                        }}
                    >
                        <option value="">Routines default</option>
                        {offered.map(provider => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
                    </Select>
                </Field>
                {choices.modelOptions.length === 0
                    ? null
                    : (
                            <Field label="Model" isInline>
                                <Select
                                    label={`${routine.name} model`}
                                    value={routine.model ?? ''}
                                    disabled={isBusy}
                                    onChange={(event) => {
                                        const nextModel = event.currentTarget.value || null;
                                        const nextEfforts = effortsFor(nextModel, choices);
                                        const keptEffort = routine.effort !== null && nextEfforts.includes(routine.effort) ? routine.effort : null;

                                        onSave({ provider: routine.provider, model: nextModel, effort: keptEffort });
                                    }}
                                >
                                    <option value="">Default</option>
                                    {choices.modelOptions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                                </Select>
                            </Field>
                        )}
                {efforts.length === 0
                    ? null
                    : (
                            <Field label="Effort" isInline>
                                <Select
                                    label={`${routine.name} effort`}
                                    value={routine.effort ?? ''}
                                    disabled={isBusy}
                                    onChange={(event) => {
                                        onSave({ provider: routine.provider, model: routine.model, effort: event.currentTarget.value || null });
                                    }}
                                >
                                    <option value="">Default</option>
                                    {efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
                                </Select>
                            </Field>
                        )}
            </ListGroup>
        </div>
    );
}

// The owner's page for one bot's routines: see the provider of each one and change it.
function RoutinesPanel({ bot, onClose }: RoutinesPanelProps): ReactElement {
    const [data, setData] = useState<RoutinesData | undefined>(undefined);
    const [problem, setProblem] = useState<string | undefined>(undefined);
    const [isBusy, setIsBusy] = useState(false);

    useEffect(() => {
        let isCurrent = true;

        Promise.all([listRoutines(bot.id), getWorkSettings(bot.id), listProviders()])
            .then(([routines, workKinds, providers]) => {
                if (isCurrent) {
                    const routinesWork = workKinds.find(item => item.kind === 'routines');

                    setData({ routines, routinesWork, providers });
                }
            })
            .catch((error: unknown) => {
                if (isCurrent) {
                    const text = errorText(error, 'The routines could not be loaded.');

                    setProblem(text);
                }
            });

        return () => {
            isCurrent = false;
        };
    }, [bot.id]);

    function saveWork(routineId: string, choice: WorkChoiceInput): void {
        setIsBusy(true);
        setProblem(undefined);
        setRoutineWork(bot.id, routineId, choice)
            .then((saved) => {
                setData(current => current === undefined
                    ? current
                    : { ...current, routines: current.routines.map(known => known.id === saved.id ? saved : known) });
            })
            .catch((error: unknown) => {
                const text = errorText(error, 'The choice could not be saved.');

                setProblem(text);
            })
            .finally(() => {
                setIsBusy(false);
            });
    }

    return (
        <section className="people-panel" aria-labelledby="routines-title">
            <PanelHeader
                className="people-panel-header settings-page-header"
                closeLabel="Back to profile"
                onClose={onClose}
                title="Routines"
                titleId="routines-title"
                description="Each routine runs on the provider, model and effort set here, or on the routines default."
            />

            <div className="account-panel-content">
                {data === undefined && problem === undefined ? <p className="panel-loading" role="status">Loading...</p> : null}
                {data?.routines.length === 0 ? <p className="settings-help-text">No routines yet.</p> : null}
                {data === undefined
                    ? null
                    : data.routines.map(routine => (
                            <RoutineCard
                                key={routine.id}
                                routine={routine}
                                routinesWork={data.routinesWork}
                                providers={data.providers}
                                isBusy={isBusy}
                                onSave={(choice) => {
                                    saveWork(routine.id, choice);
                                }}
                            />
                        ))}
                {problem === undefined ? null : <p className="settings-error" role="alert">{problem}</p>}
            </div>
        </section>
    );
}

export { RoutinesPanel };
export type { RoutinesPanelProps };
