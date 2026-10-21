import { useEffect, useState } from 'react';
import type { ChangeEvent, ReactElement, SyntheticEvent } from 'react';

import type { BotRoutine } from '../../shared/routineTypes.ts';
import type { BotWatch } from '../../shared/watchTypes.ts';
import type { BotWebhook, CreatedBotWebhook } from '../../shared/webhookTypes.ts';
import { RequestFailedError, createWebhook, listRoutines, listWatches, listWebhooks, removeRoutine, removeWatch, removeWebhook } from '../apiClient.ts';
import { describeSchedule, formatRunTime } from '../routineText.ts';
import { WebhookUrlNotice } from './WebhookUrlNotice.tsx';

interface RoutinesPanelProps {
    botId: string;
    botName: string;
    onClose: () => void;
}

interface BotSectionProps {
    botId: string;
}

type LoadState = 'loading' | 'ready' | 'failed';

const NOT_FOUND_STATUS = 404;
const MAX_WEBHOOK_NAME_LENGTH = 60;

function describeFailure(error: unknown, fallbackText: string): string {
    if (error instanceof RequestFailedError && error.serverMessage !== undefined) {
        return error.serverMessage;
    }

    return fallbackText;
}

// The page watches of one bot. The bot creates them in the chat, and the owner can only list and remove them here.
function WatchSection({ botId }: BotSectionProps): ReactElement {
    const [watches, setWatches] = useState<BotWatch[]>([]);
    const [loadState, setLoadState] = useState<LoadState>('loading');
    const [removingIds, setRemovingIds] = useState<string[]>([]);
    const [problem, setProblem] = useState<string | undefined>(undefined);

    useEffect(() => {
        let isCurrent = true;

        listWatches(botId)
            .then((loadedWatches) => {
                if (isCurrent) {
                    setWatches(loadedWatches);
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
    }, [botId]);

    function handleRemove(watchId: string): void {
        if (removingIds.includes(watchId)) {
            return;
        }

        setProblem(undefined);
        setRemovingIds(currentIds => [...currentIds, watchId]);

        removeWatch(botId, watchId)
            .then(() => {
                setWatches(currentWatches => currentWatches.filter(watch => watch.id !== watchId));
            })
            .catch((error: unknown) => {
                // The watch may have been removed already, so it leaves the list.
                if (error instanceof RequestFailedError && error.status === NOT_FOUND_STATUS) {
                    setWatches(currentWatches => currentWatches.filter(watch => watch.id !== watchId));

                    return;
                }

                const failureText = describeFailure(error, 'The page watch could not be removed. Try again.');

                setProblem(failureText);
            })
            .finally(() => {
                setRemovingIds(currentIds => currentIds.filter(currentId => currentId !== watchId));
            });
    }

    return (
        <section aria-label="Page watches" className="webhook-section">
            <h3>Page watches</h3>
            <p className="rules-help">
                The bot checks these pages on a schedule and wakes up when their text changes. The owner asks for a watch in the chat.
            </p>
            {loadState === 'loading' ? <p>Loading...</p> : null}
            {loadState === 'failed' ? <p className="rules-problem">The page watches could not be loaded.</p> : null}
            {loadState === 'ready' && watches.length === 0 ? <p>No page watches yet.</p> : null}
            <ul className="rules-list">
                {watches.map(watch => (
                    <li key={watch.id} className="rule-item">
                        <span className="rule-kind">{watch.name}</span>
                        <span className="rule-tools">
                            {`Every ${String(watch.intervalMinutes)} minutes. ${watch.lastCheckedAt === null ? 'Not checked yet.' : `Checked: ${formatRunTime(watch.lastCheckedAt)}`}`}
                        </span>
                        <button
                            type="button"
                            disabled={removingIds.includes(watch.id)}
                            aria-label={`Remove page watch: ${watch.name}`}
                            onClick={() => {
                                handleRemove(watch.id);
                            }}
                        >
                            Remove
                        </button>
                    </li>
                ))}
            </ul>
            {problem === undefined ? null : <p className="rules-problem" role="alert">{problem}</p>}
        </section>
    );
}

// The owner's webhooks for one bot. The URL of a new webhook is shown once, right after Create.
function WebhookSection({ botId }: BotSectionProps): ReactElement {
    const [webhooks, setWebhooks] = useState<BotWebhook[]>([]);
    const [loadState, setLoadState] = useState<LoadState>('loading');
    const [nameDraft, setNameDraft] = useState('');
    const [isCreating, setIsCreating] = useState(false);
    // The new webhook with its URL. It is only in memory until the owner hides it or leaves the panel.
    const [created, setCreated] = useState<CreatedBotWebhook | undefined>(undefined);
    const [removingIds, setRemovingIds] = useState<string[]>([]);
    const [problem, setProblem] = useState<string | undefined>(undefined);

    useEffect(() => {
        let isCurrent = true;

        listWebhooks(botId)
            .then((loadedWebhooks) => {
                if (isCurrent) {
                    setWebhooks(loadedWebhooks);
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
    }, [botId]);

    function handleCreate(event: SyntheticEvent<HTMLFormElement>): void {
        event.preventDefault();

        const name = nameDraft.trim();

        if (name === '' || isCreating) {
            return;
        }

        setIsCreating(true);
        setProblem(undefined);

        createWebhook(botId, name)
            .then((createdWebhook) => {
                const listedWebhook: BotWebhook = { id: createdWebhook.id, name: createdWebhook.name, createdAt: createdWebhook.createdAt };

                setCreated(createdWebhook);
                setNameDraft('');
                setWebhooks(currentWebhooks => [...currentWebhooks, listedWebhook]);
            })
            .catch((error: unknown) => {
                const failureText = describeFailure(error, 'The webhook could not be created. Try again.');

                setProblem(failureText);
            })
            .finally(() => {
                setIsCreating(false);
            });
    }

    function handleRemove(webhookId: string): void {
        if (removingIds.includes(webhookId)) {
            return;
        }

        setProblem(undefined);
        setRemovingIds(currentIds => [...currentIds, webhookId]);
        const dropWebhook = (): void => {
            setWebhooks(currentWebhooks => currentWebhooks.filter(webhook => webhook.id !== webhookId));
        };

        removeWebhook(botId, webhookId)
            .then(dropWebhook)
            .catch((error: unknown) => {
                // The webhook may have been removed already, so it leaves the list.
                if (error instanceof RequestFailedError && error.status === NOT_FOUND_STATUS) {
                    dropWebhook();

                    return;
                }

                const failureText = describeFailure(error, 'The webhook could not be removed. Try again.');

                setProblem(failureText);
            })
            .finally(() => {
                setRemovingIds(currentIds => currentIds.filter(currentId => currentId !== webhookId));
            });
    }

    return (
        <section aria-label="Webhooks" className="webhook-section">
            <h3>Webhooks</h3>
            <p className="rules-help">
                An outside service calls a webhook URL to send the bot a message. Anyone with the URL can do that, so keep it private.
            </p>
            {loadState === 'loading' ? <p>Loading...</p> : null}
            {loadState === 'failed' ? <p className="rules-problem">The webhooks could not be loaded.</p> : null}
            {loadState === 'ready' && webhooks.length === 0 ? <p>No webhooks yet.</p> : null}
            <ul className="rules-list">
                {webhooks.map(webhook => (
                    <li key={webhook.id} className="rule-item">
                        <span className="rule-kind">{webhook.name}</span>
                        <span className="rule-tools">{`Created: ${formatRunTime(webhook.createdAt)}`}</span>
                        <button
                            type="button"
                            disabled={removingIds.includes(webhook.id)}
                            aria-label={`Remove webhook: ${webhook.name}`}
                            onClick={() => {
                                handleRemove(webhook.id);
                            }}
                        >
                            Remove
                        </button>
                    </li>
                ))}
            </ul>
            {created === undefined
                ? null
                : (
                        <WebhookUrlNotice
                            name={created.name}
                            url={created.url}
                            onHide={() => { setCreated(undefined); }}
                        />
                    )}
            <form className="rules-form" onSubmit={handleCreate}>
                <label htmlFor="webhook-name">Webhook name</label>
                <input
                    id="webhook-name"
                    type="text"
                    maxLength={MAX_WEBHOOK_NAME_LENGTH}
                    value={nameDraft}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => {
                        setNameDraft(event.target.value);
                    }}
                />
                <button type="submit" disabled={isCreating || nameDraft.trim() === ''}>Create</button>
            </form>
            {problem === undefined ? null : <p className="rules-problem" role="alert">{problem}</p>}
        </section>
    );
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

                const failureText = describeFailure(error, 'The routine could not be removed. Try again.');

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
            <WebhookSection botId={botId} />
            <WatchSection botId={botId} />
        </div>
    );
}

export { RoutinesPanel };
export type { RoutinesPanelProps };
