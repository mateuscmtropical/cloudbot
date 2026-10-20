import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import type { BotSummary, ChatEvent, ChatMessage } from '../shared/chatTypes.ts';
import { BotList } from './components/BotList.tsx';
import { ConversationView } from './components/ConversationView.tsx';
import { listBots, listMessages, RequestFailedError, sendMessage, stopTurn, submitChoice, submitCode, submitSecret, subscribeToEvents, uploadAttachments } from './apiClient.ts';
import { MESSAGE_PAGE_SIZE, mergeMessages, upsertLiveMessage, upsertMessage } from './messageList.ts';

interface DraftState {
    botId: string;
    text: string;
    // The highest message sequence known when the draft started. Older replies never clear it.
    afterSequence: number;
}

interface OlderPagingState {
    // False once the list reached the beginning, so there is nothing older to load.
    hasMore: boolean;
    isLoading: boolean;
}

// Messages and paging share one state, so a decision about a response and the update it causes
// are made in one updater, against the state that is actually being updated.
interface ChatState {
    messages: ChatMessage[];
    olderPaging: Record<string, OlderPagingState | undefined>;
}

const emptyDraft: DraftState = { botId: '', text: '', afterSequence: 0 };
const emptyChatState: ChatState = { messages: [], olderPaging: {} };
const OLDER_ERROR_TEXT = 'Could not load older messages.';

function lowestSequenceOf(messages: ChatMessage[], botId: string): number {
    const botSequences = messages
        .filter(message => message.botId === botId)
        .map(message => message.sequence);

    return Math.min(Infinity, ...botSequences);
}

// Each request for a bot takes the next number. A response with an older number is out of date.
function nextGeneration(generations: Record<string, number>, botId: string): number {
    const generation = currentGeneration(generations, botId) + 1;

    generations[botId] = generation;

    return generation;
}

function currentGeneration(generations: Record<string, number>, botId: string): number {
    return generations[botId] ?? 0;
}

function withPaging(
    olderPaging: Record<string, OlderPagingState | undefined>,
    botId: string,
    changes: Partial<OlderPagingState>,
): Record<string, OlderPagingState | undefined> {
    const previousState = olderPaging[botId] ?? { hasMore: true, isLoading: false };

    return { ...olderPaging, [botId]: { ...previousState, ...changes } };
}

