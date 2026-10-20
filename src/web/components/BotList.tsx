import type { ReactElement } from 'react';

import type { BotSummary } from '../../shared/chatTypes.ts';
import { pickAvatarTextColor } from '../pickAvatarTextColor.ts';

interface BotListProps {
    bots: BotSummary[];
    selectedBotId: string | undefined;
    isOpen: boolean;
    onSelectBot: (botId: string) => void;
}

function getInitial(name: string): string {
    const trimmedName = name.trim();

    return trimmedName.charAt(0)
        .toUpperCase();
}

function BotList({ bots, selectedBotId, isOpen, onSelectBot }: BotListProps): ReactElement {
    const className = isOpen ? 'bot-list is-open' : 'bot-list';

    return (
        <aside className={className} aria-label="Bots">
            <div className="bot-list-header">
                <button type="button" className="icon-button" aria-label="Search bots">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <circle cx="11" cy="11" r="6" />
                        <path d="M20 20l-4.5-4.5" />
                    </svg>
                </button>
                <button type="button" className="icon-button" aria-label="New bot">+</button>
            </div>
            <div className="bot-items">
                {bots.map((bot) => {
                    const isSelected = bot.id === selectedBotId;
                    const itemClassName = isSelected ? 'bot-item is-selected' : 'bot-item';
                    const avatarTextColor = pickAvatarTextColor(bot.avatarColor);

                    return (
                        <button
                            key={bot.id}
                            type="button"
                            className={itemClassName}
                            aria-current={isSelected ? 'true' : undefined}
                            onClick={() => {
                                onSelectBot(bot.id);
                            }}
                        >
                            <span className="avatar" style={{ backgroundColor: bot.avatarColor, color: avatarTextColor }}>
                                {getInitial(bot.name)}
                            </span>
                            <span className="bot-text">
                                <span className="bot-name">{bot.name}</span>
                                <span className="bot-preview">{bot.lastMessagePreview}</span>
                            </span>
                            {bot.hasUnread ? <span className="unread-dot" aria-label="Unread" /> : null}
                        </button>
                    );
                })}
            </div>
            <div className="bot-list-footer">
                <button type="button" className="connect-apps-button">Connect apps</button>
            </div>
        </aside>
    );
}

export { BotList };
export type { BotListProps };
