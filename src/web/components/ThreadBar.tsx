import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import type { ThreadSummary } from '../../shared/chatTypes.ts';
import { createThread, deleteThread, listThreads, RequestFailedError } from '../apiClient.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { CloseIcon } from './CloseIcon.tsx';
import { PlusIcon } from './PlusIcon.tsx';

interface ThreadBarProps {
    botId: string;
    // The chat on screen: the bot's own id or the id of one of its threads.
    activeId: string;
    // Goes up when something may have changed a thread, such as a new message or a turn that ended.
    refreshKey: number;
    onSelect: (chatId: string) => void;
}

const OWN_CHAT_LABEL = 'Main';

// The chats of a bot as a row of chips, with a button for a new one. Each chat has its own history and works on its own,
// while the bot keeps one memory, one set of rules and one set of secrets for all of them.
function ThreadBar({ botId, activeId, refreshKey, onSelect }: ThreadBarProps): ReactElement {
    const [loaded, setLoaded] = useState<{ botId: string; threads: ThreadSummary[] } | undefined>(undefined);
    const [problem, setProblem] = useState<string | undefined>(undefined);
    const [isDeleting, setIsDeleting] = useState(false);
    const [isAsking, setIsAsking] = useState(false);

    useEffect(() => {
        let isCurrent = true;

        listThreads(botId)
            .then((threads) => {
                if (isCurrent) {
                    setLoaded({ botId, threads });
                }
            })
            .catch(() => undefined);

        return () => {
            isCurrent = false;
        };
    }, [botId, refreshKey]);

    const threads = loaded?.botId === botId ? loaded.threads : [];
    const activeThread = threads.find(thread => thread.id === activeId);

    function handleCreate(): void {
        setProblem(undefined);
        createThread(botId)
            .then((thread) => {
                setLoaded({ botId, threads: [...threads, thread] });
                onSelect(thread.id);
            })
            .catch((error: unknown) => {
                setProblem(error instanceof RequestFailedError ? error.serverMessage ?? 'Could not start a chat.' : 'Could not start a chat.');
            });
    }

    function handleDelete(): void {
        setIsDeleting(true);
        deleteThread(botId, activeId)
            .then(() => {
                setIsAsking(false);
                setLoaded({ botId, threads: threads.filter(thread => thread.id !== activeId) });
                onSelect(botId);
            })
            .catch(() => {
                setProblem('Could not delete this chat. Try again.');
                setIsAsking(false);
            })
            .finally(() => {
                setIsDeleting(false);
            });
    }

    return (
        <div className="thread-bar">
            <div className="thread-chips" role="tablist" aria-label="Chats of this bot">
                {threads.map(thread => (
                    <button
                        key={thread.id}
                        type="button"
                        role="tab"
                        aria-selected={thread.id === activeId}
                        className="thread-chip"
                        data-running={thread.isRunning ? 'true' : undefined}
                        onClick={() => {
                            onSelect(thread.id);
                        }}
                    >
                        {thread.isDefault ? OWN_CHAT_LABEL : thread.name}
                    </button>
                ))}
            </div>
            {activeThread !== undefined && !activeThread.isDefault
                ? (
                        <button type="button" className="thread-action" aria-label="Delete this chat" onClick={() => { setIsAsking(true); }}>
                            <CloseIcon />
                        </button>
                    )
                : null}
            <button type="button" className="thread-action" aria-label="New chat" onClick={handleCreate}>
                <PlusIcon />
            </button>
            {problem === undefined ? null : <p className="thread-problem" role="alert">{problem}</p>}
            {isAsking
                ? (
                        <ConfirmDialog
                            title="Delete this chat?"
                            message="Its messages are deleted. Memory, rules and files of the bot stay."
                            isBusy={isDeleting}
                            onConfirm={handleDelete}
                            onCancel={() => { setIsAsking(false); }}
                        />
                    )
                : null}
        </div>
    );
}

export { ThreadBar };
