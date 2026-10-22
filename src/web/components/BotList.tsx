import type { ReactElement } from 'react';

import type { BotSummary } from '../../shared/chatTypes.ts';
import type { ChannelSummary } from '../../shared/channelTypes.ts';
import type { MascotState } from '../mascotState.ts';
import type { MascotHopPoint } from '../mascotHop.ts';
import { CloudMascot } from './CloudMascot.tsx';
import { PlusIcon } from './PlusIcon.tsx';

// Where the hop lands on the row, inside its rounded right end.
const ROW_EDGE_INSET = 24;

interface BotListProps {
    bots: BotSummary[];
    selectedBotId: string | undefined;
    // The face of the selected bot, which is the live one. The other bots show the idle face.
    selectedMascotState: MascotState;
    channels: ChannelSummary[];
    selectedChannelId: string | undefined;
    isOpen: boolean;
    onSelectBot: (botId: string, sourceMascot: HTMLElement | null, rowEdge: MascotHopPoint) => void;
    onSelectChannel: (channelId: string) => void;
    onNewBot: () => void;
    onConnectApps: () => void;
}

function BotList({ bots, selectedBotId, selectedMascotState, channels, selectedChannelId, isOpen, onSelectBot, onSelectChannel, onNewBot, onConnectApps }: BotListProps): ReactElement {
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
                <button type="button" className="icon-button" aria-label="New bot" onClick={onNewBot}>
                    <PlusIcon />
                </button>
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
                            onClick={(event) => {
                                const sourceMascot = event.currentTarget.querySelector<HTMLElement>('.cloud-mascot');
                                // The mascot hops along the row to its right edge, then down into the chat.
                                const rowRect = event.currentTarget.getBoundingClientRect();
                                const rowEdge: MascotHopPoint = { x: rowRect.right - ROW_EDGE_INSET, y: rowRect.top + rowRect.height / 2 };

                                onSelectBot(bot.id, sourceMascot, rowEdge);
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
                {channels.length === 0 ? null : <p className="channel-section-title">Channels</p>}
                {channels.map((channel) => {
                    const isSelected = channel.id === selectedChannelId;
                    const itemClassName = isSelected ? 'bot-item is-selected' : 'bot-item';
                    const memberNames = channel.members.map(member => (member.isManager ? `${member.name} (manager)` : member.name));
                    const rosterText = memberNames.join(', ');

                    return (
                        <button
                            key={channel.id}
                            type="button"
                            className={itemClassName}
                            aria-current={isSelected ? 'true' : undefined}
                            onClick={() => {
                                onSelectChannel(channel.id);
                            }}
                        >
                            <span className="bot-text">
                                <span className="bot-name">{channel.name}</span>
                                <span className="bot-preview">{rosterText}</span>
                            </span>
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
