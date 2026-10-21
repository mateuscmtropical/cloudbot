import { Suspense, createElement, lazy, useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import type { BotSummary, ChatMessage, ChatWebhookUrlEvent } from '../../shared/chatTypes.ts';
import { renderMarkdown } from '../markdown.ts';
import type { MascotState } from '../mascotState.ts';
import { MESSAGE_MASCOT_SIZE, showsMessageMascot } from '../messageMascot.ts';
import { CloudMascot } from './CloudMascot.tsx';
import { Composer } from './Composer.tsx';
import type { DraftAttachment } from './Composer.tsx';
import { MessageItem } from './MessageItem.tsx';
import { WebhookUrlNotice } from './WebhookUrlNotice.tsx';
import type { MessageActions } from './MessageItem.tsx';

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
    // The face of the bot's mascot while it is the live bot. Idle when not given.
    mascotState?: MascotState | undefined;
    messages: ChatMessage[];
    draftText: string;
    isRunning: boolean;
    onTypingChange?: ((isTyping: boolean) => void) | undefined;
    attachments: DraftAttachment[];
    isUploading: boolean;
    onRemoveAttachment: (attachmentId: string) => void;
    actions: MessageActions;
    hasOlderMessages?: boolean;
    isLoadingOlder?: boolean;
    onLoadOlder?: () => void;
    onOpenBotList: () => void;
    // Goes up each time the bot asks for the screen. The Screen panel opens then, so the owner sees the request at once.
    screenRequestId?: number | undefined;
    onSend: (text: string) => void;
    onStop: () => void;
    onAttach: (files: File[]) => void;
    // Webhook URLs the bot just made for this bot. Each is shown until the owner hides it.
    webhookUrls?: ChatWebhookUrlEvent[] | undefined;
    onHideWebhookUrl?: (hidden: ChatWebhookUrlEvent) => void;
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
    mascotState = 'idle',
    messages,
    draftText,
    isRunning,
    onTypingChange,
    attachments,
    isUploading,
    onRemoveAttachment,
    actions,
    hasOlderMessages = false,
    isLoadingOlder = false,
    onLoadOlder,
    onOpenBotList,
    screenRequestId,
    onSend,
    onStop,
    onAttach,
    webhookUrls = [],
    onHideWebhookUrl,
}: ConversationViewProps): ReactElement {
    const messageListRef = useRef<HTMLDivElement>(null);
    const previousBotIdRef = useRef<string | undefined>(undefined);
    const previousOldestSequenceRef = useRef<number | undefined>(undefined);
    // The list height after the last change this view handled. Used for the near-bottom check.
    const previousScrollHeightRef = useRef(0);
    const olderAnchorRef = useRef<OlderAnchor | undefined>(undefined);
    const previousIsLoadingRef = useRef(false);
    const botName = bot?.name ?? 'CloudBot';
    const [isDesktopOpen, setIsDesktopOpen] = useState(false);
    const [shownBotId, setShownBotId] = useState(bot?.id);
    const [shownScreenRequestId, setShownScreenRequestId] = useState(screenRequestId);

    // React's pattern for state that follows a prop: reset it during render, not in an effect.
    if (shownBotId !== bot?.id) {
        setShownBotId(bot?.id);
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

        if (shouldRestoreAnchor && anchor !== undefined && anchoredElement !== undefined) {
            messageListElement.scrollTop = anchoredElement.offsetTop - anchor.offset;
        } else if (!isSameBot || isNearBottom) {
            messageListElement.scrollTop = messageListElement.scrollHeight;
        }

        previousBotIdRef.current = botId;
        previousOldestSequenceRef.current = oldestSequence;
        previousIsLoadingRef.current = isLoadingOlder;
        previousScrollHeightRef.current = messageListElement.scrollHeight;
    }, [messages, draftText, botId, isLoadingOlder]);

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
                <button type="button" className="icon-button menu-button" aria-label="Show bots" onClick={onOpenBotList}>
                    &#9776;
                </button>
                <div className="bot-pill">
                    {bot === undefined ? null : <CloudMascot color={bot.mascotColor} shape={bot.mascotShape} state={mascotState} size={28} />}
                    <span className="bot-pill-name">{botName}</span>
                </div>
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
                {messages.map((message, index) => (
                    <div key={message.id} data-message-id={message.id}>
                        <MessageItem
                            message={message}
                            actions={actions}
                            mascot={message.role === 'assistant' ? bot : undefined}
                            isMascotShown={showsMessageMascot(messages, index, { isShown: draftText !== '', botId: bot?.id })}
                            mascotState={mascotState === 'typing' ? 'typing' : 'idle'}
                        />
                    </div>
                ))}
                {draftText === ''
                    ? null
                    : (
                            <div className="message message-assistant is-draft has-mascot">
                                {bot === undefined
                                    ? <span className="mascot-gap" style={{ width: MESSAGE_MASCOT_SIZE }} aria-hidden="true" />
                                    : <CloudMascot color={bot.mascotColor} shape={bot.mascotShape} state={mascotState === 'typing' ? 'typing' : 'idle'} size={MESSAGE_MASCOT_SIZE} />}
                                <div className="bubble markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(draftText) }} />
                            </div>
                        )}
            </div>
            <Composer
                botName={botName}
                isRunning={isRunning}
                attachments={attachments}
                isUploading={isUploading}
                onRemoveAttachment={onRemoveAttachment}
                onTypingChange={onTypingChange}
                onSend={onSend}
                onStop={onStop}
                onAttach={onAttach}
            />
        </section>
    );
}

export { ConversationView };
export type { ConversationViewProps };
