import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';

import type { BotSummary, ChatMessage } from '../../shared/chatTypes.ts';
import { Composer } from './Composer.tsx';
import { MessageItem } from './MessageItem.tsx';
import type { MessageActions } from './MessageItem.tsx';

interface ConversationViewProps {
    bot: BotSummary | undefined;
    messages: ChatMessage[];
    isRunning: boolean;
    actions: MessageActions;
    onOpenBotList: () => void;
    onSend: (text: string) => void;
    onStop: () => void;
    onAttach: (files: File[]) => void;
}

function ConversationView({
    bot,
    messages,
    isRunning,
    actions,
    onOpenBotList,
    onSend,
    onStop,
    onAttach,
}: ConversationViewProps): ReactElement {
    const messageListRef = useRef<HTMLDivElement>(null);
    const botName = bot?.name ?? 'CloudBot';

    useEffect(() => {
        const messageListElement = messageListRef.current;

        if (messageListElement !== null) {
            messageListElement.scrollTop = messageListElement.scrollHeight;
        }
    }, [messages]);

    return (
        <section className="conversation">
            <header className="conversation-header">
                <button type="button" className="icon-button menu-button" aria-label="Show bots" onClick={onOpenBotList}>
                    &#9776;
                </button>
                <span className="bot-pill">{botName}</span>
            </header>
            <div className="message-list" ref={messageListRef}>
                {messages.map(message => (
                    <MessageItem key={message.id} message={message} actions={actions} />
                ))}
            </div>
            <Composer
                botName={botName}
                isRunning={isRunning}
                onSend={onSend}
                onStop={onStop}
                onAttach={onAttach}
            />
        </section>
    );
}

export { ConversationView };
export type { ConversationViewProps };
