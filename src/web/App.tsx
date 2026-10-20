import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import type { BotSummary, ChatEvent, ChatMessage } from '../shared/chatTypes.ts';
import { BotList } from './components/BotList.tsx';
import { ConversationView } from './components/ConversationView.tsx';
import { listBots, listMessages, RequestFailedError, sendMessage, stopTurn, submitChoice, submitCode, submitSecret, subscribeToEvents, uploadAttachments } from './apiClient.ts';
import { mergeMessages, upsertMessage } from './messageList.ts';

interface DraftState {
    botId: string;
    text: string;
    // The highest message sequence known when the draft started. Older replies never clear it.
    afterSequence: number;
}

const emptyDraft: DraftState = { botId: '', text: '', afterSequence: 0 };

function App(): ReactElement {
    const [bots, setBots] = useState<BotSummary[]>([]);
    const [selectedBotId, setSelectedBotId] = useState<string | undefined>(undefined);
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [draft, setDraft] = useState<DraftState>(emptyDraft);
    const [runningBotId, setRunningBotId] = useState<string | undefined>(undefined);
    const [isBotListOpen, setIsBotListOpen] = useState(false);
    const [errorText, setErrorText] = useState<string | undefined>(undefined);
    const messagesRef = useRef<ChatMessage[]>([]);

    useEffect(() => {
        messagesRef.current = messages;
    }, [messages]);

    useEffect(() => {
        listBots()
            .then((loadedBots) => {
                const firstBotId = loadedBots[0]?.id;

                setBots(loadedBots);
                setSelectedBotId(firstBotId);
            })
            .catch(() => {
                setErrorText('Could not load your bots.');
            });
    }, []);

    useEffect(() => {
        if (selectedBotId === undefined) {
            return;
        }

        let isCurrent = true;

        // Runs on every stream connect, so messages missed during a dropout come back.
        const reloadMessages = (): void => {
            listMessages(selectedBotId)
                .then((loadedMessages) => {
                    if (!isCurrent) {
                        return;
                    }

                    const replies = loadedMessages.filter(message => message.role === 'assistant' && message.body.kind === 'text');

                    // A reply stored after the draft started means the draft is already written, as a message event would.
                    setDraft((previousDraft) => {
                        const hasNewerReply = replies.some(reply => reply.sequence > previousDraft.afterSequence);

                        return previousDraft.botId === selectedBotId && hasNewerReply ? emptyDraft : previousDraft;
                    });

                    setMessages(previousMessages => mergeMessages(previousMessages, loadedMessages));
                })
                .catch(() => {
                    setErrorText('Could not load the conversation.');
                });
        };

        const unsubscribe = subscribeToEvents(selectedBotId, (event: ChatEvent) => {
            if (event.type === 'textDelta') {
                const knownSequences = messagesRef.current.map(message => message.sequence);
                const knownSequence = Math.max(0, ...knownSequences);

                setDraft((previousDraft) => {
                    const isNewDraft = previousDraft.botId !== event.botId;

                    return {
                        botId: event.botId,
                        text: (isNewDraft ? '' : previousDraft.text) + event.text,
                        afterSequence: isNewDraft ? knownSequence : previousDraft.afterSequence,
                    };
                });

                return;
            }

            // A stored message ends the block being written, so its draft goes away.
            if (event.type === 'message') {
                setDraft(emptyDraft);
                setMessages(previousMessages => upsertMessage(previousMessages, event.message));

                return;
            }

            setDraft(emptyDraft);
            setRunningBotId(event.isRunning ? event.botId : undefined);

            // A finished turn may have renamed the bot, so the sidebar list is refreshed.
            if (!event.isRunning) {
                listBots()
                    .then(setBots)
                    .catch(() => {
                        setErrorText('Could not load your bots.');
                    });
            }
        }, reloadMessages);

        return () => {
            isCurrent = false;
            unsubscribe();
        };
    }, [selectedBotId]);

    function showMessageResult(resultPromise: Promise<ChatMessage>): void {
        resultPromise
            .then((savedMessage) => {
                setMessages(previousMessages => upsertMessage(previousMessages, savedMessage));
            })
            .catch(() => {
                setErrorText('The request failed. Try again.');
            });
    }

    function handleSelectBot(botId: string): void {
        setSelectedBotId(botId);
        setIsBotListOpen(false);
    }

    function handleSend(text: string): void {
        if (selectedBotId === undefined) {
            return;
        }

        setRunningBotId(selectedBotId);
        const sendPromise = sendMessage(selectedBotId, text);

        // A failed send never starts a turn, so the running state must not stay on.
        sendPromise.catch((error: unknown) => {
            // A 409 means a turn is already running, so the running state stays on.
            const isBusy = error instanceof RequestFailedError && error.status === 409;

            if (!isBusy) {
                setRunningBotId(undefined);
            }
        });
        showMessageResult(sendPromise);
    }

    function handleStop(): void {
        if (selectedBotId === undefined) {
            return;
        }

        const stopPromise = stopTurn(selectedBotId);

        stopPromise.catch(() => {
            setErrorText('Could not stop the bot.');
        });
    }

    function handleAttach(files: File[]): void {
        if (selectedBotId === undefined) {
            return;
        }

        const uploadPromise = uploadAttachments(selectedBotId, files);

        uploadPromise.catch(() => {
            setErrorText('Could not upload the files.');
        });
    }

    function handleChoose(messageId: string, choiceId: string): void {
        if (selectedBotId === undefined) {
            return;
        }

        const choicePromise = submitChoice(selectedBotId, messageId, choiceId);

        showMessageResult(choicePromise);
    }

    function handleSubmitCode(messageId: string, code: string): void {
        if (selectedBotId === undefined) {
            return;
        }

        const codePromise = submitCode(selectedBotId, messageId, code);

        showMessageResult(codePromise);
    }

    function handleSubmitSecret(messageId: string, value: string): void {
        if (selectedBotId === undefined) {
            return;
        }

        const secretPromise = submitSecret(selectedBotId, messageId, value);

        showMessageResult(secretPromise);
    }

    const selectedBot = bots.find(bot => bot.id === selectedBotId);
    const visibleMessages = messages.filter(message => message.botId === selectedBotId);
    const isRunning = selectedBotId !== undefined && runningBotId === selectedBotId;

    return (
        <div className="app">
            <BotList
                bots={bots}
                selectedBotId={selectedBotId}
                isOpen={isBotListOpen}
                onSelectBot={handleSelectBot}
            />
            {isBotListOpen
                ? (
                        <button
                            type="button"
                            className="scrim"
                            aria-label="Close bot list"
                            onClick={() => {
                                setIsBotListOpen(false);
                            }}
                        />
                    )
                : null}
            <main className="main-column">
                {errorText === undefined
                    ? null
                    : (
                            <p className="error-banner" role="alert">{errorText}</p>
                        )}
                <ConversationView
                    bot={selectedBot}
                    messages={visibleMessages}
                    draftText={draft.botId === selectedBotId ? draft.text : ''}
                    isRunning={isRunning}
                    actions={{ onChoose: handleChoose, onSubmitCode: handleSubmitCode, onSubmitSecret: handleSubmitSecret }}
                    onOpenBotList={() => {
                        setIsBotListOpen(true);
                    }}
                    onSend={handleSend}
                    onStop={handleStop}
                    onAttach={handleAttach}
                />
            </main>
        </div>
    );
}

export { App };
