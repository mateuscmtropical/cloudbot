import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import type { ProviderChoiceSummary, WorkKindSummary } from '../../shared/providerTypes.ts';
import { getWorkSettings, saveWorkChoice } from '../apiClient.ts';
import type { WorkChoiceInput } from '../apiClient.ts';
import { Field } from './Field.tsx';
import { PopoverMenuSection } from './PopoverMenu.tsx';
import { Select } from './Select.tsx';

interface WorkPickerProps {
    botId: string;
    // The connected providers, as the provider list above shows them.
    providers: ProviderChoiceSummary[];
    // Reads again when it changes, since the work that follows the chat moved with it.
    refreshKey: string;
}

function describeUse(work: WorkKindSummary): string {
    return [work.usedProviderLabel, work.usedModel ?? 'Default model', work.usedEffort ?? 'Default effort'].join(', ');
}

// What each kind of work runs on, and the choice of its provider, model and effort. Every choice saves at once.
function WorkPicker({ botId, providers, refreshKey }: WorkPickerProps): ReactElement | null {
    const [work, setWork] = useState<WorkKindSummary[] | undefined>(undefined);
    const [problem, setProblem] = useState<string | undefined>(undefined);
    const lastChangeRef = useRef(0);

    useEffect(() => {
        let isCurrent = true;

        getWorkSettings(botId)
            .then((loaded) => {
                if (isCurrent) {
                    setWork(loaded);
                }
            })
            .catch(() => {
                if (isCurrent) {
                    setProblem('The work settings could not be loaded.');
                }
            });

        return () => {
            isCurrent = false;
        };
    }, [botId, refreshKey]);

    function save(kind: string, choice: WorkChoiceInput): void {
        const changeNumber = lastChangeRef.current + 1;

        lastChangeRef.current = changeNumber;
        setProblem(undefined);

        saveWorkChoice(botId, kind, choice)
            .then((saved) => {
                if (lastChangeRef.current === changeNumber) {
                    setWork(saved);
                }
            })
            .catch(() => {
                if (lastChangeRef.current === changeNumber) {
                    setProblem('The choice could not be saved.');
                }
            });
    }

    if (work === undefined) {
        return problem === undefined ? null : <p className="provider-problem" role="alert">{problem}</p>;
    }

    return (
        <PopoverMenuSection title="Each kind of work">
            {work.map((item) => {
                const offered = providers.filter(provider => item.choosableProviders.includes(provider.id));
                const model = item.selectedModel;
                const efforts = item.modelOptions.find(option => option.id === model)?.efforts ?? item.effortOptions;

                return (
                    <details key={item.kind} className="work-row">
                        <summary className="work-row-summary">
                            <span className="provider-row-name">{item.label}</span>
                            <span className="work-row-use">{describeUse(item)}</span>
                        </summary>
                        <Field label="Provider" isInline>
                            <Select
                                label={`${item.label} provider`}
                                value={item.provider ?? ''}
                                onChange={(event) => {
                                    save(item.kind, { provider: event.currentTarget.value || null, model: null, effort: null });
                                }}
                            >
                                <option value="">Same as chat</option>
                                {offered.map(provider => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
                            </Select>
                        </Field>
                        {item.modelOptions.length === 0
                            ? null
                            : (
                                    <Field label="Model" isInline>
                                        <Select
                                            label={`${item.label} model`}
                                            value={model ?? ''}
                                            onChange={(event) => {
                                                const nextModel = event.currentTarget.value || null;
                                                const nextEfforts = item.modelOptions.find(option => option.id === nextModel)?.efforts ?? [];
                                                const keptEffort = item.selectedEffort !== null && nextEfforts.includes(item.selectedEffort) ? item.selectedEffort : null;

                                                save(item.kind, { provider: item.provider, model: nextModel, effort: keptEffort });
                                            }}
                                        >
                                            <option value="">Default</option>
                                            {item.modelOptions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                                        </Select>
                                    </Field>
                                )}
                        {efforts.length === 0
                            ? null
                            : (
                                    <Field label="Effort" isInline>
                                        <Select
                                            label={`${item.label} effort`}
                                            value={item.selectedEffort ?? ''}
                                            onChange={(event) => {
                                                save(item.kind, { provider: item.provider, model, effort: event.currentTarget.value || null });
                                            }}
                                        >
                                            <option value="">Default</option>
                                            {efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
                                        </Select>
                                    </Field>
                                )}
                    </details>
                );
            })}
            {problem === undefined ? null : <p className="provider-problem" role="alert">{problem}</p>}
        </PopoverMenuSection>
    );
}

export { WorkPicker };
export type { WorkPickerProps };
