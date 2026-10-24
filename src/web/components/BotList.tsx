import { useRef, useState } from 'react';
import type { ReactElement } from 'react';

import type { BotSummary } from '../../shared/chatTypes.ts';
import type { ChannelSummary } from '../../shared/channelTypes.ts';
import type { MascotState } from '../mascotState.ts';
import { nextTap } from '../doubleTap.ts';
import type { Tap } from '../doubleTap.ts';
import type { MascotHopPoint } from '../mascotHop.ts';
import { AppsGridIcon, PeopleIcon, PlusIcon, SearchIcon } from './icons.tsx';
import { BotListItem } from './BotListItem.tsx';
import { CloudMascot } from './CloudMascot.tsx';
import { PillField } from './PillField.tsx';
import { RenameField } from './RenameField.tsx';
import { RoundButton } from './RoundButton.tsx';

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
    personName?: string | undefined;
    // Only a CloudBot inside a hub has an account to manage.
    onAccount?: (() => void) | undefined;
    onPeople: () => void;
    // Saves a new name for a bot, after a double tap on its row. It answers why the name was refused, or nothing. Without it the rows cannot be renamed.
    onRenameBot?: ((botId: string, name: string) => Promise<string | undefined>) | undefined;
}

function initialsFromName(name: string): string {
    const words = name.trim()
        .split(/\s+/)
        .filter(word => word.length > 0);
    const initialLetters = words.slice(0, 2)
        .map(word => Array.from(word)[0] ?? '');
    const initials = initialLetters
        .join('');

    return initials.toLocaleUpperCase();
}

function BotList({ bots, selectedBotId, selectedMascotState, channels, selectedChannelId, isOpen, onSelectBot, onSelectChannel, onNewBot, onConnectApps, personName, onAccount, onPeople, onRenameBot }: BotListProps): ReactElement {
    const [renamingBotId, setRenamingBotId] = useState<string | undefined>(undefined);
    const [searchValue, setSearchValue] = useState('');
    const lastTapRef = useRef<Tap | undefined>(undefined);
    const className = isOpen ? 'bot-list is-open' : 'bot-list';
    const initials = personName === undefined ? '' : initialsFromName(personName);
    const canOpenAccount = initials.length > 0 && onAccount !== undefined;
    const profileLabel = canOpenAccount ? 'Account' : 'People';
    const onOpenProfile = canOpenAccount ? onAccount : onPeople;
    const normalizedSearch = searchValue.trim()
        .toLocaleLowerCase();
    const visibleBots = bots.filter(bot => bot.name.toLocaleLowerCase()
        .includes(normalizedSearch));

    return (
        <aside className={className} aria-label="Bots">
            <div className="bot-list-header">
                <RoundButton label={profileLabel} tone={initials.length > 0 ? 'avatar' : 'default'} onClick={onOpenProfile}>
                    {initials.length > 0 ? initials : <PeopleIcon />}
                </RoundButton>
                <RoundButton label="New bot" onClick={onNewBot}><PlusIcon /></RoundButton>
            </div>
            <div className="bot-items">
                {visibleBots.map((bot) => {
                    const isSelected = bot.id === selectedBotId;
                    const selectedClassName = isSelected ? 'bot-item is-selected' : 'bot-item';
                    const itemClassName = bot.hasUnread ? `${selectedClassName} is-unread` : selectedClassName;
                    const mascotState = isSelected ? selectedMascotState : 'idle';

                    if (renamingBotId === bot.id && onRenameBot !== undefined) {
                        return (
                            <div key={bot.id} className={`${itemClassName} is-renaming`}>
                                <CloudMascot color={bot.mascotColor} shape={bot.mascotShape} state={mascotState} size={40} />
                                <span className="bot-text">
                                    <span className="bot-name-line">
                                        <RenameField
                                            name={bot.name}
                                            label={`Name of ${bot.name}`}
                                            onSubmit={newName => onRenameBot(bot.id, newName)}
                                            onClose={() => {
                                                setRenamingBotId(undefined);
                                            }}
                                        />
                                    </span>
                                    <span className="bot-preview">{bot.lastMessagePreview}</span>
                                </span>
                            </div>
                        );
                    }

                    return (
                        <BotListItem
                            key={bot.id}
                            bot={bot}
                            isSelected={isSelected}
                            mascotState={mascotState}
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
                        />
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
                <RoundButton label="Connect apps" onClick={onConnectApps}><AppsGridIcon /></RoundButton>
                <PillField leftIcon={<SearchIcon />} className="bot-list-search">
                    <input
                        type="search"
                        className="bot-list-search-input"
                        aria-label="Search bots"
                        placeholder="Search"
                        value={searchValue}
                        onChange={(event) => {
                            setSearchValue(event.currentTarget.value);
                        }}
                    />
                </PillField>
            </div>
        </aside>
    );
}

export { BotList };
export type { BotListProps };
