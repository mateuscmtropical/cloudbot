import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import type { BotRoutine } from '../../shared/routineTypes.ts';
import { RequestFailedError, listRoutines, removeRoutine } from '../apiClient.ts';
import { describeSchedule, formatRunTime } from '../routineText.ts';

interface RoutinesPanelProps {
    botId: string;
    botName: string;
    onClose: () => void;
}

type LoadState = 'loading' | 'ready' | 'failed';

const NOT_FOUND_STATUS = 404;

function describeFailure(error: unknown): string {
    if (error instanceof RequestFailedError && error.serverMessage !== undefined) {
        return error.serverMessage;
    }

    return 'The routine could not be removed. Try again.';
}

// The owner's routines for one bot. The bot creates routines when asked in the chat.
function RoutinesPanel({ botId, botName, onClose }: RoutinesPanelProps): ReactElement {
    const [routines, setRoutines] = useState<BotRoutine[]>([]);
    const [loadState, setLoadState] = useState<LoadState>('loading');
    const [problem, setProblem] = useState<string | undefined>(undefined);
    // Routines with a removal in progress, so a double click sends one request.
    const [removingIds, setRemovingIds] = useState<string[]>([]);
    // Bumped by the retry button to load the routines again.
    const [loadAttempt, setLoadAttempt] = useState(0);

    useEffect(() => {
        // The panel is mounted for one bot, so the first state is already loading.
        let isCurrent = true;

        listRoutines(botId)
            .then((loadedRoutines) => {
                if (isCurrent) {
                    setRoutines(loadedRoutines);
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

    function handleRemove(routineId: string): void {
        if (removingIds.includes(routineId)) {
            return;
        }

        setProblem(undefined);
        setRemovingIds(currentIds => [...currentIds, routineId]);
        const dropRoutine = (): void => {
            setRoutines(currentRoutines => currentRoutines.filter(routine => routine.id !== routineId));
        };

        removeRoutine(botId, routineId)
            .then(dropRoutine)
            .catch((error: unknown) => {
                // The bot may have deleted the routine from the chat already.
                if (error instanceof RequestFailedError && error.status === NOT_FOUND_STATUS) {
                    dropRoutine();

                    return;
                }

                const failureText = describeFailure(error);

                setProblem(failureText);
            })
            .finally(() => {
                setRemovingIds(currentIds => currentIds.filter(currentId => currentId !== routineId));
            });
    }

    return (
        <div className="rules-panel" role="dialog" aria-label={`Routines for ${botName}`}>
            <div className="rules-header">
                <h2>{`Routines for ${botName}`}</h2>
                <button type="button" className="icon-button" aria-label="Close routines" onClick={onClose}>
                    &#10005;
                </button>
            </div>
            <p className="rules-help">
                The bot creates routines when you ask it in the chat. It runs each one on its schedule and sends the prompt as a message.
            </p>
            {loadState === 'loading' ? <p>Loading...</p> : null}
            {loadState === 'failed'
                ? (
                        <p className="rules-problem">
                            The routines could not be loaded.
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
            {loadState === 'ready' && routines.length === 0 ? <p>No routines yet.</p> : null}
            <ul className="rules-list">
                {routines.map(routine => (
                    <li key={routine.id} className="rule-item">
                        <span className="rule-kind">{routine.name}</span>
                        <span className="rule-text">{routine.prompt}</span>
                        <span className="rule-tools">{`${describeSchedule(routine.schedule)}${routine.isEnabled ? '' : ' (off)'}`}</span>
                        <span className="rule-tools">{`Next run: ${formatRunTime(routine.nextRunAt)}`}</span>
                        <span className="rule-tools">{`Last run: ${formatRunTime(routine.lastRunAt)}`}</span>
                        <button
                            type="button"
                            disabled={removingIds.includes(routine.id)}
                            aria-label={`Remove routine: ${routine.name}`}
                            onClick={() => {
                                handleRemove(routine.id);
                            }}
                        >
                            Remove
                        </button>
                    </li>
                ))}
            </ul>
            {problem === undefined ? null : <p className="rules-problem" role="alert">{problem}</p>}
        </div>
    );
}

export { RoutinesPanel };
export type { RoutinesPanelProps };
