import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import type { BotSummary, ChatEvent, ChatMessage, ChatPersonCredentialsEvent, ChatWebhookUrlEvent } from '../shared/chatTypes.ts';
import type { ChannelDetail, ChannelSummary } from '../shared/channelTypes.ts';
import { BotList } from './components/BotList.tsx';
import { ChannelView } from './components/ChannelView.tsx';
import type { MessageActions } from './components/MessageItem.tsx';
import { deriveMascotState } from './mascotState.ts';
import { findLatestMessageMascot, startMascotHop } from './mascotHop.ts';
import type { MascotHop, MascotHopPoint } from './mascotHop.ts';
import { ConnectAppsPanel } from './components/ConnectAppsPanel.tsx';
import type { DraftAttachment } from './components/Composer.tsx';
import { ConversationView } from './components/ConversationView.tsx';
import { createBot, getChannel, getScreenHolder, listBots, listChannels, listMessages, postChannelMessage, RequestFailedError, stopChannel, sendMessage, stopTurn, submitChoice, submitCode, submitSecret, subscribeToEvents, uploadAttachments, listUploads, removeUpload, renameBot } from './apiClient.ts';
import { mergeLoadedUploads } from './attachmentChips.ts';
import { applyTabIcon } from './tabIcon.ts';
import { MESSAGE_PAGE_SIZE, mergeMessages, removeMessages, upsertLiveMessage, upsertMessage } from './messageList.ts';
import { withoutToolRows } from './thinkingBubble.ts';
import { openSignInTab, settleSignInTab, SIGN_IN_TAB_WAIT_MS } from './signInTab.ts';
import type { SignInTab } from './signInTab.ts';
import { describePushResult, disablePushNotifications, enablePushNotifications, readNotificationTarget, useNotificationOpen } from './pushClient.ts';
import type { NotificationTarget } from './pushClient.ts';
import { DISABLE_NOTIFICATIONS_CHOICE_ID, ENABLE_NOTIFICATIONS_CHOICE_ID } from '../shared/pushTypes.ts';
import { ADD_PASSKEY_CHOICE_ID, REMOVE_PASSKEY_CHOICE_ID } from '../shared/passkeyTypes.ts';
import { addPasskey, describePasskeyResult, removePasskey } from './passkeyClient.ts';
import { SignInScreen } from './components/SignInScreen.tsx';
import { PeopleHubHint } from './components/PeopleHubHint.tsx';
import { PeoplePanel } from './components/PeoplePanel.tsx';
import { listPeople } from './peopleClient.ts';

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

interface FinishedTurn {
    botId: string;
}

// The tool a bot is using now. Only the thinking bubble reads it.
interface ActiveTool {
    botId: string;
    toolName: string;
}

interface MascotHopRequest {
    requestId: number;
    targetBotId: string;
    sourceMascot: HTMLElement;
    rowEdge: MascotHopPoint;
}

