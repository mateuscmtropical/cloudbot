import type { ReactElement } from 'react';

import type { BotSummary } from '../../shared/chatTypes.ts';
import type { MascotState } from '../mascotState.ts';
import { CloudMascot } from './CloudMascot.tsx';

interface BotListProps {
    bots: BotSummary[];
    selectedBotId: string | undefined;
    // The face of the selected bot, which is the live one. The other bots show the idle face.
    selectedMascotState: MascotState;
    isOpen: boolean;
    onSelectBot: (botId: string) => void;
    onNewBot: () => void;
    onConnectApps: () => void;
}

function BotList({ bots, selectedBotId, selectedMascotState, isOpen, onSelectBot, onNewBot, onConnectApps }: BotListProps): ReactElement {
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
                <button type="button" className="icon-button new-bot-button" aria-label="New bot" onClick={onNewBot}>+</button>
            </div>
            <div className="bot-items">
                {bots.map((bot) => {
                    const isSelected = bot.id === selectedBotId;
                    const itemClassName = isSelected ? 'bot-item is-selected' : 'bot-item';
                    const mascotState = isSelected ? selectedMascotState : 'idle';

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
                            <CloudMascot color={bot.mascotColor} shape={bot.mascotShape} state={mascotState} size={40} />
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
                <button type="button" className="connect-apps-button" onClick={onConnectApps}>Connect apps</button>
            </div>
        </aside>
    );
}

export { BotList };
export type { BotListProps };