function App(): ReactElement {
    const [bots, setBots] = useState<BotSummary[]>([]);
    const [selectedBotId, setSelectedBotId] = useState<string | undefined>(undefined);
    const [chatState, setChatState] = useState<ChatState>(emptyChatState);
    const [draft, setDraft] = useState<DraftState>(emptyDraft);
    const [runningBotId, setRunningBotId] = useState<string | undefined>(undefined);
    const [isBotListOpen, setIsBotListOpen] = useState(false);
    const [errorText, setErrorText] = useState<string | undefined>(undefined);
    const messagesRef = useRef<ChatMessage[]>([]);
    const selectedBotIdRef = useRef<string | undefined>(undefined);
    // Checked before the state updates, so a fast second scroll cannot start a duplicate request.
    const olderLoadsInFlightRef = useRef(new Set<string>());
    const generationsRef = useRef<Record<string, number>>({});

    const messages = chatState.messages;
    const olderPaging = chatState.olderPaging;

    // A layout effect, so the ref matches the committed list before any later event or response reads it.
    useLayoutEffect(() => {
        messagesRef.current = messages;
    }, [messages]);

    useEffect(() => {
        selectedBotIdRef.current = selectedBotId;
    }, [selectedBotId]);

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
            const generation = nextGeneration(generationsRef.current, selectedBotId);

            listMessages(selectedBotId, { limit: MESSAGE_PAGE_SIZE })
                .then((loadedMessages) => {
                    // A newer reload started after this one, so this answer may be older than the list.
                    const isOutOfDate = currentGeneration(generationsRef.current, selectedBotId) !== generation;

                    if (!isCurrent || isOutOfDate) {
                        return;
                    }

                    const replies = loadedMessages.filter(message => message.role === 'assistant' && message.body.kind === 'text');

                    // A reply stored after the draft started means the draft is already written, as a message event would.
                    setDraft((previousDraft) => {
                        const hasNewerReply = replies.some(reply => reply.sequence > previousDraft.afterSequence);

                        return previousDraft.botId === selectedBotId && hasNewerReply ? emptyDraft : previousDraft;
                    });

                    const loadedSequences = loadedMessages.map(message => message.sequence);
                    const newestLoadedSequence = Math.max(0, ...loadedSequences);
                    const oldestLoadedSequence = Math.min(newestLoadedSequence, ...loadedSequences);
                    const loadedIdList = loadedMessages.map(message => message.id);
                    const loadedIds = new Set(loadedIdList);

                    // The newest page replaces what was held for this bot. Messages newer than that page are kept,
                    // since they arrived over the stream during the request. Local messages inside the page range,
                    // such as the setup echo, are never stored, so they are kept too. Older pages loaded before are dropped,
                    // and the reader can page back to them. hasMore follows the page length. A load in progress keeps its flag.
                    setChatState((previousState) => {
                        const keptMessages = previousState.messages
                            .filter((message) => {
                                const isNewer = message.sequence > newestLoadedSequence;
                                const isLocalInRange = !loadedIds.has(message.id) && message.sequence >= oldestLoadedSequence;

                                return message.botId !== selectedBotId || isNewer || isLocalInRange;
                            });
                        const previousPaging = previousState.olderPaging[selectedBotId];

                        return {
                            messages: mergeMessages(keptMessages, loadedMessages),
                            olderPaging: {
                                ...previousState.olderPaging,
                                [selectedBotId]: {
                                    hasMore: loadedMessages.length === MESSAGE_PAGE_SIZE,
                                    isLoading: previousPaging?.isLoading === true,
                                },
                            },
                        };
                    });
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
                setChatState(previousState => ({
                    ...previousState,
                    messages: upsertLiveMessage(previousState.messages, event.message),
                }));

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
                setErrorText(undefined);
                setChatState(previousState => ({
                    ...previousState,
                    messages: upsertLiveMessage(previousState.messages, savedMessage),
                }));
            })
            .catch((error: unknown) => {
                const serverMessage = error instanceof RequestFailedError ? error.serverMessage : undefined;

                setErrorText(serverMessage ?? 'The request failed. Try again.');
            });
    }

    function updateOlderPaging(botId: string, changes: Partial<OlderPagingState>): void {
        setChatState(previousState => ({
            ...previousState,
            olderPaging: withPaging(previousState.olderPaging, botId, changes),
        }));
    }

    // Loads the page before the oldest message on screen. The result is merged by sequence,
    // so a page that overlaps the current list adds nothing twice.
    // Each bot keeps its own paging state. A failed load keeps hasMore, so the next scroll to the top retries it.
    function handleLoadOlder(): void {
        if (selectedBotId === undefined || olderLoadsInFlightRef.current.has(selectedBotId)) {
            return;
        }

        const botSequences = messagesRef.current
            .filter(message => message.botId === selectedBotId)
            .map(message => message.sequence);

        if (botSequences.length === 0) {
            return;
        }

        const oldestSequence = Math.min(...botSequences);
        const loadingBotId = selectedBotId;
        const generation = currentGeneration(generationsRef.current, loadingBotId);

        olderLoadsInFlightRef.current.add(loadingBotId);
        updateOlderPaging(loadingBotId, { isLoading: true });

        const olderPromise = listMessages(loadingBotId, { beforeSequence: oldestSequence, limit: MESSAGE_PAGE_SIZE });

        olderPromise
            .then((olderMessages) => {
                olderLoadsInFlightRef.current.delete(loadingBotId);

                // A page is dropped when a reload started after it, or when its bot is no longer selected.
                // The list has moved when its oldest message is no longer the one requested, which is checked
                // inside the updater, against the state being updated. A dropped page never changes hasMore.
                const isOutOfDate = currentGeneration(generationsRef.current, loadingBotId) !== generation;

                setChatState((previousState) => {
                    const isListMoved = lowestSequenceOf(previousState.messages, loadingBotId) !== oldestSequence;
                    const isDropped = isOutOfDate || isListMoved || selectedBotIdRef.current !== loadingBotId;

                    if (isDropped) {
                        return {
                            ...previousState,
                            olderPaging: withPaging(previousState.olderPaging, loadingBotId, { isLoading: false }),
                        };
                    }

                    return {
                        messages: mergeMessages(previousState.messages, olderMessages),
                        olderPaging: withPaging(previousState.olderPaging, loadingBotId, {
                            hasMore: olderMessages.length === MESSAGE_PAGE_SIZE,
                            isLoading: false,
                        }),
                    };
                });
                setErrorText(previousError => (previousError === OLDER_ERROR_TEXT ? undefined : previousError));
            })
            .catch(() => {
                olderLoadsInFlightRef.current.delete(loadingBotId);
                updateOlderPaging(loadingBotId, { isLoading: false });

                if (selectedBotIdRef.current === loadingBotId) {
                    setErrorText(OLDER_ERROR_TEXT);
                }
            });
    }

    function handleSelectBot(botId: string): void {
        // The older-load error belongs to the bot it was for, so another bot starts clean.
        setErrorText(previousError => (previousError === OLDER_ERROR_TEXT ? undefined : previousError));
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
        const resultPromise = sendPromise.then((message) => {
            if (message.role === 'assistant') {
                const localMessage: ChatMessage = {
                    id: crypto.randomUUID(), botId: selectedBotId, role: 'user',
                    createdAt: Date.now(), sequence: message.sequence - 0.5,
                    body: { kind: 'text', text },
                };

                // Setup input stays in this browser view and is never saved on the server.
                setChatState((previousState) => {
                    const withInput = upsertMessage(previousState.messages, localMessage);
                    const withReminder = upsertMessage(withInput, message);

                    return {
                        ...previousState,
                        messages: withReminder.sort((first, second) => first.sequence - second.sequence),
                    };
                });
                setRunningBotId(undefined);
            }

            return message;
        });

        showMessageResult(resultPromise);
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

    function handleChoose(messageId: string, choiceId: string): Promise<void> {
        if (selectedBotId === undefined) {
            return Promise.resolve();
        }

        const choicePromise = submitChoice(selectedBotId, messageId, choiceId);

        showMessageResult(choicePromise);

        return choicePromise.then(() => undefined, () => undefined);
    }

    function handleSubmitCode(messageId: string, code: string): void {
        if (selectedBotId === undefined) {
            return;
        }

        const codePromise = submitCode(selectedBotId, messageId, code);

        showMessageResult(codePromise);
    }

    // Settles when the server answered, so the form can show that the key is being checked.
    function handleSubmitSecret(messageId: string, value: string): Promise<void> {
        if (selectedBotId === undefined) {
            return Promise.resolve();
        }

        const secretPromise = submitSecret(selectedBotId, messageId, value);

        showMessageResult(secretPromise);

        return secretPromise.then(() => undefined, () => undefined);
    }

    const selectedBot = bots.find(bot => bot.id === selectedBotId);
    const visibleMessages = messages.filter(message => message.botId === selectedBotId);
    const isRunning = selectedBotId !== undefined && runningBotId === selectedBotId;
    const selectedPaging = selectedBotId === undefined ? undefined : olderPaging[selectedBotId];
    const hasOlderMessages = selectedPaging?.hasMore === true;
    const isLoadingOlder = selectedPaging?.isLoading === true;

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
                    hasOlderMessages={hasOlderMessages}
                    isLoadingOlder={isLoadingOlder}
                    onLoadOlder={handleLoadOlder}
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
