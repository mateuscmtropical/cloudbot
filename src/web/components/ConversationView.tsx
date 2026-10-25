import { Suspense, createElement, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import type { BotSummary, ChatMessage, ChatPersonCredentialsEvent, ChatWebhookUrlEvent } from '../../shared/chatTypes.ts';
import { nextTap } from '../doubleTap.ts';
import type { Tap } from '../doubleTap.ts';
import { findHandoffSender } from '../botHandoff.ts';
import { renderMarkdown } from '../markdown.ts';
import type { MascotState } from '../mascotState.ts';
import { countProviderChanges } from '../providerChanges.ts';
import { sentMessageTexts } from '../sentHistory.ts';
import { BUBBLE_DELAY_MS, isThinkingBubbleShown } from '../thinkingBubble.ts';
import { useDelayedFlag } from '../useDelayedFlag.ts';
import { CloudMascot } from './CloudMascot.tsx';
import { Composer } from './Composer.tsx';
import type { DraftAttachment } from './Composer.tsx';
import { MessageItem } from './MessageItem.tsx';
import { PopoverMenu } from './PopoverMenu.tsx';
import { ProviderPicker } from './ProviderPicker.tsx';
import { RoundButton } from './RoundButton.tsx';
import { RenameField } from './RenameField.tsx';
import { ThinkingBubble } from './ThinkingBubble.tsx';
import { WebhookUrlNotice } from './WebhookUrlNotice.tsx';
import { PersonCredentialsNotice } from './PersonCredentialsNotice.tsx';
import { BackIcon, CodeIcon, MoreIcon } from './icons.tsx';
import type { MessageActions } from './MessageItem.tsx';
import { useBackButton } from '../useBackButton.ts';

// Within this many pixels of the top, the view asks for the page of older messages.
const LOAD_OLDER_THRESHOLD_PX = 40;
// Within this many pixels of the bottom, new messages keep the view at the bottom.
const NEAR_BOTTOM_PX = 40;

// Loaded on first use, because noVNC is large and only needed when the owner opens the screen.
const lazyDesktopPanel = lazy(async () => {
    const panelModule = await import('./DesktopPanel.tsx');

    return { default: panelModule.DesktopPanel };
});

interface ConversationViewProps {
    bot: BotSummary | undefined;
    // All the bots, to show the mascot of the bot that sent a hand-off.
    bots?: BotSummary[] | undefined;
    // The face of the bot's mascot while it is the live bot. Idle when not given.
    mascotState?: MascotState | undefined;
    messages: ChatMessage[];
    draftText: string;
    isRunning: boolean;
    // The tool the bot is using now, named in the thinking bubble. Unset when no tool runs.
    activeToolName?: string | undefined;
    onTypingChange?: ((isTyping: boolean) => void) | undefined;
    attachments: DraftAttachment[];
    isUploading: boolean;
    onRemoveAttachment: (attachmentId: string) => void;
    actions: MessageActions;
    hasOlderMessages?: boolean;
    isLoadingOlder?: boolean;
    onLoadOlder?: () => void;
    onOpenBotList: () => void;
    // Opens this bot's profile.
    onOpenProfile?: (() => void) | undefined;
    // Opens the chat of the bot that holds a provider sign-in. Without it the header shows no provider picker.
    onOpenSetupChat?: ((setupBotId: string) => void) | undefined;
    // Saves a new name for the bot, after a double tap on its name. It answers why the name was refused, or nothing. Without it the name cannot be changed here.
    onRenameBot?: ((botId: string, name: string) => Promise<string | undefined>) | undefined;
    // Goes up each time the bot asks for the screen. The Screen panel opens then, so the owner sees the request at once.
    screenRequestId?: number | undefined;
    // The message a tapped notification was about. The view scrolls to it once the messages are there, and reports it handled.
    focusMessageId?: string | undefined;
    onFocusHandled?: (() => void) | undefined;
    onSend: (text: string) => void;
    onStop: () => void;
    onAttach: (files: File[]) => void;
    // Webhook URLs the bot just made for this bot. Each is shown until the owner hides it.
    webhookUrls?: ChatWebhookUrlEvent[] | undefined;
    onHideWebhookUrl?: (hidden: ChatWebhookUrlEvent) => void;
    personCredentials?: ChatPersonCredentialsEvent[] | undefined;
    onHidePersonCredentials?: (hidden: ChatPersonCredentialsEvent) => void;
}

// A message kept in place while older messages are added, and where it sat in the viewport.
interface OlderAnchor {
    messageId: string;
    offset: number;
}

function findMessageElement(messageListElement: HTMLElement, messageId: string): HTMLElement | undefined {
    const messageElements = messageListElement.querySelectorAll<HTMLElement>('[data-message-id]');

    return Array.from(messageElements)
        .find(element => element.dataset.messageId === messageId);
}

// The first message that is at least partly on screen, with its offset from the top of the viewport.
function topVisibleAnchor(messageListElement: HTMLElement): OlderAnchor | undefined {
    const messageElements = messageListElement.querySelectorAll<HTMLElement>('[data-message-id]');
    const topElement = Array.from(messageElements)
        .find(element => element.offsetTop + element.offsetHeight > messageListElement.scrollTop);
    const messageId = topElement?.dataset.messageId;

    if (topElement === undefined || messageId === undefined) {
        return undefined;
    }

    return { messageId, offset: topElement.offsetTop - messageListElement.scrollTop };
}

function ConversationView({
    bot,
    bots,
    mascotState = 'idle',
    messages,
    draftText,
    isRunning,
    activeToolName,
    onTypingChange,
    attachments,
    isUploading,
    onRemoveAttachment,
    actions,
    hasOlderMessages = false,
    isLoadingOlder = false,
    onLoadOlder,
    onOpenBotList,
    onOpenProfile,
    onOpenSetupChat,
    onRenameBot,
    screenRequestId,
    focusMessageId,
    onFocusHandled,
    onSend,
    onStop,
    onAttach,
    webhookUrls = [],
    onHideWebhookUrl,
    personCredentials = [],
    onHidePersonCredentials,
}: ConversationViewProps): ReactElement {
    const messageListRef = useRef<HTMLDivElement>(null);
    const previousBotIdRef = useRef<string | undefined>(undefined);
    const previousOldestSequenceRef = useRef<number | undefined>(undefined);
    const previousNewestSequenceRef = useRef<number | undefined>(undefined);
    // The list height after the last change this view handled. Used for the near-bottom check.
    const previousScrollHeightRef = useRef(0);
    const olderAnchorRef = useRef<OlderAnchor | undefined>(undefined);
    const previousIsLoadingRef = useRef(false);
    const botName = bot?.name ?? 'CloudBot';
    const sentHistory = useMemo(() => sentMessageTexts(messages), [messages]);
    const providerChangeCount = useMemo(() => countProviderChanges(messages), [messages]);
    const isBubbleDue = isThinkingBubbleShown({ isRunning, messages });
    const isThinkingShown = useDelayedFlag(isBubbleDue, BUBBLE_DELAY_MS);
    const [isDesktopOpen, setIsDesktopOpen] = useState(false);

    useBackButton(isDesktopOpen, () => {
        setIsDesktopOpen(false);
    });

    const [isRenaming, setIsRenaming] = useState(false);
    const lastNameTapRef = useRef<Tap | undefined>(undefined);
    const [shownBotId, setShownBotId] = useState(bot?.id);
    const [shownScreenRequestId, setShownScreenRequestId] = useState(screenRequestId);

    // React's pattern for state that follows a prop: reset it during render, not in an effect.
    if (shownBotId !== bot?.id) {
        setShownBotId(bot?.id);
        setIsRenaming(false);
    }

    // Each new request from the bot opens the Screen panel, even when the owner had closed it.
    if (shownScreenRequestId !== screenRequestId) {
        setShownScreenRequestId(screenRequestId);
        setIsDesktopOpen(true);
    }
    const botId = bot?.id;

    // Older messages are added above the ones on screen. The anchor message is kept at the same
    // place on screen, so growth below it in the same render cannot move the view. Without an anchor,
    // the near-bottom rule applies. A new bot, or a change at the bottom while the reader is near it,
    // scrolls to the bottom.
    // This effect is declared before the loading one, so it still sees the anchor when a page arrives.
    useLayoutEffect(() => {
        const messageListElement = messageListRef.current;

        if (messageListElement === null) {
            return;
        }

        const oldestSequence = messages[0]?.sequence;
        const previousOldestSequence = previousOldestSequenceRef.current;
        const isSameBot = previousBotIdRef.current === botId;
        const isOlderMessagesAdded = isSameBot
            && oldestSequence !== undefined
            && previousOldestSequence !== undefined
            && oldestSequence < previousOldestSequence;
        const distanceFromBottom = previousScrollHeightRef.current - messageListElement.scrollTop - messageListElement.clientHeight;
        const isNearBottom = distanceFromBottom <= NEAR_BOTTOM_PX;
        const anchor = olderAnchorRef.current;
        const anchoredElement = anchor === undefined ? undefined : findMessageElement(messageListElement, anchor.messageId);
        // A load that ends without older messages still removes the load button, which shifts the list.
        // That is restored from the anchor too.
        const isOlderLoadEnded = previousIsLoadingRef.current && !isLoadingOlder;
        const shouldRestoreAnchor = isOlderMessagesAdded || isOlderLoadEnded;

        if (shouldRestoreAnchor) {
            olderAnchorRef.current = undefined;
        }

        // Messages that arrive live rise into place. A loaded page does not. A stored reply takes the place of its
        // streamed draft, which already rose, so it stays still.
        const previousNewestSequence = previousNewestSequenceRef.current;

        if (isSameBot && !isOlderMessagesAdded && previousNewestSequence !== undefined) {
            messages
                .filter(message => message.sequence > previousNewestSequence)
                .filter(message => message.role !== 'assistant' || message.body.kind !== 'text')
                .forEach((message) => {
                    const element = findMessageElement(messageListElement, message.id);

                    element?.classList.add('is-entering');
                });
        }

        if (shouldRestoreAnchor && anchor !== undefined && anchoredElement !== undefined) {
            messageListElement.scrollTop = anchoredElement.offsetTop - anchor.offset;
        } else if (!isSameBot || isNearBottom) {
            messageListElement.scrollTop = messageListElement.scrollHeight;
        }

        previousBotIdRef.current = botId;
        previousOldestSequenceRef.current = oldestSequence;
        previousNewestSequenceRef.current = messages.at(-1)?.sequence;
        previousIsLoadingRef.current = isLoadingOlder;
        previousScrollHeightRef.current = messageListElement.scrollHeight;
        // The working bubble shows up after a delay, so its arrival scrolls the list too.
    }, [messages, draftText, botId, isLoadingOlder, isThinkingShown]);

    // Back on the app, after the screen was off or another app was open, the chat follows the newest message. The
    // reload that the event stream does then lands at the bottom too, since the list counts as near the bottom.
    useEffect(() => {
        const followNewest = (): void => {
            const messageListElement = messageListRef.current;

            if (document.visibilityState !== 'visible' || messageListElement === null) {
                return;
            }

            messageListElement.scrollTop = messageListElement.scrollHeight;
            previousScrollHeightRef.current = messageListElement.scrollHeight;
        };

        document.addEventListener('visibilitychange', followNewest);

        return () => {
            document.removeEventListener('visibilitychange', followNewest);
        };
    }, []);

    // A tapped notification names a message. It is scrolled into view once the list has messages, found or not,
    // so a message that is not in the newest page never scrolls the view later. This effect follows the bottom scroll above.
    useLayoutEffect(() => {
        const messageListElement = messageListRef.current;

        if (focusMessageId === undefined || messageListElement === null || messages.length === 0) {
            return;
        }

        const focusedElement = findMessageElement(messageListElement, focusMessageId);

        focusedElement?.scrollIntoView({ block: 'center' });
        onFocusHandled?.();
    }, [focusMessageId, messages, onFocusHandled]);

    // Anchors the message at the top of the screen when a load starts. Drops the anchor when no load runs.
    useLayoutEffect(() => {
        const messageListElement = messageListRef.current;

        olderAnchorRef.current = isLoadingOlder && messageListElement !== null
            ? topVisibleAnchor(messageListElement)
            : undefined;
    }, [isLoadingOlder]);

    function handleScroll(): void {
        const messageListElement = messageListRef.current;

        if (messageListElement === null) {
            return;
        }

        // While a page is pending, the reader may scroll. The anchor follows the reader.
        if (isLoadingOlder) {
            olderAnchorRef.current = topVisibleAnchor(messageListElement);

            return;
        }

        if (!hasOlderMessages) {
            return;
        }

        if (messageListElement.scrollTop <= LOAD_OLDER_THRESHOLD_PX) {
            onLoadOlder?.();
        }
    }

    return (
        <section className="conversation">
            <header className="conversation-header">
                <RoundButton label="Show bots" onClick={onOpenBotList}><BackIcon /></RoundButton>
                {isRenaming && bot !== undefined && onRenameBot !== undefined
                    ? (
                            <div className="bot-pill">
                                <CloudMascot color={bot.mascotColor} shape={bot.mascotShape} state={mascotState} size={28} />
                                <RenameField
                                    name={bot.name}
                                    label={`Name of ${bot.name}`}
                                    className="bot-pill-name"
                                    onSubmit={newName => onRenameBot(bot.id, newName)}
                                    onClose={() => {
                                        setIsRenaming(false);
                                    }}
                                />
                            </div>
                        )
                    : (
                            <button
                                type="button"
                                className="bot-pill"
                                data-working={isRunning ? 'true' : undefined}
                                aria-label="Open bot profile"
                                onClick={onOpenProfile}
                            >
                                {bot === undefined ? null : <CloudMascot color={bot.mascotColor} shape={bot.mascotShape} state={mascotState} size={28} />}
                                <span
                                    className="bot-pill-name"
                                    onPointerUp={(event) => {
                                        // A double tap on the name of the bot renames it.
                                        const result = nextTap(lastNameTapRef.current, bot?.id ?? '', event.timeStamp);

                                        lastNameTapRef.current = result.tap;

                                        if (result.isDouble && event.button === 0 && onRenameBot !== undefined && bot !== undefined) {
                                            setIsRenaming(true);
                                        }
                                    }}
                                >
                                    {botName}
                                </span>
                            </button>
                        )}
                <PopoverMenu label="Conversation options" triggerLabel="More options" triggerIcon={<MoreIcon />} placement="below-end">
                    {() => bot === undefined || onOpenSetupChat === undefined
                        ? null
                        : (
                                <div className="popover-provider-entry">
                                    <span className="popover-provider-label">
                                        <CodeIcon />
                                        <span>Model and provider</span>
                                    </span>
                                    <ProviderPicker botId={bot.id} changeCount={providerChangeCount} refreshCount={messages.length} onOpenSetupChat={onOpenSetupChat} />
                                </div>
                            )}
                </PopoverMenu>
            </header>
            {/* Notices and the Screen panel sit below the pill, so their title and Close stay clear of it. Empty when none show. */}
            <div className="conversation-top">
                {onHideWebhookUrl === undefined
                    ? null
                    : webhookUrls.map(notice => (
                            <WebhookUrlNotice
                                key={notice.url}
                                name={notice.name}
                                url={notice.url}
                                onHide={() => { onHideWebhookUrl(notice); }}
                            />
                        ))}
                {onHidePersonCredentials === undefined
                    ? null
                    : personCredentials.map(notice => (
                            <PersonCredentialsNotice
                                key={notice.name}
                                name={notice.name}
                                address={notice.address}
                                password={notice.password}
                                onHide={() => { onHidePersonCredentials(notice); }}
                            />
                        ))}
                {isDesktopOpen
                    ? (
                            <Suspense fallback={<p className="desktop-status">Loading the screen...</p>}>
                                {createElement(lazyDesktopPanel, {
                                    onClose: () => {
                                        setIsDesktopOpen(false);
                                    },
                                })}
                            </Suspense>
                        )
                    : null}
            </div>
            <div className="message-list" ref={messageListRef} onScroll={handleScroll}>
                {hasOlderMessages
                    ? (
                            <button type="button" className="load-older-button" disabled={isLoadingOlder} onClick={onLoadOlder}>
                                {isLoadingOlder ? 'Loading...' : 'Load older messages'}
                            </button>
                        )
                    : null}
                {messages.map(message => (
                    <div key={message.id} data-message-id={message.id}>
                        <MessageItem
                            message={message}
                            actions={actions}
                            handoffSender={findHandoffSender(bots ?? [], message)}
                        />
                    </div>
                ))}
                {draftText === ''
                    ? null
                    : (
                            <div className="message message-assistant is-draft">
                                <div className="bubble markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(draftText) }} />
                            </div>
                        )}
                {isThinkingShown && bot !== undefined
                    ? <ThinkingBubble activeToolName={activeToolName} mascotColor={bot.mascotColor} mascotShape={bot.mascotShape} />
                    : null}
            </div>
            <Composer
                botName={botName}
                isRunning={isRunning}
                attachments={attachments}
                isUploading={isUploading}
                onRemoveAttachment={onRemoveAttachment}
                onTypingChange={onTypingChange}
                sentHistory={sentHistory}
                onSend={onSend}
                onStop={onStop}
                onAttach={onAttach}
            />
        </section>
    );
}

export { ConversationView };
export type { ConversationViewProps };
