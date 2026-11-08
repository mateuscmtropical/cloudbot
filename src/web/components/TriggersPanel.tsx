import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import type { BotTrigger } from '../../shared/triggerTypes.ts';
import { listTriggers, removeTrigger, RequestFailedError, setTriggerEnabled } from '../apiClient.ts';
import { Button } from './Button.tsx';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { ListGroup } from './ListGroup.tsx';
import { ListRow } from './ListRow.tsx';
import { PanelHeader } from './PanelHeader.tsx';

interface TriggersPanelBot {
    id: string;
    name: string;
}

interface TriggersPanelProps {
    bot: TriggersPanelBot;
    onClose: () => void;
}

interface TriggerCardProps {
    botId: string;
    trigger: BotTrigger;
    onChanged: (trigger: BotTrigger) => void;
    onRemoved: (triggerId: string) => void;
}

function errorText(error: unknown, fallback: string): string {
    return error instanceof RequestFailedError && error.serverMessage !== undefined ? error.serverMessage : fallback;
}

function describeStatus(trigger: BotTrigger): string {
    if (!trigger.isEnabled) {
        return 'Paused';
    }

    return trigger.lastCheckedAt === null ? 'Waiting for the first check' : 'Active';
}

function describeLastCheck(lastCheckedAt: number | null): string {
    return lastCheckedAt === null
        ? 'Not yet'
        : new Date(lastCheckedAt)
                .toLocaleString();
}

// One trigger. The owner can pause, resume or delete it. The bot makes triggers in the chat.
function TriggerCard({ botId, trigger, onChanged, onRemoved }: TriggerCardProps): ReactElement {
    const [problem, setProblem] = useState<string | undefined>(undefined);
    const [isBusy, setIsBusy] = useState(false);
    const [isDeleteOpen, setIsDeleteOpen] = useState(false);

    function toggle(): void {
        setIsBusy(true);
        setProblem(undefined);
        setTriggerEnabled(botId, trigger.id, !trigger.isEnabled)
            .then(onChanged)
            .catch((error: unknown) => {
                const text = errorText(error, 'Could not change the trigger.');

                setProblem(text);
            })
            .finally(() => {
                setIsBusy(false);
            });
    }

    function confirmDelete(): void {
        setIsBusy(true);
        removeTrigger(botId, trigger.id)
            .then(() => {
                onRemoved(trigger.id);
            })
            .catch((error: unknown) => {
                const text = errorText(error, 'Could not delete the trigger.');

                setProblem(text);
                setIsDeleteOpen(false);
                setIsBusy(false);
            });
    }

    return (
        <div className="settings-section">
            <ListGroup label={trigger.name} ariaLabel={`Details of ${trigger.name}`}>
                <ListRow title="Status" value={describeStatus(trigger)} />
                <ListRow title="Source" value={trigger.sourceLabel} />
                <ListRow title="Target" value={trigger.target === '' ? 'Default' : trigger.target} />
                <ListRow title="Checked every" value={`${String(trigger.intervalMinutes)} minutes`} />
                <ListRow title="Last check" value={describeLastCheck(trigger.lastCheckedAt)} />
                <ListRow title="What the bot does" description={trigger.prompt} />
            </ListGroup>
            {problem === undefined ? null : <p className="settings-error" role="alert">{problem}</p>}
            <Button disabled={isBusy} onClick={toggle}>{trigger.isEnabled ? 'Pause' : 'Resume'}</Button>
            <Button
                disabled={isBusy}
                onClick={() => {
                    setIsDeleteOpen(true);
                }}
            >
                Delete trigger
            </Button>
            {isDeleteOpen
                ? (
                        <ConfirmDialog
                            title={`Delete ${trigger.name}?`}
                            message="It is not checked again."
                            isBusy={isBusy}
                            onConfirm={confirmDelete}
                            onCancel={() => {
                                setIsDeleteOpen(false);
                            }}
                        />
                    )
                : null}
        </div>
    );
}

// The owner's page for one bot's app triggers: see what each one watches, pause it or delete it.
function TriggersPanel({ bot, onClose }: TriggersPanelProps): ReactElement {
    const [triggers, setTriggers] = useState<BotTrigger[] | undefined>(undefined);
    const [problem, setProblem] = useState<string | undefined>(undefined);

    useEffect(() => {
        let isCurrent = true;

        listTriggers(bot.id)
            .then((listed) => {
                if (isCurrent) {
                    setTriggers(listed);
                }
            })
            .catch((error: unknown) => {
                if (isCurrent) {
                    const text = errorText(error, 'The triggers could not be loaded.');

                    setProblem(text);
                }
            });

        return () => {
            isCurrent = false;
        };
    }, [bot.id]);

    return (
        <section className="people-panel" aria-labelledby="triggers-title">
            <PanelHeader
                className="people-panel-header settings-page-header"
                closeLabel="Back to profile"
                onClose={onClose}
                title="App triggers"
                titleId="triggers-title"
                description={`${bot.name} wakes when something new appears in a connected app. Ask ${bot.name} in the chat to make a trigger.`}
            />

            <div className="account-panel-content">
                {problem === undefined ? null : <p className="settings-error" role="alert">{problem}</p>}
                {triggers === undefined && problem === undefined ? <p className="panel-loading" role="status">Loading...</p> : null}
                {triggers?.length === 0 ? <p className="settings-help-text">No app triggers yet.</p> : null}
                {triggers?.map(trigger => (
                    <TriggerCard
                        key={trigger.id}
                        botId={bot.id}
                        trigger={trigger}
                        onChanged={(saved) => {
                            setTriggers(current => current?.map(known => known.id === saved.id ? saved : known));
                        }}
                        onRemoved={(triggerId) => {
                            setTriggers(current => current?.filter(known => known.id !== triggerId));
                        }}
                    />
                ))}
            </div>
        </section>
    );
}

export { TriggersPanel };
export type { TriggersPanelProps };
