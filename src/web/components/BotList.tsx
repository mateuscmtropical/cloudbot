import { useRef, useState } from 'react';
import type { ReactElement } from 'react';

import type { BotSummary } from '../../shared/chatTypes.ts';
import type { ChannelSummary } from '../../shared/channelTypes.ts';
import type { MascotState } from '../mascotState.ts';
import { nextTap } from '../doubleTap.ts';
import type { Tap } from '../doubleTap.ts';
import type { MascotHopPoint } from '../mascotHop.ts';
import { CloudMascot } from './CloudMascot.tsx';
import { PlusIcon } from './PlusIcon.tsx';
import { RenameField } from './RenameField.tsx';

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
    isPeopleAvailable: boolean;
    onSelectBot: (botId: string, sourceMascot: HTMLElement | null, rowEdge: MascotHopPoint) => void;
    onSelectChannel: (channelId: string) => void;
    onNewBot: () => void;
    onConnectApps: () => void;
    onPeople: () => void;
    // Saves a new name for a bot, after a double tap on its row. It answers why the name was refused, or nothing. Without it the rows cannot be renamed.
    onRenameBot?: ((botId: string, name: string) => Promise<string | undefined>) | undefined;
}

function BotList({ bots, selectedBotId, selectedMascotState, channels, selectedChannelId, isOpen, isPeopleAvailable, onSelectBot, onSelectChannel, onNewBot, onConnectApps, onPeople, onRenameBot }: BotListProps): ReactElement {
    const [renamingBotId, setRenamingBotId] = useState<string | undefined>(undefined);
    const lastTapRef = useRef<Tap | undefined>(undefined);
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
                {isPeopleAvailable
                    ? (
                            <button type="button" className="icon-button" aria-label="People" onClick={onPeople}>
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <circle cx="9" cy="8" r="3" />
                                    <path d="M3.5 19v-1.5a5.5 5.5 0 0 1 11 0V19z" />
                                    <path d="M16 5.5a3 3 0 0 1 0 5.8M17 14a5 5 0 0 1 3.5 4.8V19h-4" />
                                </svg>
                            </button>
                        )
                    : null}
                <button type="button" className="icon-button" aria-label="New bot" onClick={onNewBot}>
                    <PlusIcon />
                </button>
            </div>
            <div className="bot-items">
                {bots.map((bot) => {
                    const isSelected = bot.id === selectedBotId;
                    const itemClassName = isSelected ? 'bot-item is-selected' : 'bot-item';
                    const mascotState = isSelected ? selectedMascotState : 'idle';

                    if (renamingBotId === bot.id && onRenameBot !== undefined) {
                        return (
                            <div key={bot.id} className={`${itemClassName} is-renaming`}>
                                <CloudMascot color={bot.mascotColor} shape={bot.mascotShape} state={mascotState} size={40} />
                                <span className="bot-text">
                                    <RenameField
                                        name={bot.name}
                                        label={`Name of ${bot.name}`}
                                        onSubmit={newName => onRenameBot(bot.id, newName)}
                                        onClose={() => {
                                            setRenamingBotId(undefined);
                                        }}
                                    />
                                    <span className="bot-preview">{bot.lastMessagePreview}</span>
                                </span>
                            </div>
                        );
                    }

                    return (
                        <button
                            key={bot.id}
                            type="button"
                            className={itemClassName}
                            aria-current={isSelected ? 'true' : undefined}
                            onPointerUp={(event) => {
                                // A double tap on the row renames the bot. The first tap still selects it.
                                const result = nextTap(lastTapRef.current, bot.id, event.timeStamp);

                                lastTapRef.current = result.tap;

                                if (result.isDouble && event.button === 0 && onRenameBot !== undefined) {
                                    setRenamingBotId(bot.id);
                                }
                            }}
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