const emptyDraft: DraftState = { botId: '', text: '', afterSequence: 0 };
const emptyChatState: ChatState = { messages: [], olderPaging: {} };
const OLDER_ERROR_TEXT = 'Could not load older messages.';
// How long the done face shows after a turn ends, before the bot shows its normal face again.
const DONE_FACE_DURATION_MS = 2000;

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
    // A channel replaces the bot's conversation while it is selected. Only one of the two is shown.
    const [selectedChannelId, setSelectedChannelId] = useState<string | undefined>(undefined);
    const [channels, setChannels] = useState<ChannelSummary[]>([]);
    const [channelDetail, setChannelDetail] = useState<ChannelDetail | undefined>(undefined);
    const [chatState, setChatState] = useState<ChatState>(emptyChatState);
    const [draft, setDraft] = useState<DraftState>(emptyDraft);
    const [runningBotId, setRunningBotId] = useState<string | undefined>(undefined);
    // The bot whose turn is running, read by the turn event handler. The state above is for rendering.
    const runningBotIdRef = useRef<string | undefined>(undefined);
    // The bot the owner pressed Stop for. Its turn ending is not a finish, so it shows no done face.
    const stoppedBotIdRef = useRef<string | undefined>(undefined);
    // A turn that ended just now. It drives the done face for a moment, and each end is a new object.
    const [finishedTurn, setFinishedTurn] = useState<FinishedTurn | undefined>(undefined);
    // The tool a bot is using now. It clears when the bot writes a reply or the turn ends.
    const [activeTool, setActiveTool] = useState<ActiveTool | undefined>(undefined);
    // True while the composer has text. It drives the typing face of the live bot.
    const [isOwnerTyping, setIsOwnerTyping] = useState(false);
    // Webhook URLs the bot made, kept in memory only, each until the owner hides it.
    const [webhookUrls, setWebhookUrls] = useState<ChatWebhookUrlEvent[]>([]);
    // One-time person sign-in details stay in this page's memory until the owner hides them.
    const [personCredentials, setPersonCredentials] = useState<ChatPersonCredentialsEvent[]>([]);
    // Counts the screen requests of the bot on screen. Each new count opens the Screen panel.
    const [screenRequestId, setScreenRequestId] = useState(0);
    // The screen holder seen on the last check. The Screen panel opens only when it changes to the owner.
    const lastScreenHolderRef = useRef<string | undefined>(undefined);
    const [isBotListOpen, setIsBotListOpen] = useState(false);
    const [isPeopleAvailable, setIsPeopleAvailable] = useState(false);
    const [isPeopleOpen, setIsPeopleOpen] = useState(false);
    // The connected remote MCP servers panel, opened from the sidebar.
    const [isConnectAppsOpen, setIsConnectAppsOpen] = useState(false);
    const [errorText, setErrorText] = useState<string | undefined>(undefined);
    const [needsSignIn, setNeedsSignIn] = useState(false);
    // Chips per bot: files still uploading, and the files the server holds for the next message.
    const [attachmentsByBot, setAttachmentsByBot] = useState<Record<string, DraftAttachment[]>>({});
    // A reply arrived while the tab was hidden. The tab icon shows a dot until the owner looks at the tab again.
    const [hasUnreadReply, setHasUnreadReply] = useState(false);
    // The message a tapped notification was about. The conversation scrolls to it once, then clears it.
    const [focusMessageId, setFocusMessageId] = useState<string | undefined>(undefined);
    const [mascotHopRequest, setMascotHopRequest] = useState<MascotHopRequest | undefined>(undefined);
    const mascotHopRequestIdRef = useRef(0);
    const startedMascotHopRequestIdRef = useRef<number | undefined>(undefined);
    const mascotHopRef = useRef<MascotHop | undefined>(undefined);

    useEffect(() => {
        if (finishedTurn === undefined) {
            return undefined;
        }

        const timer = setTimeout(() => {
            setFinishedTurn(undefined);
        }, DONE_FACE_DURATION_MS);

        return () => {
            clearTimeout(timer);
        };
    }, [finishedTurn]);

    // The tab icon shows the thinking face while the open bot works, and a dot for its unread reply.
    // Only the open bot has a live stream, so other bots do not change the icon.
    useEffect(() => {
        applyTabIcon({ isWorking: runningBotId !== undefined, hasUnreadReply });
    }, [runningBotId, hasUnreadReply]);

    // Looking at the tab again clears the dot.
    useEffect(() => {
        function clearUnreadReply(): void {
            if (!document.hidden) {
                setHasUnreadReply(false);
            }
        }

        document.addEventListener('visibilitychange', clearUnreadReply);

        return () => {
            document.removeEventListener('visibilitychange', clearUnreadReply);
        };
    }, []);

    const messagesRef = useRef<ChatMessage[]>([]);
    const selectedBotIdRef = useRef<string | undefined>(undefined);
    // Checked before the state updates, so a fast second scroll cannot start a duplicate request.
    const olderLoadsInFlightRef = useRef(new Set<string>());
    const generationsRef = useRef<Record<string, number>>({});
    // Every pending-list request gets a number. A response older than the applied one is dropped.
    const listRequestCount = useRef(0);
    const appliedListRequest = useRef<Record<string, number>>({});

    // Ready chips only ever come from the server's list, so no local edit removes one.
    const loadPendingUploads = useCallback((botId: string): void => {
        listRequestCount.current += 1;
        const requestNumber = listRequestCount.current;

        listUploads(botId)
            .then((uploads) => {
                if (requestNumber < (appliedListRequest.current[botId] ?? 0)) {
                    return;
                }

                appliedListRequest.current[botId] = requestNumber;
                setAttachmentsByBot(previous => ({ ...previous, [botId]: mergeLoadedUploads(previous[botId] ?? [], uploads) }));
            })
            .catch(() => {
                setErrorText('Could not load the attached files.');
            });
    }, []);

    const messages = chatState.messages;
    const olderPaging = chatState.olderPaging;

    useLayoutEffect(() => {
        if (mascotHopRequest === undefined
            || mascotHopRequest.targetBotId !== selectedBotId
            || selectedChannelId !== undefined
            || startedMascotHopRequestIdRef.current === mascotHopRequest.requestId) {
            return;
        }

        const conversationElement = document.querySelector<HTMLElement>('.conversation');
        const targetMascot = conversationElement === null ? null : findLatestMessageMascot(conversationElement);

        if (targetMascot === null) {
            return;
        }

        startedMascotHopRequestIdRef.current = mascotHopRequest.requestId;
        mascotHopRef.current = startMascotHop(mascotHopRequest.sourceMascot, targetMascot, mascotHopRequest.rowEdge);
    }, [mascotHopRequest, messages, selectedBotId, selectedChannelId]);

    useEffect(() => () => {
        mascotHopRef.current?.cancel();
    }, []);

    // A layout effect, so the ref matches the committed list before any later event or response reads it.
    useLayoutEffect(() => {
        messagesRef.current = messages;
    }, [messages]);

    // The tab opened by a tap on a sign-in choice, waiting for its link.
    const signInTabRef = useRef<SignInTab | undefined>(undefined);

    useEffect(() => {
        const signInTab = signInTabRef.current;

        if (signInTab !== undefined && settleSignInTab(signInTab, messages)) {
            signInTabRef.current = undefined;
        }
    }, [messages]);

    useEffect(() => {
        selectedBotIdRef.current = selectedBotId;
    }, [selectedBotId]);

    useEffect(() => {
        listBots()
            .then((loadedBots) => {
                // A notification that opened a new window names its bot in the address.
                const target = readNotificationTarget(window.location.search);
                const targetBot = loadedBots.find(bot => bot.id === target?.botId);

                setBots(loadedBots);
                setSelectedBotId(targetBot?.id ?? loadedBots[0]?.id);

                if (targetBot !== undefined) {
                    setFocusMessageId(target?.messageId);
                }
            })
            .catch((error: unknown) => {
                // Without a session the owner signs in first, with a passkey or the setup link.
                if (error instanceof RequestFailedError && error.status === 401) {
                    setNeedsSignIn(true);

                    return;
                }

                setErrorText('Could not load your bots.');
            });
    }, []);

    // The channel list follows the bot list, so a deleted bot's channels are dropped from the roster.
    useEffect(() => {
        listChannels()
            .then(setChannels)
            .catch(() => {
                setErrorText('Could not load the channels.');
            });
    }, [bots]);

    useEffect(() => {
        if (selectedChannelId === undefined) {
            return;
        }

        let isCurrent = true;

        getChannel(selectedChannelId)
            .then((detail) => {
                if (isCurrent) {
                    setChannelDetail(detail);
                }
            })
            .catch(() => {
                setErrorText('Could not load this channel.');
            });

        return () => {
            isCurrent = false;
        };
    }, [selectedChannelId]);

    // While a bot works on the channel, the view reloads so each reply shows as it is posted. It stops when the round ends.
    const isChannelRoundActive = channelDetail !== undefined && channelDetail.id === selectedChannelId && channelDetail.hasActiveRound;

    useEffect(() => {
        if (selectedChannelId === undefined || !isChannelRoundActive) {
            return;
        }

        const channelId = selectedChannelId;
        const CHANNEL_POLL_INTERVAL_MS = 2000;
        const timer = window.setInterval(() => {
            getChannel(channelId)
                .then((detail) => {
                    setChannelDetail(current => (current?.id === channelId ? detail : current));
                })
                .catch(() => {
                    setErrorText('Could not load this channel.');
                });
        }, CHANNEL_POLL_INTERVAL_MS);

        return () => {
            window.clearInterval(timer);
        };
    }, [selectedChannelId, isChannelRoundActive]);

    // The address names the open bot. The service worker reads it, so a tab that shows a bot gets no notification about it.
    // A tab that shows a channel shows no bot chat, so it names none.
    useEffect(() => {
        if (selectedBotId === undefined) {
            return;
        }

        const address = new URL(window.location.href);

        if (selectedChannelId === undefined) {
            address.searchParams.set('bot', selectedBotId);
        } else {
            address.searchParams.delete('bot');
        }

        address.searchParams.delete('message');
        window.history.replaceState(null, '', address);
    }, [selectedBotId, selectedChannelId]);

    useEffect(() => {
        if (selectedBotId === undefined) {
            return;
        }

        let isCurrent = true;
        // Deltas can arrive faster than the screen draws. They are joined and drawn once per frame,
        // so a fast stream does not render the whole chat for every few characters.
        let pendingDraftText = '';
        let pendingDraftBotId = '';
        let draftFrame: number | undefined;

        const cancelDraftFrame = (): void => {
            if (draftFrame !== undefined) {
                window.cancelAnimationFrame(draftFrame);
                draftFrame = undefined;
            }
        };

        const flushPendingDraft = (): void => {
            cancelDraftFrame();

            if (pendingDraftText === '') {
                return;
            }

            const deltaText = pendingDraftText;
            const deltaBotId = pendingDraftBotId;
            const knownSequences = messagesRef.current.map(message => message.sequence);
            const knownSequence = Math.max(0, ...knownSequences);

            pendingDraftText = '';
            setDraft((previousDraft) => {
                const isNewDraft = previousDraft.botId !== deltaBotId;

                return {
                    botId: deltaBotId,
                    text: (isNewDraft ? '' : previousDraft.text) + deltaText,
                    afterSequence: isNewDraft ? knownSequence : previousDraft.afterSequence,
                };
            });
        };

        // A stored message or a turn change ends the block. Its buffered text is part of that block, so it goes too.
        const dropPendingDraft = (): void => {
            cancelDraftFrame();
            pendingDraftText = '';
        };

        // Files waiting for the next message come back on connect and after every change to them.
        loadPendingUploads(selectedBotId);

        // Runs on every stream connect, so messages missed during a dropout come back.
        const reloadMessages = (): void => {
            // The screen may be with the owner already, after a reload or a dropout. The panel opens only when the
            // holder changes to the owner, so reconnects and bot switches do not reopen a panel the owner closed.
            getScreenHolder()
                .then((holder) => {
                    const wasWithOwner = lastScreenHolderRef.current === 'person';

                    lastScreenHolderRef.current = holder;

                    if (isCurrent && holder === 'person' && !wasWithOwner) {
                        setScreenRequestId(current => current + 1);
                    }
                })
                .catch(() => undefined);

            const generation = nextGeneration(generationsRef.current, selectedBotId);

            listMessages(selectedBotId, { limit: MESSAGE_PAGE_SIZE })
                .then((loadedMessages) => {
                    // A newer reload started after this one, so this answer may be older than the list.
                    const isOutOfDate = currentGeneration(generationsRef.current, selectedBotId) !== generation;

                    if (!isCurrent || isOutOfDate) {
                        return;
                    }

                    const replies = loadedMessages.filter(message => message.role === 'assistant' && message.body.kind === 'text');

                    // The check below must see every delta that came before this answer.
                    flushPendingDraft();

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
                if (pendingDraftText !== '' && pendingDraftBotId !== event.botId) {
                    flushPendingDraft();
                }

                pendingDraftBotId = event.botId;
                pendingDraftText += event.text;
                draftFrame ??= window.requestAnimationFrame(() => {
                    draftFrame = undefined;
                    flushPendingDraft();
                });

                return;
            }

            if (event.type === 'webhookUrl') {
                // A list, so a second webhook made in the same turn does not hide the first URL.
                setWebhookUrls(current => [...current, event]);

                return;
            }

            if (event.type === 'personCredentials') {
                setPersonCredentials(current => [...current.filter(notice => notice.name !== event.name), event]);

                return;
            }

            // The bot asked for the screen, so the Screen panel opens for the owner.
            if (event.type === 'screen') {
                setScreenRequestId(current => current + 1);

                return;
            }

            // The bot deleted itself. Its row is gone already, so the list that comes back is the right one.
            if (event.type === 'botDeleted') {
                listBots()
                    .then((loadedBots) => {
                        setBots(loadedBots);

                        if (!loadedBots.some(bot => bot.id === selectedBotIdRef.current)) {
                            setSelectedBotId(loadedBots[0]?.id);
                        }
                    })
                    .catch(() => {
                        setErrorText('Could not load your bots.');
                    });

                return;
            }

            // A tool has started. Its row is stored only when it finishes, so the bubble is the only sign until then.
            if (event.type === 'toolStarted') {
                setActiveTool({ botId: event.botId, toolName: event.toolName });

                return;
            }

            // A check-in found nothing for the owner, so the server deleted its messages.
            if (event.type === 'messagesRemoved') {
                setChatState(previousState => ({
                    ...previousState,
                    messages: removeMessages(previousState.messages, event.messageIds),
                }));

                return;
            }

            // A stored message ends the block being written, so its draft goes away.
            if (event.type === 'message') {
                dropPendingDraft();
                setDraft(emptyDraft);

                setActiveTool(current => (current?.botId === event.message.botId ? undefined : current));

                setChatState(previousState => ({
                    ...previousState,
                    messages: upsertLiveMessage(previousState.messages, event.message),
                }));

                // A reply that arrives while the tab is in the background marks the tab icon until the owner looks.
                if (event.message.role === 'assistant' && event.message.body.kind !== 'toolActivity' && document.hidden) {
                    setHasUnreadReply(true);
                }

                return;
            }

            dropPendingDraft();
            setDraft(emptyDraft);
            setActiveTool(current => (current?.botId === event.botId ? undefined : current));
            const wasRunning = runningBotIdRef.current === event.botId;
            const wasStopped = stoppedBotIdRef.current === event.botId;

            runningBotIdRef.current = event.isRunning ? event.botId : undefined;
            setRunningBotId(event.isRunning ? event.botId : undefined);

            if (!event.isRunning) {
                stoppedBotIdRef.current = undefined;
            }

            // Only a turn that was running and has now ended gets the done face. A status on connect does not.
            // A turn the owner stopped gets none either.
            if (!event.isRunning && wasRunning && !wasStopped) {
                setFinishedTurn({ botId: event.botId });
            }

            // A finished turn may have put files back in the queue, and may have renamed the bot.
            if (!event.isRunning) {
                loadPendingUploads(selectedBotId);

                listBots()
                    .then((loadedBots) => {
                        setBots(loadedBots);

                        // The bot may have deleted itself in this turn. Then the selection moves to the first bot left.
                        const isSelectedGone = !loadedBots.some(bot => bot.id === selectedBotIdRef.current);

                        if (isSelectedGone) {
                            setSelectedBotId(loadedBots[0]?.id);
                        }
                    })
                    .catch(() => {
                        setErrorText('Could not load your bots.');
                    });
            }
        }, reloadMessages);

        return () => {
            isCurrent = false;
            // The waiting text belongs to the bot that is left, so it is written to its draft and not lost.
            flushPendingDraft();
            unsubscribe();
        };
    }, [selectedBotId, loadPendingUploads]);

    const showMessageResult = useCallback((resultPromise: Promise<ChatMessage>): void => {
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
    }, []);

    useEffect(() => {
        let isCurrent = true;

        listPeople()
            .then(() => {
                if (isCurrent) {
                    setIsPeopleAvailable(true);
                }
            })
            .catch(() => {
                if (isCurrent) {
                    setIsPeopleAvailable(false);
                }
            });

        return () => {
            isCurrent = false;
        };
    }, []);

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

    function handleSelectBot(
        botId: string,
        sourceMascot: HTMLElement | null = null,
        rowEdge?: MascotHopPoint,
    ): void {
        mascotHopRef.current?.cancel();
        mascotHopRef.current = undefined;
        setMascotHopRequest(undefined);

        if ((botId !== selectedBotId || selectedChannelId !== undefined)
            && sourceMascot !== null
            && rowEdge !== undefined) {
            mascotHopRequestIdRef.current += 1;
            const requestId = mascotHopRequestIdRef.current;
            const pendingHop: MascotHopRequest = { requestId, targetBotId: botId, sourceMascot, rowEdge };

            setMascotHopRequest(pendingHop);
        }

        // The older-load error belongs to the bot it was for, so another bot starts clean.
        setErrorText(previousError => (previousError === OLDER_ERROR_TEXT ? undefined : previousError));
        setSelectedChannelId(undefined);
        setSelectedBotId(botId);
        setIsPeopleOpen(false);
        setIsBotListOpen(false);
    }

    // The new name shows in the list and in the header at once. A refusal comes back as text for the field to show.
    function handleRenameBot(botId: string, name: string): Promise<string | undefined> {
        return renameBot(botId, name)
            .then((renamed) => {
                setBots(previousBots => previousBots.map(bot => (bot.id === renamed.id ? { ...bot, name: renamed.name } : bot)));

                return undefined;
            })
            .catch((error: unknown) => {
                const serverMessage = error instanceof RequestFailedError ? error.serverMessage : undefined;

                return serverMessage ?? 'The name could not be changed.';
            });
    }

    function handleSelectChannel(channelId: string): void {
        mascotHopRef.current?.cancel();
        mascotHopRef.current = undefined;
        setMascotHopRequest(undefined);
        setChannelDetail(undefined);
        setSelectedChannelId(channelId);
        setIsPeopleOpen(false);
        setIsBotListOpen(false);
    }

    // The owner's post is stored in the channel. The view reloads so the post shows with its stored author.
    function handlePostToChannel(text: string): void {
        if (selectedChannelId === undefined) {
            return;
        }

        const channelId = selectedChannelId;

        postChannelMessage(channelId, text)
            .then(() => getChannel(channelId))
            .then((detail) => {
                setChannelDetail(current => (current?.id === channelId ? detail : current));
            })
            .catch(() => {
                setErrorText('Could not post to the channel.');
            });
    }

    // Stop ends the whole round of the channel. The view reloads so the stop note and the dropped replies show.
    function handleStopChannel(): void {
        if (selectedChannelId === undefined) {
            return;
        }

        const channelId = selectedChannelId;

        stopChannel(channelId)
            .then(() => getChannel(channelId))
            .then((detail) => {
                setChannelDetail(current => (current?.id === channelId ? detail : current));
            })
            .catch(() => {
                setErrorText('Could not stop the channel.');
            });
    }

    // The new bot's chat opens at once. Its question about its name and job is the first message there.
    function handleNewBot(): void {
        createBot()
            .then((newBot) => {
                setBots(previousBots => [...previousBots, newBot]);
                handleSelectBot(newBot.id);
            })
            .catch(() => {
                setErrorText('Could not create a bot.');
            });
    }

    // A tapped notification brings the app to the front, and the service worker says which bot and message to show.
    function handleNotificationOpen(target: NotificationTarget): void {
        if (!bots.some(bot => bot.id === target.botId)) {
            return;
        }

        handleSelectBot(target.botId);
        setFocusMessageId(target.messageId);
    }

    useNotificationOpen(handleNotificationOpen);

    const nextAttachmentNumber = useRef(0);

    function updateAttachments(botId: string, update: (chips: DraftAttachment[]) => DraftAttachment[]): void {
        setAttachmentsByBot(previous => ({ ...previous, [botId]: update(previous[botId] ?? []) }));
    }

    function handleSend(text: string): void {
        if (selectedBotId === undefined) {
            return;
        }

        const sentBotId = selectedBotId;
        const wasRunning = runningBotId === sentBotId;

        setRunningBotId(sentBotId);
        const sendPromise = sendMessage(sentBotId, text);

        // The server empties its queue when it accepts the message. The list after that shows it.
        sendPromise.then(() => {
            loadPendingUploads(sentBotId);
        }, () => undefined);

        // A failed send never starts a turn. It clears the running state only when no turn ran before it.
        sendPromise.catch(() => {
            if (!wasRunning) {
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

        stoppedBotIdRef.current = selectedBotId;

        const stopPromise = stopTurn(selectedBotId);

        stopPromise.catch(() => {
            stoppedBotIdRef.current = undefined;
            setErrorText('Could not stop the bot.');
        });
    }

    function handleAttach(files: File[]): void {
        if (selectedBotId === undefined || files.length === 0) {
            return;
        }

        const botId = selectedBotId;
        const newChips = files.map((file) => {
            nextAttachmentNumber.current += 1;

            return { id: `upload-${String(nextAttachmentNumber.current)}`, name: file.name, status: 'uploading' as const };
        });
        const newIds = newChips.map(chip => chip.id);

        updateAttachments(botId, chips => [...chips, ...newChips]);

        const uploadPromise = uploadAttachments(botId, files);

        uploadPromise.then(() => {
            updateAttachments(botId, chips => chips.filter(chip => !newIds.includes(chip.id)));
            loadPendingUploads(botId);
        }, (error: unknown) => {
            updateAttachments(botId, chips => chips.filter(chip => !newIds.includes(chip.id)));

            // The server says why it refused the files, such as the size or the file count.
            const serverMessage = error instanceof RequestFailedError ? error.serverMessage : undefined;

            setErrorText(serverMessage ?? 'Could not upload the files.');
            // A lost response can hide files the server did queue, so the server list decides.
            loadPendingUploads(botId);
        });
    }

    function handleRemoveAttachment(attachmentId: string): void {
        if (selectedBotId === undefined) {
            return;
        }

        const botId = selectedBotId;
        const removePromise = removeUpload(botId, attachmentId);

        removePromise.then(() => {
            loadPendingUploads(botId);
        }, () => {
            setErrorText('Could not remove the file.');
            loadPendingUploads(botId);
        });
    }

    // One object per bot, so the memoized messages do not render again on every streamed delta.
    const messageActions = useMemo((): MessageActions => ({
        onChoose: (messageId, choiceId) => {
            if (selectedBotId === undefined) {
                return Promise.resolve();
            }

            const card = messagesRef.current.find(message => message.id === messageId);
            const isNotificationTap = card?.body.kind === 'choice' && card.body.isNotificationOptIn === true && choiceId === ENABLE_NOTIFICATIONS_CHOICE_ID;

            const isNotificationOffTap = card?.body.kind === 'choice' && card.body.isNotificationOptOut === true && choiceId === DISABLE_NOTIFICATIONS_CHOICE_ID;

            if (isNotificationOffTap) {
                // This browser forgets its subscription first. The card closes only when that worked.
                const botId = selectedBotId;
                const disablePromise = disablePushNotifications();

                return disablePromise
                    .then(() => {
                        setErrorText(undefined);
                        const choicePromise = submitChoice(botId, messageId, choiceId);

                        showMessageResult(choicePromise);

                        return undefined;
                    })
                    .catch((error: unknown) => {
                        const serverMessage = error instanceof RequestFailedError ? error.serverMessage : undefined;

                        setErrorText(serverMessage ?? 'Could not turn off notifications. Try again.');
                    });
            }

            if (isNotificationTap) {
                // The browser asks for permission only inside the tap, so this starts now. The card closes only when it worked.
                const botId = selectedBotId;
                const enablePromise = enablePushNotifications();

                return enablePromise
                    .then((result) => {
                        if (result !== 'enabled') {
                            const problemText = describePushResult(result);

                            setErrorText(problemText);

                            return undefined;
                        }

                        setErrorText(undefined);
                        const choicePromise = submitChoice(botId, messageId, choiceId);

                        showMessageResult(choicePromise);

                        return undefined;
                    })
                    .catch((error: unknown) => {
                        const serverMessage = error instanceof RequestFailedError ? error.serverMessage : undefined;

                        setErrorText(serverMessage ?? 'Could not turn on notifications. Try again.');
                    });
            }

            const isPasskeyAddTap = card?.body.kind === 'choice' && card.body.isPasskeyAdd === true && choiceId === ADD_PASSKEY_CHOICE_ID;
            const removedPasskeyId = card?.body.kind === 'choice' && choiceId === REMOVE_PASSKEY_CHOICE_ID ? card.body.removesPasskeyId : undefined;

            if (isPasskeyAddTap || removedPasskeyId !== undefined) {
                // The browser makes or removes the passkey inside the tap. The card closes only when that worked.
                const botId = selectedBotId;
                const actionPromise = removedPasskeyId === undefined
                    ? addPasskey()
                    : removePasskey(removedPasskeyId)
                            .then(isRemoved => (isRemoved ? 'done' as const : 'failed' as const), () => 'failed' as const);

                return actionPromise.then((result) => {
                    if (result !== 'done') {
                        const problemText = describePasskeyResult(result);

                        setErrorText(problemText);

                        return;
                    }

                    setErrorText(undefined);
                    const choicePromise = submitChoice(botId, messageId, choiceId);

                    showMessageResult(choicePromise);
                });
            }

            const option = card?.body.kind === 'choice' ? card.body.options.find(choice => choice.id === choiceId) : undefined;

            if (option?.opensLink === true) {
                const lastSequence = messagesRef.current.at(-1)?.sequence ?? 0;
                const signInTab = openSignInTab(lastSequence);

                signInTabRef.current?.tab.close();
                signInTabRef.current = signInTab;
                setTimeout(() => {
                    if (signInTabRef.current === signInTab) {
                        signInTab?.tab.close();
                        signInTabRef.current = undefined;
                    }
                }, SIGN_IN_TAB_WAIT_MS);
            }

            const choicePromise = submitChoice(selectedBotId, messageId, choiceId);

            showMessageResult(choicePromise);

            return choicePromise.then(() => undefined, () => undefined);
        },
        onSubmitCode: (messageId, code) => {
            if (selectedBotId === undefined) {
                return;
            }

            const codePromise = submitCode(selectedBotId, messageId, code);

            showMessageResult(codePromise);
        },
        // Settles when the server answered, so the form can show that the key is being checked.
        onSubmitSecret: (messageId, value) => {
            if (selectedBotId === undefined) {
                return Promise.resolve();
            }

            const secretPromise = submitSecret(selectedBotId, messageId, value);

            showMessageResult(secretPromise);

            return secretPromise.then(() => undefined, () => undefined);
        },
        onOpenScreen: () => {
            setScreenRequestId(current => current + 1);
        },
    }), [selectedBotId, showMessageResult]);

    const selectedBot = bots.find(bot => bot.id === selectedBotId);
    const selectedMessages = messages.filter(message => message.botId === selectedBotId);
    const visibleMessages = withoutToolRows(selectedMessages);
    const activeToolName = activeTool?.botId === selectedBotId ? activeTool?.toolName : undefined;
    const isRunning = selectedBotId !== undefined && runningBotId === selectedBotId;
    const isJustFinished = selectedBotId !== undefined && finishedTurn?.botId === selectedBotId;
    const liveMascotState = deriveMascotState({ isRunning, isOwnerTyping, isJustFinished, messages: visibleMessages });
    const selectedPaging = selectedBotId === undefined ? undefined : olderPaging[selectedBotId];
    const hasOlderMessages = selectedPaging?.hasMore === true;
    const isLoadingOlder = selectedPaging?.isLoading === true;

    const botAttachments = selectedBotId === undefined ? [] : (attachmentsByBot[selectedBotId] ?? []);
    const isUploading = botAttachments.some(attachment => attachment.status === 'uploading');
    const botWebhookUrls = webhookUrls.filter(notice => notice.botId === selectedBotId);
    const botPersonCredentials = personCredentials.filter(notice => notice.botId === selectedBotId);

    if (needsSignIn) {
        return <SignInScreen />;
    }

    return (
        <div className="app">
            <BotList
                bots={bots}
                selectedBotId={selectedBotId}
                selectedMascotState={liveMascotState}
                channels={channels}
                selectedChannelId={selectedChannelId}
                isOpen={isBotListOpen}
                onSelectBot={handleSelectBot}
                onSelectChannel={handleSelectChannel}
                onNewBot={handleNewBot}
                onRenameBot={handleRenameBot}
                onConnectApps={() => {
                    setIsPeopleOpen(false);
                    setIsConnectAppsOpen(true);
                }}
                onPeople={() => {
                    setIsConnectAppsOpen(false);
                    setIsPeopleOpen(true);
                }}
            />
            {isConnectAppsOpen
                ? (
                        <ConnectAppsPanel
                            onClose={() => {
                                setIsConnectAppsOpen(false);
                            }}
                        />
                    )
                : null}
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
                {isPeopleOpen && isPeopleAvailable
                    ? (
                            <PeoplePanel
                                onClose={() => {
                                    setIsPeopleOpen(false);
                                }}
                            />
                        )
                    : null}
                {isPeopleOpen && !isPeopleAvailable
                    ? (
                            <PeopleHubHint
                                onClose={() => {
                                    setIsPeopleOpen(false);
                                }}
                            />
                        )
                    : null}
                {!isPeopleOpen && selectedChannelId !== undefined
                    ? (
                            <ChannelView
                                channel={channelDetail?.id === selectedChannelId ? channelDetail : undefined}
                                onPost={handlePostToChannel}
                                onStop={handleStopChannel}
                                onOpenBotList={() => {
                                    setIsBotListOpen(true);
                                }}
                            />
                        )
                    : null}
                {!isPeopleOpen && selectedChannelId === undefined
                    ? (
                            <ConversationView
                                bot={selectedBot}
                                bots={bots}
                                mascotState={liveMascotState}
                                onTypingChange={setIsOwnerTyping}
                                messages={visibleMessages}
                                draftText={draft.botId === selectedBotId ? draft.text : ''}
                                isRunning={isRunning}
                                activeToolName={activeToolName}
                                attachments={botAttachments}
                                isUploading={isUploading}
                                onRemoveAttachment={handleRemoveAttachment}
                                actions={messageActions}
                                hasOlderMessages={hasOlderMessages}
                                isLoadingOlder={isLoadingOlder}
                                onLoadOlder={handleLoadOlder}
                                onOpenBotList={() => {
                                    setIsBotListOpen(true);
                                }}
                                onRenameBot={handleRenameBot}
                                onOpenSetupChat={(setupBotId) => {
                                    handleSelectBot(setupBotId);
                                }}
                                screenRequestId={screenRequestId}
                                focusMessageId={focusMessageId}
                                onFocusHandled={() => {
                                    setFocusMessageId(undefined);
                                }}
                                webhookUrls={botWebhookUrls}
                                onHideWebhookUrl={(hidden) => {
                                    setWebhookUrls(current => current.filter(notice => notice !== hidden));
                                }}
                                personCredentials={botPersonCredentials}
                                onHidePersonCredentials={(hidden) => {
                                    setPersonCredentials(current => current.filter(notice => notice !== hidden));
                                }}
                                onSend={handleSend}
                                onStop={handleStop}
                                onAttach={handleAttach}
                            />
                        )
                    : null}
            </main>
        </div>
    );
}

export { App };
